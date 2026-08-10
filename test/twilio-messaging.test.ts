/**
 * Verified against a fake fetch: no credentials, no network, but the exact
 * request Twilio would receive is asserted field by field.
 */

import { describe, expect, it, vi } from 'vitest';

import { customerTemplate, ownerTemplate } from '../src/core/messages.js';
import { MessagingError } from '../src/interfaces/messaging/messaging-port.js';
import {
  createTwilioMessaging,
  interpretTwilioFailure,
  toContentVariables,
  type TwilioConfig,
} from '../src/interfaces/messaging/twilio-messaging.js';
import type { FetchLike } from '../src/interfaces/messaging/whatsapp-http.js';

const config: TwilioConfig = {
  accountSid: 'ACtest',
  authToken: 'token-secret',
  whatsappFrom: '+41445556677',
  contentSids: {
    customer_missed_call: 'HXmissed',
    customer_incomplete_order: 'HXincomplete',
    owner_lost_order: 'HXowner',
    owner_undeliverable: 'HXundeliverable',
  },
};

const message = {
  toPhone: '+41791234567',
  body: 'Guten Tag, wir haben Ihren Anruf leider verpasst. Ihre Referenz: R-7F3K. Vielen Dank!',
  template: customerTemplate({ reason: 'missed_call' as const, recoveryId: 'R-7F3K' }),
  recoveryId: 'R-7F3K',
};

function ok(status = 201): Response {
  return new Response(JSON.stringify({ sid: 'SM123', status: 'queued' }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function failure(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers });
}

/** No real sleeping in tests. */
const noRetryDelay = { baseDelayMs: 0, sleep: async () => {}, random: () => 0 };

describe('request shape', () => {
  it('posts a template message to the Twilio Messages endpoint', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(ok());
    const twilio = createTwilioMessaging(config, { fetch });

    await twilio.sendToCustomer(message);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;

    expect(url).toBe('https://api.twilio.com/2010-04-01/Accounts/ACtest/Messages.json');
    expect(init.method).toBe('POST');

    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['authorization']).toBe(
      `Basic ${Buffer.from('ACtest:token-secret').toString('base64')}`,
    );

    const form = new URLSearchParams(init.body as string);
    expect(form.get('To')).toBe('whatsapp:+41791234567');
    expect(form.get('From')).toBe('whatsapp:+41445556677');
    expect(form.get('ContentSid')).toBe('HXmissed');
    expect(form.get('ContentVariables')).toBe('{"1":"R-7F3K"}');
    // Business-initiated messages must be templates — never free-form Body.
    expect(form.get('Body')).toBeNull();
  });

  it('selects the Content SID that matches the template key', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(ok());
    const twilio = createTwilioMessaging(config, { fetch });

    await twilio.sendToCustomer({
      ...message,
      template: customerTemplate({ reason: 'incomplete_order', recoveryId: 'R-7F3K' }),
    });

    expect(new URLSearchParams(fetch.mock.calls[0]![1].body as string).get('ContentSid')).toBe(
      'HXincomplete',
    );
  });

  it('numbers owner template variables positionally', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(ok());
    const twilio = createTwilioMessaging(config, { fetch });

    const template = ownerTemplate({
      phone: '+41791234567',
      name: 'Meier',
      reason: 'missed_call',
      recoveryId: 'R-7F3K',
      at: '2026-08-09T12:32:00.000Z',
      timeZone: 'Europe/Zurich',
    });

    await twilio.sendToOwner({ ...message, template, toPhone: '+41790000000' });

    const variables = new URLSearchParams(fetch.mock.calls[0]![1].body as string).get(
      'ContentVariables',
    );
    expect(JSON.parse(variables ?? '{}')).toEqual({
      '1': '+41791234567',
      '2': 'Meier',
      '3': 'Verpasster Anruf',
      '4': 'R-7F3K',
      '5': '14:32',
    });
  });

  it('strips newlines from variables, which WhatsApp rejects', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(ok());
    const twilio = createTwilioMessaging(config, { fetch });

    await twilio.sendToOwner({
      ...message,
      template: { key: 'owner_lost_order', language: 'de', variables: ['Meier\nGmbH\t(Filiale)'] },
    });

    const variables = new URLSearchParams(fetch.mock.calls[0]![1].body as string).get(
      'ContentVariables',
    );
    expect(JSON.parse(variables ?? '{}')).toEqual({ '1': 'Meier GmbH (Filiale)' });
  });

  it('refuses a template with no configured Content SID, without calling Twilio', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(ok());
    const twilio = createTwilioMessaging(
      { ...config, contentSids: { ...config.contentSids, customer_missed_call: '' } },
      { fetch, retry: noRetryDelay },
    );

    await expect(twilio.sendToCustomer(message)).rejects.toMatchObject({
      code: 'template_rejected',
      retryable: false,
    });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('error classification', () => {
  const cases: Array<[number, number | undefined, string, boolean]> = [
    // status, Twilio code, expected failure code, retryable
    [400, 21211, 'invalid_number', false],
    [400, 21614, 'invalid_number', false],
    [400, 63003, 'not_on_whatsapp', false],
    [400, 63016, 'template_rejected', false],
    [400, 21654, 'template_rejected', false],
    [401, 20003, 'authentication', false],
    [429, 20429, 'rate_limited', true],
    [429, 63018, 'rate_limited', true],
    [500, undefined, 'provider_unavailable', true],
    [503, undefined, 'provider_unavailable', true],
    [403, undefined, 'authentication', false],
    [400, undefined, 'unknown', false],
  ];

  it.each(cases)(
    'maps HTTP %i / code %s to %s (retryable=%s)',
    (status, twilioCode, expectedCode, retryable) => {
      const error = interpretTwilioFailure({
        status,
        bodyText: JSON.stringify({ code: twilioCode, message: 'nope' }),
        headers: new Headers(),
      });

      expect(error).toBeInstanceOf(MessagingError);
      expect(error.code).toBe(expectedCode);
      expect(error.retryable).toBe(retryable);
      expect(error.status).toBe(status);
    },
  );

  it('treats an unknown 4xx as permanent — identical bytes get an identical rejection', () => {
    const error = interpretTwilioFailure({
      status: 422,
      bodyText: 'not json at all',
      headers: new Headers(),
    });

    expect(error.retryable).toBe(false);
    expect(error.code).toBe('unknown');
  });

  it('picks up a Retry-After hint', () => {
    const error = interpretTwilioFailure({
      status: 429,
      bodyText: JSON.stringify({ code: 20429 }),
      headers: new Headers({ 'retry-after': '3' }),
    });

    expect(error.retryAfterMs).toBe(3_000);
  });
});

describe('retry behaviour', () => {
  it('retries a 500 and then succeeds', async () => {
    const fetch = vi
      .fn<FetchLike>()
      .mockResolvedValueOnce(failure(500, 'upstream boom'))
      .mockResolvedValueOnce(ok());

    const twilio = createTwilioMessaging(config, { fetch, retry: noRetryDelay });
    await expect(twilio.sendToCustomer(message)).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not retry a permanent rejection', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(failure(400, { code: 63003 }));
    const twilio = createTwilioMessaging(config, { fetch, retry: noRetryDelay });

    await expect(twilio.sendToCustomer(message)).rejects.toMatchObject({
      code: 'not_on_whatsapp',
      retryable: false,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('gives up after the configured attempts and reports the last failure', async () => {
    const fetch = vi.fn<FetchLike>().mockResolvedValue(failure(503, { message: 'down' }));
    const twilio = createTwilioMessaging(config, {
      fetch,
      retry: { ...noRetryDelay, attempts: 3 },
    });

    await expect(twilio.sendToCustomer(message)).rejects.toMatchObject({
      code: 'provider_unavailable',
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('wraps a network fault as retryable', async () => {
    const fetch = vi.fn<FetchLike>().mockRejectedValue(new TypeError('fetch failed'));
    const twilio = createTwilioMessaging(config, { fetch, retry: { ...noRetryDelay, attempts: 2 } });

    await expect(twilio.sendToCustomer(message)).rejects.toMatchObject({
      code: 'network',
      retryable: true,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('treats a timeout as a retryable network fault', async () => {
    const timeout = new Error('The operation was aborted due to timeout');
    timeout.name = 'TimeoutError';
    const fetch = vi.fn<FetchLike>().mockRejectedValue(timeout);

    const twilio = createTwilioMessaging(config, { fetch, retry: { ...noRetryDelay, attempts: 1 } });

    await expect(twilio.sendToCustomer(message)).rejects.toMatchObject({ code: 'network' });
  });
});

describe('toContentVariables', () => {
  it('keys variables by 1-based position', () => {
    expect(toContentVariables(['a', 'b', 'c'])).toBe('{"1":"a","2":"b","3":"c"}');
    expect(toContentVariables([])).toBe('{}');
  });
});
