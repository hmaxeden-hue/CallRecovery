/**
 * Twilio WhatsApp adapter.
 *
 *   POST https://api.twilio.com/2010-04-01/Accounts/{AccountSid}/Messages.json
 *   Basic auth, application/x-www-form-urlencoded, 201 Created on success.
 *
 * Business-initiated WhatsApp messages must be templates, so this always sends
 * ContentSid + ContentVariables — never the free-form Body. The rendered text
 * travels along in OutboundMessage.body for logging only.
 *
 * A 201 means Twilio accepted the message, not that it reached the customer.
 * Delivery confirmation arrives via StatusCallback, which is deliberately not
 * part of this phase.
 */

import type { TemplateKey } from '../../core/messages.js';
import type { Logger } from '../../core/types.js';
import { MessagingError, type MessagingFailureCode, type OutboundMessage } from './messaging-port.js';
import type { RetryOptions } from './retry.js';
import {
  WhatsappHttpMessaging,
  parseRetryAfter,
  type FetchLike,
  type ProviderRequest,
} from './whatsapp-http.js';

export const TWILIO_API_BASE = 'https://api.twilio.com/2010-04-01';

export type TwilioConfig = {
  accountSid: string;
  authToken: string;
  /** WhatsApp-enabled sender in E.164, without the "whatsapp:" prefix. */
  whatsappFrom: string;
  /** Approved Content SIDs (HX…), one per domain template key. */
  contentSids: Record<TemplateKey, string>;
};

export type TwilioMessagingOptions = {
  fetch?: FetchLike;
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  logger?: Logger;
  /** Overridable for tests; defaults to Twilio's public API. */
  apiBase?: string;
};

/**
 * Twilio error codes we can act on, verified against Twilio's error dictionary.
 * Anything not listed falls back to the HTTP status, so an unknown code never
 * goes unclassified — it just gets the coarser answer.
 *
 * This table is the one place to refine once real failures show up in the logs.
 */
const TWILIO_ERROR_CODES: Record<number, { code: MessagingFailureCode; retryable: boolean }> = {
  20003: { code: 'authentication', retryable: false }, // permission denied / bad credentials
  20429: { code: 'rate_limited', retryable: true }, // too many requests — safe to retry
  21211: { code: 'invalid_number', retryable: false }, // invalid 'To' number
  21614: { code: 'invalid_number', retryable: false }, // 'To' is not a valid mobile number
  21654: { code: 'template_rejected', retryable: false }, // ContentSid required
  63003: { code: 'not_on_whatsapp', retryable: false }, // channel could not find 'To' address
  63016: { code: 'template_rejected', retryable: false }, // freeform outside window, template needed
  63018: { code: 'rate_limited', retryable: true }, // channel rate limit
};

type TwilioErrorBody = { code?: number; message?: string; more_info?: string };

function parseTwilioError(bodyText: string): TwilioErrorBody {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    return typeof parsed === 'object' && parsed !== null ? (parsed as TwilioErrorBody) : {};
  } catch {
    return {};
  }
}

/**
 * Classifies a Twilio failure response.
 *
 * Unknown 4xx counts as permanent: Twilio rejected the request itself, and
 * sending the identical bytes again will be rejected identically. Unknown 5xx
 * counts as transient.
 */
export function interpretTwilioFailure(input: {
  status: number;
  bodyText: string;
  headers: Headers;
}): MessagingError {
  const body = parseTwilioError(input.bodyText);
  const known = body.code === undefined ? undefined : TWILIO_ERROR_CODES[body.code];

  const classification =
    known ??
    (input.status === 429
      ? { code: 'rate_limited' as const, retryable: true }
      : input.status === 401 || input.status === 403
        ? { code: 'authentication' as const, retryable: false }
        : input.status >= 500
          ? { code: 'provider_unavailable' as const, retryable: true }
          : { code: 'unknown' as const, retryable: false });

  const detail = body.message ?? input.bodyText.slice(0, 200) ?? '';

  return new MessagingError(`Twilio ${input.status}: ${detail || 'no detail'}`, {
    code: classification.code,
    retryable: classification.retryable,
    providerCode: body.code,
    status: input.status,
    retryAfterMs: parseRetryAfter(input.headers),
  });
}

/** Twilio addresses WhatsApp endpoints with a channel prefix. */
function whatsappAddress(phone: string): string {
  return `whatsapp:${phone}`;
}

/** ContentVariables is a JSON string keyed by the 1-based variable position. */
export function toContentVariables(variables: string[]): string {
  return JSON.stringify(
    Object.fromEntries(variables.map((value, index) => [String(index + 1), value])),
  );
}

export function createTwilioMessaging(
  config: TwilioConfig,
  options: TwilioMessagingOptions = {},
): WhatsappHttpMessaging {
  const apiBase = options.apiBase ?? TWILIO_API_BASE;
  const authorization = `Basic ${Buffer.from(`${config.accountSid}:${config.authToken}`).toString('base64')}`;

  const buildRequest = (message: OutboundMessage): ProviderRequest => {
    const contentSid = config.contentSids[message.template.key];
    if (!contentSid) {
      // Configuration gap, not a provider fault — retrying cannot fix it.
      throw new MessagingError(
        `No Twilio Content SID configured for template "${message.template.key}"`,
        { code: 'template_rejected', retryable: false },
      );
    }

    const form = new URLSearchParams({
      To: whatsappAddress(message.toPhone),
      From: whatsappAddress(config.whatsappFrom),
      ContentSid: contentSid,
      ContentVariables: toContentVariables(message.template.variables),
    });

    return {
      url: `${apiBase}/Accounts/${config.accountSid}/Messages.json`,
      headers: {
        authorization,
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: form.toString(),
    };
  };

  return new WhatsappHttpMessaging({
    providerName: 'twilio',
    buildRequest,
    interpretFailure: interpretTwilioFailure,
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.retry ? { retry: options.retry } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
}
