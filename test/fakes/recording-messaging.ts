/**
 * Messaging fake that records what was sent and can be told to fail.
 * The console-logging stub adapter for local development arrives in step 2.
 */

import type { MessagingAdapter, OutboundMessage } from '../../src/interfaces/messaging/messaging-port.js';

export type RecordedMessage = OutboundMessage & { channel: 'customer' | 'owner' };

export class RecordingMessaging implements MessagingAdapter {
  readonly sent: RecordedMessage[] = [];

  failCustomer: Error | null = null;
  failOwner: Error | null = null;

  async sendToCustomer(message: OutboundMessage): Promise<void> {
    if (this.failCustomer) throw this.failCustomer;
    this.sent.push({ ...message, channel: 'customer' });
  }

  async sendToOwner(message: OutboundMessage): Promise<void> {
    if (this.failOwner) throw this.failOwner;
    this.sent.push({ ...message, channel: 'owner' });
  }

  get customerMessages(): RecordedMessage[] {
    return this.sent.filter((message) => message.channel === 'customer');
  }

  get ownerMessages(): RecordedMessage[] {
    return this.sent.filter((message) => message.channel === 'owner');
  }
}
