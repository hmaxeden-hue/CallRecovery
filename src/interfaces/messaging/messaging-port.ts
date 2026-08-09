/**
 * Outbound messaging port.
 *
 * Swapping the stub for a real WhatsApp provider (Twilio, Meta Cloud API) must
 * mean one new file implementing this interface plus one line in the wiring —
 * nothing in core/ changes.
 */

export type OutboundMessage = {
  /** Recipient in E.164. */
  toPhone: string;
  /** Fully rendered message body (German). */
  body: string;
  /** Correlation reference for logs and provider metadata. */
  recoveryId: string;
};

export interface MessagingAdapter {
  sendToCustomer(message: OutboundMessage): Promise<void>;
  sendToOwner(message: OutboundMessage): Promise<void>;
}
