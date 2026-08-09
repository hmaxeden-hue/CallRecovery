import { describe, expect, it } from 'vitest';

import {
  END_OF_CALL_TYPE,
  deriveOrderCompleted,
  extractPartialOrder,
  mapVapiWebhook,
} from '../src/interfaces/intake/vapi-mapping.js';

/** Shape of a real Vapi end-of-call report, trimmed to the parts we read. */
function payload(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      type: END_OF_CALL_TYPE,
      endedReason: 'customer-hung-up',
      startedAt: '2026-08-09T12:30:00.000Z',
      endedAt: '2026-08-09T12:32:00.000Z',
      customer: { number: '+41791234567' },
      phoneNumber: { number: '+41445556677' },
      call: { id: 'vapi-call-abc' },
      analysis: {},
      // Fields we do not read must not break the mapping.
      artifact: { transcript: 'Guten Tag …', recordingUrl: 'https://example.test/r.wav' },
      cost: 0.12,
      ...overrides,
    },
  };
}

describe('mapVapiWebhook', () => {
  it('maps a complete end-of-call report', () => {
    const result = mapVapiWebhook(payload());

    expect(result).toEqual({
      status: 'mapped',
      event: {
        callId: 'vapi-call-abc',
        fromPhone: '+41791234567',
        toPhone: '+41445556677',
        startedAt: '2026-08-09T12:30:00.000Z',
        endedAt: '2026-08-09T12:32:00.000Z',
        endedReason: 'customer-hung-up',
        orderCompleted: false,
        // analysis without structuredData => no partialOrder at all
      },
    });
  });

  it('ignores message types we do not act on', () => {
    expect(mapVapiWebhook(payload({ type: 'status-update' }))).toEqual({
      status: 'ignored',
      messageType: 'status-update',
    });
    expect(mapVapiWebhook({ message: {} })).toMatchObject({ status: 'ignored' });
  });

  it('reads the caller number and timestamps from the nested call object too', () => {
    const result = mapVapiWebhook({
      message: {
        type: END_OF_CALL_TYPE,
        endedReason: 'no-answer',
        call: {
          id: 'vapi-call-xyz',
          startedAt: '2026-08-09T12:30:00.000Z',
          endedAt: '2026-08-09T12:31:00.000Z',
          customer: { number: '+41791112233', name: 'Meier' },
          phoneNumber: { number: '+41445556677' },
        },
      },
    });

    expect(result).toMatchObject({
      status: 'mapped',
      event: { callId: 'vapi-call-xyz', fromPhone: '+41791112233', callerName: 'Meier' },
    });
  });

  it('accepts epoch millisecond timestamps', () => {
    const result = mapVapiWebhook(
      payload({ startedAt: 1_786_000_000_000, endedAt: 1_786_000_120_000 }),
    );
    expect(result).toMatchObject({
      status: 'mapped',
      event: { endedAt: new Date(1_786_000_120_000).toISOString() },
    });
  });

  it('falls back to the message timestamp when endedAt is missing', () => {
    const result = mapVapiWebhook(
      payload({ endedAt: undefined, timestamp: '2026-08-09T12:35:00.000Z' }),
    );
    expect(result).toMatchObject({ status: 'mapped', event: { endedAt: '2026-08-09T12:35:00.000Z' } });
  });

  it('reports what is missing instead of guessing', () => {
    const result = mapVapiWebhook(payload({ call: {}, customer: undefined, endedAt: undefined }));

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.problems.join(' ')).toContain('message.call.id');
      expect(result.problems.join(' ')).toContain('message.customer.number');
      expect(result.problems.join(' ')).toContain('message.endedAt');
    }
  });

  it('rejects a body that is not a Vapi webhook at all', () => {
    expect(mapVapiWebhook({ hello: 'world' })).toMatchObject({ status: 'invalid' });
    expect(mapVapiWebhook(null)).toMatchObject({ status: 'invalid' });
  });

  describe('structuredData', () => {
    it('carries order content through as the partial order', () => {
      const structuredData = { items: [{ sku: 'BIER-50', qty: 2 }], deliveryDay: 'Freitag' };
      const result = mapVapiWebhook(payload({ analysis: { structuredData } }));

      expect(result).toMatchObject({ status: 'mapped', event: { partialOrder: structuredData } });
    });

    it('takes the caller name from structuredData when present', () => {
      const result = mapVapiWebhook(
        payload({ analysis: { structuredData: { callerName: 'Meier', items: ['x'] } } }),
      );

      expect(result).toMatchObject({
        status: 'mapped',
        event: { callerName: 'Meier', partialOrder: { items: ['x'] } },
      });
    });

    it('strips control fields so a bare flag is not mistaken for order content', () => {
      // Would otherwise become reason=incomplete_order and tell a customer their
      // (non-existent) order is unfinished.
      const result = mapVapiWebhook(
        payload({ analysis: { structuredData: { orderCompleted: false, callerName: 'Meier' } } }),
      );

      expect(result).toMatchObject({ status: 'mapped', event: { partialOrder: {} } });
    });
  });
});

describe('deriveOrderCompleted', () => {
  it('reads the explicit flag from structuredData', () => {
    expect(deriveOrderCompleted({ structuredData: { orderCompleted: true } })).toBe(true);
    expect(deriveOrderCompleted({ structuredData: { orderCompleted: 'true' } })).toBe(true);
    expect(deriveOrderCompleted({ structuredData: { orderCompleted: false } })).toBe(false);
  });

  it('falls back to successEvaluation', () => {
    expect(deriveOrderCompleted({ successEvaluation: true })).toBe(true);
    expect(deriveOrderCompleted({ successEvaluation: 'false' })).toBe(false);
  });

  it('defaults to false — an unnecessary message is cheaper than a lost order', () => {
    expect(deriveOrderCompleted(undefined)).toBe(false);
    expect(deriveOrderCompleted({})).toBe(false);
    expect(deriveOrderCompleted({ structuredData: { items: ['x'] } })).toBe(false);
  });
});

describe('extractPartialOrder', () => {
  it('keeps order content and drops control keys', () => {
    expect(
      extractPartialOrder({ orderCompleted: true, name: 'Meier', items: ['x'], note: 'eilig' }),
    ).toEqual({ items: ['x'], note: 'eilig' });
  });

  it('passes non-objects through untouched', () => {
    expect(extractPartialOrder('2 Harassen')).toBe('2 Harassen');
    expect(extractPartialOrder(undefined)).toBeUndefined();
  });
});
