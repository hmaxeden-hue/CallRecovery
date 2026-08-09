/**
 * Local-first persistence on SQLite (better-sqlite3).
 *
 * The DDL lives inline rather than in a .sql file so that `tsc` is the entire
 * build — no asset-copy step that can silently ship a stale schema to dist/.
 *
 * better-sqlite3 is synchronous; the port is async. The methods therefore just
 * wrap synchronous work in promises. That is intentional (see persistence-port).
 */

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import type { Database as DatabaseHandle } from 'better-sqlite3';

import type { CallRecovery, Customer, RecoveryReason, RecoveryStatus } from '../../core/types.js';
import {
  RecoveryIdConflictError,
  type CallRecoveryRepo,
  type CreateRecoveryInput,
  type CreateRecoveryResult,
  type CustomerRepo,
  type PersistencePort,
  type UpsertCustomerInput,
} from './persistence-port.js';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS customers (
  id          TEXT PRIMARY KEY,
  phone       TEXT NOT NULL UNIQUE,
  name        TEXT,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS call_recoveries (
  recovery_id    TEXT PRIMARY KEY,
  customer_id    TEXT NOT NULL REFERENCES customers(id),
  call_id        TEXT NOT NULL UNIQUE,
  reason         TEXT NOT NULL CHECK (reason IN ('missed_call', 'incomplete_order')),
  status         TEXT NOT NULL CHECK (status IN ('pending', 'notified', 'resumed', 'closed')),
  partial_order  TEXT,
  created_at     TEXT NOT NULL,
  notified_at    TEXT
);

-- Phase 2 will scan for recoveries that still owe someone a follow-up.
CREATE INDEX IF NOT EXISTS idx_call_recoveries_status ON call_recoveries(status);
CREATE INDEX IF NOT EXISTS idx_call_recoveries_customer ON call_recoveries(customer_id);
`;

type CustomerRow = {
  id: string;
  phone: string;
  name: string | null;
  created_at: string;
};

type RecoveryRow = {
  recovery_id: string;
  customer_id: string;
  call_id: string;
  reason: RecoveryReason;
  status: RecoveryStatus;
  partial_order: string | null;
  created_at: string;
  notified_at: string | null;
};

function toCustomer(row: CustomerRow): Customer {
  return { id: row.id, phone: row.phone, name: row.name, createdAt: row.created_at };
}

function toRecovery(row: RecoveryRow): CallRecovery {
  return {
    recoveryId: row.recovery_id,
    customerId: row.customer_id,
    callId: row.call_id,
    reason: row.reason,
    status: row.status,
    partialOrder: row.partial_order,
    createdAt: row.created_at,
    notifiedAt: row.notified_at,
  };
}

/** Which unique constraint did SQLite complain about? */
function constraintTarget(error: unknown): 'call_id' | 'recovery_id' | null {
  if (!(error instanceof Error)) return null;
  const code = (error as { code?: string }).code ?? '';
  if (!code.startsWith('SQLITE_CONSTRAINT')) return null;
  if (error.message.includes('call_recoveries.call_id')) return 'call_id';
  if (error.message.includes('call_recoveries.recovery_id')) return 'recovery_id';
  return null;
}

export type SqlitePersistenceOptions = {
  /** File path, or ":memory:" for an ephemeral database. */
  databasePath: string;
  /** Injected clock, used for customer creation timestamps. */
  now?: () => string;
};

export class SqlitePersistence implements PersistencePort {
  private readonly db: DatabaseHandle;
  private readonly now: () => string;

  constructor(options: SqlitePersistenceOptions) {
    this.now = options.now ?? (() => new Date().toISOString());

    if (options.databasePath !== ':memory:') {
      mkdirSync(dirname(options.databasePath), { recursive: true });
    }

    this.db = new Database(options.databasePath);
    // WAL keeps reads from blocking the webhook's write; foreign_keys is off by
    // default in SQLite and has to be enabled per connection.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec(SCHEMA_SQL);
  }

  readonly customers: CustomerRepo = {
    upsertByPhone: async (input: UpsertCustomerInput): Promise<Customer> => {
      const name = input.name?.trim() ? input.name.trim() : null;

      // Single atomic statement: no read-then-write race between two webhooks
      // for the same caller. A known name is never overwritten with null.
      const row = this.db
        .prepare<[string, string, string | null, string], CustomerRow>(
          `INSERT INTO customers (id, phone, name, created_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(phone) DO UPDATE SET name = COALESCE(excluded.name, customers.name)
           RETURNING id, phone, name, created_at`,
        )
        .get(randomUUID(), input.phone, name, this.now());

      if (!row) throw new Error(`Customer upsert returned no row for ${input.phone}`);
      return toCustomer(row);
    },
  };

  readonly recoveries: CallRecoveryRepo = {
    findByCallId: async (callId: string): Promise<CallRecovery | null> => {
      const row = this.db
        .prepare<[string], RecoveryRow>('SELECT * FROM call_recoveries WHERE call_id = ?')
        .get(callId);
      return row ? toRecovery(row) : null;
    },

    create: async (input: CreateRecoveryInput): Promise<CreateRecoveryResult> => {
      try {
        const row = this.db
          .prepare<
            [string, string, string, RecoveryReason, string | null, string],
            RecoveryRow
          >(
            `INSERT INTO call_recoveries
               (recovery_id, customer_id, call_id, reason, status, partial_order, created_at, notified_at)
             VALUES (?, ?, ?, ?, 'pending', ?, ?, NULL)
             RETURNING *`,
          )
          .get(
            input.recoveryId,
            input.customerId,
            input.callId,
            input.reason,
            input.partialOrder,
            input.createdAt,
          );

        if (!row) throw new Error(`Recovery insert returned no row for ${input.recoveryId}`);
        return { created: true, recovery: toRecovery(row) };
      } catch (error) {
        const target = constraintTarget(error);

        // A replayed webhook — expected, and the reason call_id is unique.
        if (target === 'call_id') {
          const existing = await this.recoveries.findByCallId(input.callId);
          if (existing) return { created: false, existing };
        }

        // A one-in-a-million id draw. The caller retries with a fresh id.
        if (target === 'recovery_id') {
          throw new RecoveryIdConflictError(input.recoveryId);
        }

        throw error;
      }
    },

    markNotified: async (recoveryId: string, notifiedAt: string): Promise<void> => {
      const result = this.db
        .prepare<[string, string]>(
          `UPDATE call_recoveries SET status = 'notified', notified_at = ? WHERE recovery_id = ?`,
        )
        .run(notifiedAt, recoveryId);

      if (result.changes === 0) throw new Error(`Unknown recovery id: ${recoveryId}`);
    },
  };

  /** Read model for the simulation script and tests — not part of the port. */
  listRecoveries(): CallRecovery[] {
    const rows = this.db
      .prepare<[], RecoveryRow>('SELECT * FROM call_recoveries ORDER BY created_at')
      .all();
    return rows.map(toRecovery);
  }

  close(): void {
    this.db.close();
  }
}
