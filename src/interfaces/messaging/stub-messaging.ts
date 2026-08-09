/**
 * Default messaging adapter for local development: nothing leaves the machine,
 * every message is printed in full so the German wording can be proof-read.
 *
 * A real provider (Twilio, Meta Cloud API) is a new file implementing the same
 * interface plus one line in app.ts — no change anywhere in core/.
 */

import type { MessagingAdapter, OutboundMessage } from './messaging-port.js';

export type StubMessagingOptions = {
  /** Where output goes. Overridable so tests can capture it. */
  write?: (line: string) => void;
};

export class StubMessaging implements MessagingAdapter {
  private readonly write: (line: string) => void;

  constructor(options: StubMessagingOptions = {}) {
    this.write = options.write ?? ((line) => console.log(line));
  }

  async sendToCustomer(message: OutboundMessage): Promise<void> {
    this.print('customer', message);
  }

  async sendToOwner(message: OutboundMessage): Promise<void> {
    this.print('owner', message);
  }

  private print(channel: 'customer' | 'owner', message: OutboundMessage): void {
    this.write(
      `[whatsapp:stub] channel=${channel} to=${message.toPhone} ref=${message.recoveryId}\n` +
        `  ${message.body}`,
    );
  }
}
