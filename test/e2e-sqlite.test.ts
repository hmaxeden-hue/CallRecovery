/**
 * End-to-end through the real adapters: SQLite on disk plus the stub messaging
 * adapter, wired exactly as app.ts wires them. The in-memory fake could be
 * wrong about constraint behaviour; this test is what proves it is not.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRecoveryIdFactory } from '../src/core/recovery-id.js';
import { RecoveryService } from '../src/core/recovery-service.js';
import type { IncomingCallEvent } from '../src/core/types.js';
import { StubMessaging } from '../src/interfaces/messaging/stub-messaging.js';
import { RecoveryIdConflictError } from '../src/interfaces/persistence/persistence-port.js';
import { SqlitePersistence } from '../src/interfaces/persistence/sqlite-persistence.js';

const OWNER_PHONE = '+41790000000';

function callEvent(overrides: Partial<IncomingCallEvent> = {}): IncomingCallEvent {
  return {
    callId: 'vapi-call-abc',
    fromPhone: '+41791234567',
    toPhone: '+41445556677',
    startedAt: '2026-08-09T12:30:00.000Z',
    endedAt: '2026-08-09T12:32:00.000Z',
    endedReason: 'customer-hung-up',
    orderCompleted: false,
    ...overrides,
  };
}

describe('end-to-end on SQLite', () => {
  let directory: string;
  let persistence: SqlitePersistence;
  let output: string[];
  let service: RecoveryService;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'call-recovery-'));
    // Nested path on purpose: the adapter has to create ./data itself.
    persistence = new SqlitePersistence({
      databasePath: join(directory, 'data', 'recovery.sqlite'),
      now: () => '2026-08-09T12:33:00.000Z',
    });

    output = [];
    const ids = ['R-7F3K', 'R-9QB2'];

    service = new RecoveryService({
      persistence,
      messaging: new StubMessaging({ write: (line) => output.push(line) }),
      now: () => '2026-08-09T12:33:00.000Z',
      generateRecoveryId: () => ids.shift() ?? 'R-ZZZZ',
      ownerPhone: OWNER_PHONE,
      timeZone: 'Europe/Zurich',
    });
  });

  afterEach(() => {
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('creates the recovery, prints both messages and marks it notified', async () => {
    const result = await service.handle(callEvent({ callerName: 'Meier' }));

    expect(result).toMatchObject({ outcome: 'notified', recoveryId: 'R-7F3K' });

    const recoveries = persistence.listRecoveries();
    expect(recoveries).toHaveLength(1);
    expect(recoveries[0]).toMatchObject({
      recoveryId: 'R-7F3K',
      callId: 'vapi-call-abc',
      reason: 'missed_call',
      status: 'notified',
      notifiedAt: '2026-08-09T12:33:00.000Z',
    });

    expect(output).toHaveLength(2);
    expect(output[0]).toContain('channel=customer to=+41791234567 ref=R-7F3K');
    expect(output[0]).toContain('wir haben Ihren Anruf leider verpasst');
    expect(output[1]).toContain(`channel=owner to=${OWNER_PHONE}`);
    expect(output[1]).toContain('Name: Meier');
    expect(output[1]).toContain('Zeit: 14:32');
  });

  it('does not message twice when Vapi retries the same call', async () => {
    await service.handle(callEvent());
    output.length = 0;

    const second = await service.handle(callEvent());

    expect(second).toEqual({ outcome: 'duplicate', recoveryId: 'R-7F3K', status: 'notified' });
    expect(output).toEqual([]);
    expect(persistence.listRecoveries()).toHaveLength(1);
  });

  it('stores partial order data as JSON', async () => {
    const partialOrder = { items: [{ sku: 'BIER-50', qty: 2 }] };
    await service.handle(callEvent({ partialOrder }));

    const [recovery] = persistence.listRecoveries();
    expect(recovery?.reason).toBe('incomplete_order');
    expect(JSON.parse(recovery?.partialOrder ?? 'null')).toEqual(partialOrder);
  });

  it('survives a restart against the same database file', async () => {
    const databasePath = join(directory, 'data', 'recovery.sqlite');
    await service.handle(callEvent());
    persistence.close();

    // Fresh connection, as after a process restart: the schema must already be
    // there and the callId must still block a second notification.
    persistence = new SqlitePersistence({ databasePath });
    const restarted = new RecoveryService({
      persistence,
      messaging: new StubMessaging({ write: (line) => output.push(line) }),
      now: () => '2026-08-09T12:40:00.000Z',
      generateRecoveryId: () => 'R-4TX8',
      ownerPhone: OWNER_PHONE,
      timeZone: 'Europe/Zurich',
    });

    const result = await restarted.handle(callEvent());
    expect(result).toMatchObject({ outcome: 'duplicate', recoveryId: 'R-7F3K' });
    expect(persistence.listRecoveries()).toHaveLength(1);
  });
});

describe('SqlitePersistence constraints', () => {
  let directory: string;
  let persistence: SqlitePersistence;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'call-recovery-'));
    persistence = new SqlitePersistence({
      databasePath: join(directory, 'recovery.sqlite'),
      now: () => '2026-08-09T12:33:00.000Z',
    });
  });

  afterEach(() => {
    persistence.close();
    rmSync(directory, { recursive: true, force: true });
  });

  it('upserts a customer by phone and never loses a known name', async () => {
    const first = await persistence.customers.upsertByPhone({ phone: '+41791234567', name: null });
    const second = await persistence.customers.upsertByPhone({
      phone: '+41791234567',
      name: 'Meier',
    });
    const third = await persistence.customers.upsertByPhone({ phone: '+41791234567', name: '  ' });

    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Meier');
    expect(third.name).toBe('Meier');
  });

  it('reports a duplicate callId as data, not as an error', async () => {
    const customer = await persistence.customers.upsertByPhone({ phone: '+41791234567' });
    const input = {
      recoveryId: 'R-7F3K',
      customerId: customer.id,
      callId: 'call-1',
      reason: 'missed_call' as const,
      partialOrder: null,
      createdAt: '2026-08-09T12:33:00.000Z',
    };

    expect(await persistence.recoveries.create(input)).toMatchObject({ created: true });

    const retry = await persistence.recoveries.create({ ...input, recoveryId: 'R-9QB2' });
    expect(retry.created).toBe(false);
    if (!retry.created) expect(retry.existing.recoveryId).toBe('R-7F3K');
  });

  it('throws RecoveryIdConflictError when the id is taken by another call', async () => {
    const customer = await persistence.customers.upsertByPhone({ phone: '+41791234567' });
    const input = {
      recoveryId: 'R-7F3K',
      customerId: customer.id,
      callId: 'call-1',
      reason: 'missed_call' as const,
      partialOrder: null,
      createdAt: '2026-08-09T12:33:00.000Z',
    };

    await persistence.recoveries.create(input);

    await expect(
      persistence.recoveries.create({ ...input, callId: 'call-2' }),
    ).rejects.toBeInstanceOf(RecoveryIdConflictError);
  });

  it('rejects an unknown recovery id on markNotified', async () => {
    await expect(persistence.recoveries.markNotified('R-XXXX', 'now')).rejects.toThrow(
      /Unknown recovery id/,
    );
  });

  it('generates unbiased ids through crypto.randomInt in the wiring path', () => {
    const factory = createRecoveryIdFactory();
    const ids = new Set(Array.from({ length: 200 }, () => factory()));
    expect(ids.size).toBeGreaterThan(190); // collisions must be rare, not systematic
  });
});
