import { beforeEach, describe, expect, it } from 'vitest';

import {
  RecoveryService,
  decide,
  deriveReason,
  hasPartialOrder,
} from '../src/core/recovery-service.js';
import type { IncomingCallEvent } from '../src/core/types.js';
import { InMemoryPersistence } from '../src/interfaces/persistence/in-memory-persistence.js';
import { RecoveryIdConflictError } from '../src/interfaces/persistence/persistence-port.js';
import { MessagingError } from '../src/interfaces/messaging/messaging-port.js';
import { RecordingMessaging } from './fakes/recording-messaging.js';

const OWNER_PHONE = '+41790000000';
const TZ = 'Europe/Zurich';

function callEvent(overrides: Partial<IncomingCallEvent> = {}): IncomingCallEvent {
  return {
    callId: 'call-1',
    fromPhone: '+41791234567',
    toPhone: '+41445556677',
    startedAt: '2026-08-09T12:30:00.000Z',
    endedAt: '2026-08-09T12:32:00.000Z',
    endedReason: 'customer-hung-up',
    orderCompleted: false,
    ...overrides,
  };
}

describe('hasPartialOrder', () => {
  it('treats real data as present', () => {
    expect(hasPartialOrder({ items: [{ sku: 'BIER-50' }] })).toBe(true);
    expect(hasPartialOrder(['BIER-50'])).toBe(true);
    expect(hasPartialOrder('2 Harassen Bier')).toBe(true);
  });

  it('treats missing and empty containers as absent', () => {
    expect(hasPartialOrder(undefined)).toBe(false);
    expect(hasPartialOrder(null)).toBe(false);
    expect(hasPartialOrder({})).toBe(false);
    expect(hasPartialOrder([])).toBe(false);
    expect(hasPartialOrder('   ')).toBe(false);
  });
});

describe('deriveReason', () => {
  it('is incomplete_order only when partial order data exists', () => {
    expect(deriveReason(callEvent())).toBe('missed_call');
    expect(deriveReason(callEvent({ partialOrder: {} }))).toBe('missed_call');
    expect(deriveReason(callEvent({ partialOrder: { items: ['x'] } }))).toBe('incomplete_order');
  });
});

describe('decide', () => {
  it('recovers an unfinished call with a usable number', () => {
    expect(decide(callEvent())).toEqual({
      action: 'recover',
      reason: 'missed_call',
      phone: '+41791234567',
    });
  });

  it('normalizes the phone number it hands on', () => {
    expect(decide(callEvent({ fromPhone: '0041 79 123 45 67' }))).toEqual({
      action: 'recover',
      reason: 'missed_call',
      phone: '+41791234567',
    });
  });

  it('skips a completed order regardless of the ended reason', () => {
    expect(decide(callEvent({ orderCompleted: true }))).toEqual({
      action: 'skip',
      skipReason: 'order_completed',
    });
  });

  it('skips a withheld or malformed caller number', () => {
    expect(decide(callEvent({ fromPhone: 'anonymous' }))).toEqual({
      action: 'skip',
      skipReason: 'unusable_phone',
    });
    expect(decide(callEvent({ fromPhone: '' }))).toEqual({
      action: 'skip',
      skipReason: 'unusable_phone',
    });
  });

  it('recovers voicemail and no-answer calls too', () => {
    for (const endedReason of ['no-answer', 'voicemail', 'assistant-ended']) {
      expect(decide(callEvent({ endedReason }))).toMatchObject({ action: 'recover' });
    }
  });
});

describe('RecoveryService.handle', () => {
  let persistence: InMemoryPersistence;
  let messaging: RecordingMessaging;
  let ids: string[];
  let service: RecoveryService;

  function buildService(overrides: Partial<ConstructorParameters<typeof RecoveryService>[0]> = {}) {
    return new RecoveryService({
      persistence,
      messaging,
      now: () => '2026-08-09T12:33:00.000Z',
      generateRecoveryId: () => ids.shift() ?? 'R-ZZZZ',
      ownerPhone: OWNER_PHONE,
      timeZone: TZ,
      ...overrides,
    });
  }

  beforeEach(() => {
    persistence = new InMemoryPersistence(() => '2026-08-09T12:33:00.000Z');
    messaging = new RecordingMessaging();
    ids = ['R-7F3K', 'R-9QB2', 'R-4TX8'];
    service = buildService();
  });

  it('creates the recovery, messages both sides and marks it notified', async () => {
    const result = await service.handle(callEvent({ callerName: 'Meier' }));

    expect(result).toEqual({
      outcome: 'notified',
      recoveryId: 'R-7F3K',
      reason: 'missed_call',
      retriedPending: false,
      ownerNotified: true,
    });

    const [recovery] = persistence.listRecoveries();
    expect(recovery).toMatchObject({
      recoveryId: 'R-7F3K',
      callId: 'call-1',
      reason: 'missed_call',
      status: 'notified',
      notifiedAt: '2026-08-09T12:33:00.000Z',
      partialOrder: null,
    });

    const [customer] = persistence.listCustomers();
    expect(customer).toMatchObject({ phone: '+41791234567', name: 'Meier' });
    expect(recovery?.customerId).toBe(customer?.id);

    expect(messaging.customerMessages).toHaveLength(1);
    expect(messaging.customerMessages[0]?.toPhone).toBe('+41791234567');
    expect(messaging.customerMessages[0]?.body).toContain('R-7F3K');
    expect(messaging.customerMessages[0]?.body).toContain('Anruf leider verpasst');

    expect(messaging.ownerMessages).toHaveLength(1);
    expect(messaging.ownerMessages[0]?.toPhone).toBe(OWNER_PHONE);
    expect(messaging.ownerMessages[0]?.body).toContain('Name: Meier');
    expect(messaging.ownerMessages[0]?.body).toContain('Zeit: 14:32');
  });

  it('messages the customer before the owner', async () => {
    await service.handle(callEvent());
    expect(messaging.sent.map((message) => message.channel)).toEqual(['customer', 'owner']);
  });

  it('stores the raw partial order and uses the incomplete-order wording', async () => {
    const partialOrder = { items: [{ sku: 'BIER-50', qty: 2 }] };
    const result = await service.handle(callEvent({ partialOrder }));

    expect(result).toMatchObject({ outcome: 'notified', reason: 'incomplete_order' });
    expect(persistence.listRecoveries()[0]?.partialOrder).toBe(JSON.stringify(partialOrder));
    expect(messaging.customerMessages[0]?.body).toContain('noch nicht abgeschlossen');
  });

  it('persists nothing and sends nothing for a completed order', async () => {
    const result = await service.handle(callEvent({ orderCompleted: true }));

    expect(result).toEqual({
      outcome: 'skipped',
      decision: { action: 'skip', skipReason: 'order_completed' },
    });
    expect(persistence.listRecoveries()).toHaveLength(0);
    expect(persistence.listCustomers()).toHaveLength(0);
    expect(messaging.sent).toHaveLength(0);
  });

  it('persists nothing and sends nothing for a withheld number', async () => {
    const result = await service.handle(callEvent({ fromPhone: 'anonymous' }));

    expect(result).toEqual({
      outcome: 'skipped',
      decision: { action: 'skip', skipReason: 'unusable_phone' },
    });
    expect(persistence.listRecoveries()).toHaveLength(0);
    expect(messaging.sent).toHaveLength(0);
  });

  describe('idempotency', () => {
    it('does not send twice for a replayed callId', async () => {
      const first = await service.handle(callEvent());
      const second = await service.handle(callEvent());

      expect(first).toMatchObject({ outcome: 'notified', recoveryId: 'R-7F3K' });
      expect(second).toEqual({ outcome: 'duplicate', recoveryId: 'R-7F3K', status: 'notified' });

      expect(messaging.sent).toHaveLength(2); // one customer + one owner, from the first call
      expect(persistence.listRecoveries()).toHaveLength(1);
    });

    it('stays idempotent across many replays', async () => {
      for (let i = 0; i < 5; i += 1) {
        await service.handle(callEvent());
      }
      expect(messaging.customerMessages).toHaveLength(1);
      expect(persistence.listRecoveries()).toHaveLength(1);
    });

    it('treats a different callId from the same number as a new recovery', async () => {
      await service.handle(callEvent({ callId: 'call-1' }));
      const second = await service.handle(callEvent({ callId: 'call-2' }));

      expect(second).toMatchObject({ outcome: 'notified', recoveryId: 'R-9QB2' });
      expect(persistence.listRecoveries()).toHaveLength(2);
      expect(persistence.listCustomers()).toHaveLength(1); // same customer, upserted
      expect(messaging.customerMessages).toHaveLength(2);
    });

    it('retries a recovery left in pending by a failed send', async () => {
      messaging.failCustomer = new Error('provider timeout');
      const failed = await service.handle(callEvent());

      expect(failed).toEqual({
        outcome: 'send_failed',
        recoveryId: 'R-7F3K',
        error: 'provider timeout',
      });
      expect(persistence.listRecoveries()[0]).toMatchObject({
        status: 'pending',
        notifiedAt: null,
      });
      expect(messaging.sent).toHaveLength(0);

      messaging.failCustomer = null;
      const retried = await service.handle(callEvent());

      expect(retried).toEqual({
        outcome: 'notified',
        recoveryId: 'R-7F3K', // the original reference, not a fresh one
        reason: 'missed_call',
        retriedPending: true,
        ownerNotified: true,
      });
      expect(persistence.listRecoveries()).toHaveLength(1);
      expect(persistence.listRecoveries()[0]?.status).toBe('notified');
      expect(messaging.customerMessages).toHaveLength(1);
    });
  });

  describe('permanently undeliverable customer', () => {
    const notOnWhatsapp = () =>
      new MessagingError('recipient is not a WhatsApp user', {
        code: 'not_on_whatsapp',
        retryable: false,
      });

    it('closes the recovery and asks the owner to call back', async () => {
      messaging.failCustomer = notOnWhatsapp();
      const result = await service.handle(callEvent({ callerName: 'Meier' }));

      expect(result).toEqual({
        outcome: 'send_rejected',
        recoveryId: 'R-7F3K',
        code: 'not_on_whatsapp',
        ownerNotified: true,
        error: 'recipient is not a WhatsApp user',
      });

      // Closed, not pending: nothing will ever retry this one.
      expect(persistence.listRecoveries()[0]).toMatchObject({
        status: 'closed',
        notifiedAt: null, // nobody was notified — the timestamp must not claim otherwise
      });

      expect(messaging.customerMessages).toHaveLength(0);
      expect(messaging.ownerMessages).toHaveLength(1);
      expect(messaging.ownerMessages[0]?.template.key).toBe('owner_undeliverable');
      expect(messaging.ownerMessages[0]?.body).toContain('WhatsApp nicht zustellbar');
      expect(messaging.ownerMessages[0]?.body).toContain('Nummer nicht bei WhatsApp registriert');
      expect(messaging.ownerMessages[0]?.body).toContain('manuell zurückrufen');
    });

    it('reports it when even the owner fallback fails', async () => {
      messaging.failCustomer = notOnWhatsapp();
      messaging.failOwner = new Error('owner unreachable too');

      const result = await service.handle(callEvent());

      expect(result).toMatchObject({ outcome: 'send_rejected', ownerNotified: false });
      expect(persistence.listRecoveries()[0]?.status).toBe('closed');
    });

    it('is not triggered by a transient failure', async () => {
      messaging.failCustomer = new MessagingError('502 from provider', {
        code: 'provider_unavailable',
        retryable: true,
      });

      const result = await service.handle(callEvent());

      expect(result).toMatchObject({ outcome: 'send_failed' });
      expect(persistence.listRecoveries()[0]?.status).toBe('pending');
      expect(messaging.ownerMessages).toHaveLength(0);
    });

    it('treats an unexpected non-provider error as transient', async () => {
      // A bug during sending must not be mistaken for "customer unreachable"
      // and close a recovery that a retry could still deliver.
      messaging.failCustomer = new TypeError('cannot read property of undefined');

      const result = await service.handle(callEvent());

      expect(result).toMatchObject({ outcome: 'send_failed' });
      expect(persistence.listRecoveries()[0]?.status).toBe('pending');
    });

    it('lets the customer be reached on a later retry', async () => {
      messaging.failCustomer = new MessagingError('rate limited', {
        code: 'rate_limited',
        retryable: true,
      });
      await service.handle(callEvent());

      messaging.failCustomer = null;
      const retry = await service.handle(callEvent());

      expect(retry).toMatchObject({ outcome: 'notified', retriedPending: true });
      expect(persistence.listRecoveries()[0]?.status).toBe('notified');
    });
  });

  it('hands the adapter both the rendered text and the template', async () => {
    await service.handle(callEvent({ callerName: 'Meier', partialOrder: { items: ['x'] } }));

    expect(messaging.customerMessages[0]?.template).toEqual({
      key: 'customer_incomplete_order',
      language: 'de',
      variables: ['R-7F3K'],
    });
    expect(messaging.ownerMessages[0]?.template).toMatchObject({
      key: 'owner_lost_order',
      variables: ['+41791234567', 'Meier', 'Unvollständige Bestellung', 'R-7F3K', '14:32'],
    });
  });

  it('keeps the recovery notified when only the owner notification fails', async () => {
    messaging.failOwner = new Error('owner unreachable');
    const result = await service.handle(callEvent());

    expect(result).toMatchObject({ outcome: 'notified', ownerNotified: false });
    expect(persistence.listRecoveries()[0]?.status).toBe('notified');
    expect(messaging.customerMessages).toHaveLength(1);
  });

  it('retries with a fresh id when the generated recovery id collides', async () => {
    let attempts = 0;
    const originalCreate = persistence.recoveries.create.bind(persistence.recoveries);
    persistence.recoveries.create = async (input) => {
      attempts += 1;
      if (attempts === 1) throw new RecoveryIdConflictError(input.recoveryId);
      return originalCreate(input);
    };

    const result = await service.handle(callEvent());

    expect(attempts).toBe(2);
    expect(result).toMatchObject({ outcome: 'notified', recoveryId: 'R-9QB2' });
  });

  it('gives up with a clear error when ids keep colliding', async () => {
    persistence.recoveries.create = async (input) => {
      throw new RecoveryIdConflictError(input.recoveryId);
    };

    await expect(service.handle(callEvent())).rejects.toThrow(
      /Could not allocate a free recovery id/,
    );
    expect(messaging.sent).toHaveLength(0);
  });
});
