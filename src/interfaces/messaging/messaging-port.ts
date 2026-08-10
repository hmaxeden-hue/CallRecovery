/**
 * Outbound messaging port.
 *
 * Swapping the stub for a real WhatsApp provider (Twilio, Meta Cloud API) must
 * mean one new file implementing this interface plus one line in the wiring —
 * nothing in core/ changes.
 */

import type { MessageTemplate } from '../../core/messages.js';

export type OutboundMessage = {
  /** Recipient in E.164. */
  toPhone: string;
  /**
   * Fully rendered message body (German).
   *
   * WhatsApp only allows free-form text within 24 hours of the customer's last
   * message, and a phone call does not open that window — so a real provider
   * sends `template` and uses this only for logs. It stays the authoritative
   * wording: the stub prints it, and phase 3 (customer replies, window open)
   * will send it verbatim.
   */
  body: string;
  /** Approved template to use for business-initiated delivery. */
  template: MessageTemplate;
  /** Correlation reference for logs and provider metadata. */
  recoveryId: string;
};

/**
 * Why a send failed, in provider-neutral terms.
 *
 * Adapters translate their own error codes into these; core maps them to German
 * labels for the owner. No provider code ever reaches core.
 */
export type MessagingFailureCode =
  | 'invalid_number'
  | 'not_on_whatsapp'
  | 'template_rejected'
  | 'authentication'
  | 'rate_limited'
  | 'provider_unavailable'
  | 'network'
  | 'unknown';

export type MessagingErrorOptions = {
  code: MessagingFailureCode;
  /**
   * Does retrying the identical request stand a chance? This single flag is all
   * core reads: transient failures keep the recovery pending for another
   * attempt, permanent ones hand the customer to a human instead.
   */
  retryable: boolean;
  /** Raw provider code, for logs only. */
  providerCode?: string | number;
  /** HTTP status, for logs only. */
  status?: number;
  /** Honoured by the retry helper when the provider tells us to wait. */
  retryAfterMs?: number;
  cause?: unknown;
};

export class MessagingError extends Error {
  readonly code: MessagingFailureCode;
  readonly retryable: boolean;
  readonly providerCode: string | number | undefined;
  readonly status: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(message: string, options: MessagingErrorOptions) {
    super(message, { cause: options.cause });
    this.name = 'MessagingError';
    this.code = options.code;
    this.retryable = options.retryable;
    this.providerCode = options.providerCode;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/**
 * Classifies any thrown value for the service.
 *
 * An error that is not a MessagingError comes from a bug rather than from the
 * provider, and is treated as transient: a crash mid-send must not be mistaken
 * for "this customer is unreachable" and close the recovery.
 */
export function classifyMessagingError(error: unknown): {
  retryable: boolean;
  code: MessagingFailureCode;
} {
  if (error instanceof MessagingError) {
    return { retryable: error.retryable, code: error.code };
  }
  return { retryable: true, code: 'unknown' };
}

export interface MessagingAdapter {
  sendToCustomer(message: OutboundMessage): Promise<void>;
  sendToOwner(message: OutboundMessage): Promise<void>;
}
