/**
 * Route-level test through Hono's fetch handler — no socket, no port.
 * Uses the in-memory persistence and a recording messaging adapter, but the
 * real service, signature check and mapping.
 */

import { Hono } from 'hono';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AppConfig } from '../src/config.js';
import { RecoveryService } from '../src/core/recovery-service.js';
import {
  VAPI_WEBHOOK_PATH,
  createVapiWebhookRoute,
} from '../src/interfaces/intake/vapi-webhook.js';
import { END_OF_CALL_TYPE } from '../src/interfaces/intake/vapi-mapping.js';
import { SHARED_SECRET_HEADER } from '../src/interfaces/intake/vapi-signature.js';
import { InMemoryPersistence } from '../src/interfaces/persistence/in-memory-persistence.js';
import { RecordingMessaging } from './fakes/recording-messaging.js';

const SECRET = 'dev-secret';

const config: AppConfig = {
  vapiWebhookSecret: SECRET,
  vapiSignatureMode: 'shared_secret',
  whatsappProvider: 'stub',
  ownerPhone: '+41790000000',
  databasePath: ':memory:',
  port: 3000,
  timeZone: 'Europe/Zurich',
};

function body(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    message: {
      type: END_OF_CALL_TYPE,
      endedReason: 'customer-hung-up',
      startedAt: '2026-08-09T12:30:00.000Z',
      endedAt: '2026-08-09T12:32:00.000Z',
      customer: { number: '+41791234567' },
      phoneNumber: { number: '+41445556677' },
      call: { id: 'vapi-call-abc' },
      ...overrides,
    },
  });
}

describe('POST /webhooks/vapi', () => {
  let persistence: InMemoryPersistence;
  let messaging: RecordingMessaging;
  let http: Hono;

  function post(payload: string, headers: Record<string, string> = {}) {
    return http.request(VAPI_WEBHOOK_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: payload,
    });
  }

  function authorized(payload: string) {
    return post(payload, { [SHARED_SECRET_HEADER]: SECRET });
  }

  beforeEach(() => {
    persistence = new InMemoryPersistence(() => '2026-08-09T12:33:00.000Z');
    messaging = new RecordingMessaging();
    const ids = ['R-7F3K', 'R-9QB2'];

    const service = new RecoveryService({
      persistence,
      messaging,
      now: () => '2026-08-09T12:33:00.000Z',
      generateRecoveryId: () => ids.shift() ?? 'R-ZZZZ',
      ownerPhone: config.ownerPhone,
      timeZone: config.timeZone,
    });

    http = new Hono().route(VAPI_WEBHOOK_PATH, createVapiWebhookRoute({ service, config }));
  });

  it('creates a recovery and notifies both sides', async () => {
    const response = await authorized(body());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'notified',
      recoveryId: 'R-7F3K',
      reason: 'missed_call',
    });
    expect(messaging.customerMessages).toHaveLength(1);
    expect(messaging.ownerMessages).toHaveLength(1);
  });

  it('rejects a wrong or missing secret before touching the payload', async () => {
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), { [SHARED_SECRET_HEADER]: 'nope' })).status).toBe(401);
    expect(messaging.sent).toHaveLength(0);
    expect(persistence.listRecoveries()).toHaveLength(0);
  });

  it('answers 200 without sending anything on a Vapi retry', async () => {
    await authorized(body());
    const retry = await authorized(body());

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      outcome: 'duplicate',
      recoveryId: 'R-7F3K',
    });
    expect(messaging.customerMessages).toHaveLength(1);
  });

  it('answers 200 and stays quiet for a completed order', async () => {
    const response = await authorized(
      body({ analysis: { structuredData: { orderCompleted: true } } }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: 'skipped' });
    expect(messaging.sent).toHaveLength(0);
  });

  it('acknowledges message types it does not act on', async () => {
    const response = await authorized(body({ type: 'status-update' }));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ outcome: 'ignored' });
    expect(persistence.listRecoveries()).toHaveLength(0);
  });

  it('answers 400 for invalid JSON and unmappable payloads', async () => {
    expect((await authorized('{not json')).status).toBe(400);

    const unmappable = await authorized(body({ call: {}, customer: undefined }));
    expect(unmappable.status).toBe(400);
    await expect(unmappable.json()).resolves.toMatchObject({ outcome: 'unmappable_payload' });
  });

  it('answers 503 when the customer could not be reached, so Vapi retries', async () => {
    messaging.failCustomer = new Error('provider down');
    const failed = await authorized(body());

    expect(failed.status).toBe(503);
    expect(persistence.listRecoveries()[0]?.status).toBe('pending');

    // The retry finishes the job under the original reference.
    messaging.failCustomer = null;
    const retry = await authorized(body());

    expect(retry.status).toBe(200);
    await expect(retry.json()).resolves.toMatchObject({
      outcome: 'notified',
      recoveryId: 'R-7F3K',
      retriedPending: true,
    });
    expect(messaging.customerMessages).toHaveLength(1);
  });

  it('answers 500 when the service throws unexpectedly', async () => {
    persistence.recoveries.create = async () => {
      throw new Error('disk on fire');
    };

    expect((await authorized(body())).status).toBe(500);
  });
});
