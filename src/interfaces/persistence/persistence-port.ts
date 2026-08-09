/**
 * Persistence port.
 *
 * Async by design even though the SQLite default is synchronous underneath:
 * a later Airtable/Postgres adapter is unavoidably async, and changing the
 * signature then would force a change in core/ — exactly what the architecture
 * rule forbids. The cost today is a handful of awaits.
 */

import type { CallRecovery, Customer, RecoveryReason } from '../../core/types.js';

export type UpsertCustomerInput = {
  /** E.164, already normalized by the core. */
  phone: string;
  name?: string | null;
};

export type CreateRecoveryInput = {
  recoveryId: string;
  customerId: string;
  callId: string;
  reason: RecoveryReason;
  /** JSON string of the raw partial order, or null. */
  partialOrder: string | null;
  createdAt: string;
};

/**
 * Insert result.
 *
 * A duplicate `callId` is an expected outcome (provider retries), not an error,
 * so it is modelled as data. Returning the existing row lets the service decide
 * whether the earlier attempt still owes the customer a message.
 */
export type CreateRecoveryResult =
  | { created: true; recovery: CallRecovery }
  | { created: false; existing: CallRecovery };

/**
 * Thrown when the generated `recoveryId` already exists. Distinct from a
 * duplicate callId: the caller should generate a new id and retry.
 */
export class RecoveryIdConflictError extends Error {
  constructor(public readonly recoveryId: string) {
    super(`Recovery id already in use: ${recoveryId}`);
    this.name = 'RecoveryIdConflictError';
  }
}

export interface CustomerRepo {
  /** Creates the customer, or returns the existing one for that phone number. */
  upsertByPhone(input: UpsertCustomerInput): Promise<Customer>;
}

export interface CallRecoveryRepo {
  findByCallId(callId: string): Promise<CallRecovery | null>;
  /** @throws {RecoveryIdConflictError} when recoveryId is taken. */
  create(input: CreateRecoveryInput): Promise<CreateRecoveryResult>;
  markNotified(recoveryId: string, notifiedAt: string): Promise<void>;
}

export interface PersistencePort {
  customers: CustomerRepo;
  recoveries: CallRecoveryRepo;
}
