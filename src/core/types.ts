/**
 * Domain types for the missed-call recovery loop.
 *
 * This file is the contract between the core decision logic and every adapter.
 * It must stay free of any transport, storage or vendor concern.
 */

import type { MessagingFailureCode } from '../interfaces/messaging/messaging-port.js';

/**
 * Normalized end-of-call event. Every intake adapter (Vapi webhook today,
 * anything else later) maps its raw payload onto exactly this shape.
 */
export type IncomingCallEvent = {
  /** Provider call id — the idempotency key against webhook retries. */
  callId: string;
  /** Caller number, expected in E.164 (e.g. "+41791234567"). */
  fromPhone: string;
  /** Number that was dialed. */
  toPhone: string;
  /** ISO timestamp. */
  startedAt: string;
  /** ISO timestamp. */
  endedAt: string;
  /** Provider-specific, e.g. "customer-hung-up" | "no-answer" | "voicemail". */
  endedReason: string;
  /** Did the voice agent close a complete order? */
  orderCompleted: boolean;
  /** Caller name, if the agent captured one. */
  callerName?: string;
  /** Partially captured order data. Stored raw, never interpreted in phase 1. */
  partialOrder?: unknown;
};

export type RecoveryReason = 'missed_call' | 'incomplete_order';

export type RecoveryStatus = 'pending' | 'notified' | 'resumed' | 'closed';

export type SkipReason = 'order_completed' | 'unusable_phone';

/**
 * Outcome of the pure decision step: does this call need a recovery, and why?
 *
 * The recover branch carries the normalized phone number so that the number we
 * validated is provably the number we persist and message.
 */
export type RecoveryDecision =
  | { action: 'skip'; skipReason: SkipReason }
  | { action: 'recover'; reason: RecoveryReason; phone: string };

export type Customer = {
  id: string;
  /** E.164 */
  phone: string;
  name: string | null;
  createdAt: string;
};

export type CallRecovery = {
  /** Short, human-readable reference, e.g. "R-7F3K". */
  recoveryId: string;
  customerId: string;
  callId: string;
  reason: RecoveryReason;
  status: RecoveryStatus;
  /** JSON string of the raw partial order, or null. */
  partialOrder: string | null;
  createdAt: string;
  notifiedAt: string | null;
};

/**
 * Result of handling one incoming call event.
 *
 * `send_failed` is deliberately a returned value and not an exception: the HTTP
 * adapter turns it into a 5xx so the provider retries, while a local simulation
 * script can just print it.
 */
export type HandleResult =
  | { outcome: 'skipped'; decision: RecoveryDecision }
  | { outcome: 'duplicate'; recoveryId: string; status: RecoveryStatus }
  | {
      outcome: 'notified';
      recoveryId: string;
      reason: RecoveryReason;
      /** True when this was a retry of a recovery left in `pending`. */
      retriedPending: boolean;
      /** False when the customer was reached but the owner notification failed. */
      ownerNotified: boolean;
    }
  /** Temporary failure: the recovery stays `pending` and a retry will finish it. */
  | { outcome: 'send_failed'; recoveryId: string; error: string }
  /**
   * Permanent failure: this customer cannot be reached on WhatsApp at all.
   * Retrying is pointless, so the recovery is closed and the owner is asked to
   * call back by hand.
   */
  | {
      outcome: 'send_rejected';
      recoveryId: string;
      code: MessagingFailureCode;
      /** False when even the fallback notification to the owner failed. */
      ownerNotified: boolean;
      error: string;
    };

/** Injected clock. Returns an ISO timestamp. */
export type Clock = () => string;

/** Injected id factory. Returns a fresh recovery id such as "R-7F3K". */
export type RecoveryIdFactory = () => string;

/** Minimal logging port so core never reaches for console directly. */
export type Logger = {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
};

export const silentLogger: Logger = {
  info: () => {},
  warn: () => {},
  error: () => {},
};
