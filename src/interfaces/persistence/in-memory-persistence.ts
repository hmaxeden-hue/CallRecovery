/**
 * In-memory persistence adapter.
 *
 * Used by the unit tests and by the local simulation script. It implements the
 * same port as the SQLite adapter and mirrors its constraint behaviour (unique
 * phone, unique callId, unique recoveryId) so a test passing here means the
 * service is using the port correctly, not just this fake.
 */

import { randomUUID } from 'node:crypto';

import type { CallRecovery, Customer } from '../../core/types.js';
import {
  RecoveryIdConflictError,
  type CallRecoveryRepo,
  type CreateRecoveryInput,
  type CreateRecoveryResult,
  type CustomerRepo,
  type PersistencePort,
  type UpsertCustomerInput,
} from './persistence-port.js';

export class InMemoryPersistence implements PersistencePort {
  private readonly customersByPhone = new Map<string, Customer>();
  private readonly recoveriesById = new Map<string, CallRecovery>();
  private readonly recoveryIdByCallId = new Map<string, string>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  readonly customers: CustomerRepo = {
    upsertByPhone: async (input: UpsertCustomerInput): Promise<Customer> => {
      const existing = this.customersByPhone.get(input.phone);
      const name = input.name?.trim() ? input.name.trim() : null;

      if (existing) {
        // Latest known name wins; never overwrite a known name with null.
        const updated: Customer = { ...existing, name: name ?? existing.name };
        this.customersByPhone.set(input.phone, updated);
        return { ...updated };
      }

      const created: Customer = {
        id: randomUUID(),
        phone: input.phone,
        name,
        createdAt: this.now(),
      };
      this.customersByPhone.set(input.phone, created);
      return { ...created };
    },
  };

  readonly recoveries: CallRecoveryRepo = {
    findByCallId: async (callId: string): Promise<CallRecovery | null> => {
      const recoveryId = this.recoveryIdByCallId.get(callId);
      if (!recoveryId) return null;
      const recovery = this.recoveriesById.get(recoveryId);
      return recovery ? { ...recovery } : null;
    },

    create: async (input: CreateRecoveryInput): Promise<CreateRecoveryResult> => {
      const existingId = this.recoveryIdByCallId.get(input.callId);
      if (existingId) {
        const existing = this.recoveriesById.get(existingId);
        if (existing) return { created: false, existing: { ...existing } };
      }

      if (this.recoveriesById.has(input.recoveryId)) {
        throw new RecoveryIdConflictError(input.recoveryId);
      }

      const recovery: CallRecovery = {
        recoveryId: input.recoveryId,
        customerId: input.customerId,
        callId: input.callId,
        reason: input.reason,
        status: 'pending',
        partialOrder: input.partialOrder,
        createdAt: input.createdAt,
        notifiedAt: null,
      };

      this.recoveriesById.set(recovery.recoveryId, recovery);
      this.recoveryIdByCallId.set(recovery.callId, recovery.recoveryId);
      return { created: true, recovery: { ...recovery } };
    },

    markNotified: async (recoveryId: string, notifiedAt: string): Promise<void> => {
      const recovery = this.recoveriesById.get(recoveryId);
      if (!recovery) throw new Error(`Unknown recovery id: ${recoveryId}`);
      this.recoveriesById.set(recoveryId, { ...recovery, status: 'notified', notifiedAt });
    },
  };

  /** Test/debug helper — not part of the port. */
  listRecoveries(): CallRecovery[] {
    return [...this.recoveriesById.values()].map((recovery) => ({ ...recovery }));
  }

  /** Test/debug helper — not part of the port. */
  listCustomers(): Customer[] {
    return [...this.customersByPhone.values()].map((customer) => ({ ...customer }));
  }
}
