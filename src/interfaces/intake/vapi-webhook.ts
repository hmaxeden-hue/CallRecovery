/**
 * HTTP intake for Vapi end-of-call webhooks.
 *
 * Order of operations matters: read the raw body first (the HMAC is computed
 * over exactly those bytes), authenticate, then parse, then map, then hand the
 * internal event to the service. The route never touches domain logic itself.
 *
 * Status codes are chosen for how Vapi reacts to them:
 *   200  handled, ignored, skipped, duplicate  -> do not retry
 *   401  authentication failed                 -> do not retry
 *   400  malformed or unmappable payload       -> retrying cannot help
 *   503  we failed to notify anyone            -> please retry, we are idempotent
 */

import { Hono } from 'hono';

import type { AppConfig } from '../../config.js';
import type { RecoveryService } from '../../core/recovery-service.js';
import type { Logger } from '../../core/types.js';
import { silentLogger } from '../../core/types.js';
import { mapVapiWebhook } from './vapi-mapping.js';
import { verifyVapiRequest } from './vapi-signature.js';

export const VAPI_WEBHOOK_PATH = '/webhooks/vapi';

export type VapiWebhookDeps = {
  service: RecoveryService;
  config: AppConfig;
  logger?: Logger;
};

export function createVapiWebhookRoute(deps: VapiWebhookDeps): Hono {
  const logger = deps.logger ?? silentLogger;
  const route = new Hono();

  route.post('/', async (c) => {
    const rawBody = await c.req.text();

    const verification = verifyVapiRequest({
      rawBody,
      header: (name) => c.req.header(name),
      secret: deps.config.vapiWebhookSecret,
      mode: deps.config.vapiSignatureMode,
    });

    if (!verification.ok) {
      logger.warn('vapi webhook rejected', { reason: verification.reason });
      return c.json({ outcome: 'unauthorized' }, 401);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody);
    } catch {
      logger.warn('vapi webhook body is not valid JSON');
      return c.json({ outcome: 'invalid_json' }, 400);
    }

    const mapping = mapVapiWebhook(payload);

    if (mapping.status === 'ignored') {
      // Status updates, transcripts and friends. Acknowledge so Vapi stops.
      return c.json({ outcome: 'ignored', messageType: mapping.messageType }, 200);
    }

    if (mapping.status === 'invalid') {
      logger.warn('vapi webhook payload could not be mapped', { problems: mapping.problems });
      return c.json({ outcome: 'unmappable_payload', problems: mapping.problems }, 400);
    }

    try {
      // The HandleResult is returned verbatim; `outcome` is the single field
      // that names what happened. (An added `status` wrapper would collide with
      // the recovery status the duplicate case already carries.)
      const result = await deps.service.handle(mapping.event);

      if (result.outcome === 'send_failed') {
        // The recovery is stored and still pending — a retry will finish it.
        return c.json(result, 503);
      }

      // `send_rejected` deliberately answers 200: the customer is permanently
      // unreachable, so a Vapi retry would only repeat the failure. The owner
      // has been told to call back instead.

      return c.json(result, 200);
    } catch (error) {
      logger.error('vapi webhook handler failed', {
        callId: mapping.event.callId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ outcome: 'internal_error' }, 500);
    }
  });

  return route;
}
