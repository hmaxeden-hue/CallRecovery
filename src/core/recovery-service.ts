/**
 * The recovery decision logic and the orchestration around it.
 *
 * Two layers on purpose:
 *
 *  - `decide()` is pure. Given one call event it answers "does this need a
 *    recovery, and why?" — no I/O, no knowledge of what happened before.
 *  - `RecoveryService.handle()` orchestrates decide -> persist -> notify. It
 *    can only be idempotent because it sees repository state, which is exactly
 *    why that concern lives here and not in `decide()`.
 *
 * Only ports are imported. No SQL, no HTTP, no fetch.
 */

import { customerMessage, ownerMessage } from './messages.js';
import { normalizePhone } from './phone.js';
import {
  RecoveryIdConflictError,
  type PersistencePort,
} from '../interfaces/persistence/persistence-port.js';
import type { MessagingAdapter } from '../interfaces/messaging/messaging-port.js';
import {
  silentLogger,
  type CallRecovery,
  type Clock,
  type HandleResult,
  type IncomingCallEvent,
  type Logger,
  type RecoveryDecision,
  type RecoveryIdFactory,
  type RecoveryReason,
} from './types.js';

/** How many fresh ids we try before giving up on a colliding recovery id. */
const MAX_RECOVERY_ID_ATTEMPTS = 5;

/**
 * Is there partial order data worth calling "incomplete order"?
 *
 * Empty containers count as absent: an agent that captured nothing hands back
 * `{}` or `[]` just as often as it hands back nothing at all, and telling a
 * customer their order is "not yet complete" when we hold zero items reads as
 * a mistake on our side.
 */
export function hasPartialOrder(partialOrder: unknown): boolean {
  if (partialOrder === undefined || partialOrder === null) return false;
  if (typeof partialOrder === 'string') return partialOrder.trim() !== '';
  if (Array.isArray(partialOrder)) return partialOrder.length > 0;
  if (typeof partialOrder === 'object') return Object.keys(partialOrder).length > 0;
  return true;
}

/** Named so the heuristic can be changed and tested in one place. */
export function deriveReason(event: IncomingCallEvent): RecoveryReason {
  return hasPartialOrder(event.partialOrder) ? 'incomplete_order' : 'missed_call';
}

/**
 * Pure decision step: recovery-worthy calls are those that ended without a
 * completed order and left us a number we can actually reach.
 */
export function decide(event: IncomingCallEvent): RecoveryDecision {
  if (event.orderCompleted) {
    return { action: 'skip', skipReason: 'order_completed' };
  }

  const phone = normalizePhone(event.fromPhone);
  if (phone === null) {
    return { action: 'skip', skipReason: 'unusable_phone' };
  }

  return { action: 'recover', reason: deriveReason(event), phone };
}

export type RecoveryServiceDeps = {
  persistence: PersistencePort;
  messaging: MessagingAdapter;
  now: Clock;
  generateRecoveryId: RecoveryIdFactory;
  /** Where owner notifications go, in E.164. */
  ownerPhone: string;
  /** IANA time zone used to render times for the owner. */
  timeZone: string;
  logger?: Logger;
};

export class RecoveryService {
  private readonly deps: RecoveryServiceDeps;
  private readonly logger: Logger;

  constructor(deps: RecoveryServiceDeps) {
    this.deps = deps;
    this.logger = deps.logger ?? silentLogger;
  }

  async handle(event: IncomingCallEvent): Promise<HandleResult> {
    const decision = decide(event);

    if (decision.action === 'skip') {
      this.logger.info('call skipped', {
        callId: event.callId,
        skipReason: decision.skipReason,
      });
      return { outcome: 'skipped', decision };
    }

    const customer = await this.deps.persistence.customers.upsertByPhone({
      phone: decision.phone,
      name: event.callerName ?? null,
    });

    const { recovery, isNew } = await this.createOrLoadRecovery(event, decision, customer.id);

    // Idempotency: a recovery that already reached the customer is done. One
    // still sitting in `pending` means the previous attempt failed before the
    // message went out, so a provider retry is our chance to finish the job.
    if (!isNew && recovery.status !== 'pending') {
      this.logger.info('duplicate call event ignored', {
        callId: event.callId,
        recoveryId: recovery.recoveryId,
        status: recovery.status,
      });
      return { outcome: 'duplicate', recoveryId: recovery.recoveryId, status: recovery.status };
    }

    const retriedPending = !isNew;

    try {
      await this.deps.messaging.sendToCustomer({
        toPhone: decision.phone,
        body: customerMessage({ reason: recovery.reason, recoveryId: recovery.recoveryId }),
        recoveryId: recovery.recoveryId,
      });
    } catch (error) {
      // Stays `pending`, so the next provider retry picks it up again.
      const message = errorMessage(error);
      this.logger.error('customer notification failed', {
        callId: event.callId,
        recoveryId: recovery.recoveryId,
        error: message,
      });
      return { outcome: 'send_failed', recoveryId: recovery.recoveryId, error: message };
    }

    // The customer message is the revenue-relevant one. A failing owner
    // notification is worth logging, never worth discarding a reached customer.
    let ownerNotified = true;
    try {
      await this.deps.messaging.sendToOwner({
        toPhone: this.deps.ownerPhone,
        body: ownerMessage({
          phone: decision.phone,
          name: customer.name,
          reason: recovery.reason,
          recoveryId: recovery.recoveryId,
          at: event.endedAt,
          timeZone: this.deps.timeZone,
        }),
        recoveryId: recovery.recoveryId,
      });
    } catch (error) {
      ownerNotified = false;
      this.logger.error('owner notification failed', {
        callId: event.callId,
        recoveryId: recovery.recoveryId,
        error: errorMessage(error),
      });
    }

    await this.deps.persistence.recoveries.markNotified(recovery.recoveryId, this.deps.now());

    this.logger.info('recovery notified', {
      callId: event.callId,
      recoveryId: recovery.recoveryId,
      reason: recovery.reason,
      retriedPending,
      ownerNotified,
    });

    return {
      outcome: 'notified',
      recoveryId: recovery.recoveryId,
      reason: recovery.reason,
      retriedPending,
      ownerNotified,
    };
  }

  /**
   * Inserts the recovery, or returns the one a previous delivery of the same
   * call already created. The unique constraint on `callId` — not the lookup —
   * is what makes this safe against two retries arriving at once.
   */
  private async createOrLoadRecovery(
    event: IncomingCallEvent,
    decision: Extract<RecoveryDecision, { action: 'recover' }>,
    customerId: string,
  ): Promise<{ recovery: CallRecovery; isNew: boolean }> {
    const partialOrder = hasPartialOrder(event.partialOrder)
      ? JSON.stringify(event.partialOrder)
      : null;

    let lastConflict: RecoveryIdConflictError | null = null;

    for (let attempt = 0; attempt < MAX_RECOVERY_ID_ATTEMPTS; attempt += 1) {
      const recoveryId = this.deps.generateRecoveryId();
      try {
        const result = await this.deps.persistence.recoveries.create({
          recoveryId,
          customerId,
          callId: event.callId,
          reason: decision.reason,
          partialOrder,
          createdAt: this.deps.now(),
        });

        return result.created
          ? { recovery: result.recovery, isNew: true }
          : { recovery: result.existing, isNew: false };
      } catch (error) {
        if (!(error instanceof RecoveryIdConflictError)) throw error;
        lastConflict = error;
        this.logger.warn('recovery id collision, retrying', { recoveryId, attempt });
      }
    }

    throw new Error(
      `Could not allocate a free recovery id after ${MAX_RECOVERY_ID_ATTEMPTS} attempts` +
        (lastConflict ? ` (last conflict: ${lastConflict.recoveryId})` : ''),
    );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
