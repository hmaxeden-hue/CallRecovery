/**
 * Shared plumbing for HTTP-based WhatsApp providers.
 *
 * Everything that is the same for Twilio and Meta lives here: timeouts,
 * turning network faults into MessagingError, bounded retries, and sanitising
 * template variables. A concrete provider supplies only two functions — how to
 * build its request, and how to read its failure response.
 *
 * Composition rather than inheritance: a provider adapter *has* one of these,
 * so a second provider cannot accidentally change behaviour for the first.
 */

import { silentLogger, type Logger } from '../../core/types.js';
import { MessagingError, type MessagingAdapter, type OutboundMessage } from './messaging-port.js';
import { DEFAULT_RETRY, withRetry, type RetryOptions } from './retry.js';

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type ProviderRequest = {
  url: string;
  headers: Record<string, string>;
  /** Already-encoded request body. */
  body: string;
};

export type WhatsappHttpDeps = {
  /** Human-readable provider name, used in logs and error messages. */
  providerName: string;
  buildRequest: (message: OutboundMessage) => ProviderRequest;
  /** Translates a non-OK response into a provider-neutral MessagingError. */
  interpretFailure: (input: {
    status: number;
    bodyText: string;
    headers: Headers;
  }) => MessagingError;
  fetch?: FetchLike;
  retry?: Partial<RetryOptions>;
  timeoutMs?: number;
  logger?: Logger;
};

export const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * WhatsApp rejects template parameters containing newlines or tabs, and caps
 * their length. Sanitising centrally means no provider adapter can forget it,
 * and a stray line break in a customer name cannot fail a send.
 */
export const MAX_VARIABLE_LENGTH = 1024;

export function sanitizeTemplateVariable(value: string): string {
  const flattened = value.replace(/[\n\r\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return flattened.length > MAX_VARIABLE_LENGTH
    ? flattened.slice(0, MAX_VARIABLE_LENGTH - 1) + '…'
    : flattened;
}

/** Reads the Retry-After header (seconds, per RFC 9110) as milliseconds. */
export function parseRetryAfter(headers: Headers): number | undefined {
  const value = headers.get('retry-after');
  if (!value) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);

  const date = new Date(value).getTime();
  if (Number.isNaN(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export class WhatsappHttpMessaging implements MessagingAdapter {
  private readonly fetch: FetchLike;
  private readonly logger: Logger;
  private readonly timeoutMs: number;
  private readonly retry: RetryOptions;

  constructor(private readonly deps: WhatsappHttpDeps) {
    this.fetch = deps.fetch ?? ((url, init) => globalThis.fetch(url, init));
    this.logger = deps.logger ?? silentLogger;
    this.timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retry = { ...DEFAULT_RETRY, ...deps.retry };
  }

  async sendToCustomer(message: OutboundMessage): Promise<void> {
    await this.send('customer', message);
  }

  async sendToOwner(message: OutboundMessage): Promise<void> {
    await this.send('owner', message);
  }

  private async send(channel: 'customer' | 'owner', message: OutboundMessage): Promise<void> {
    const sanitized: OutboundMessage = {
      ...message,
      template: {
        ...message.template,
        variables: message.template.variables.map(sanitizeTemplateVariable),
      },
    };

    await withRetry(() => this.attempt(sanitized), {
      ...this.retry,
      onRetry: ({ attempt, delayMs, error }) => {
        this.logger.warn('whatsapp send retry', {
          provider: this.deps.providerName,
          channel,
          recoveryId: message.recoveryId,
          attempt,
          delayMs,
          code: error.code,
        });
      },
    });

    this.logger.info('whatsapp message sent', {
      provider: this.deps.providerName,
      channel,
      recoveryId: message.recoveryId,
      template: message.template.key,
    });
  }

  private async attempt(message: OutboundMessage): Promise<void> {
    const request = this.deps.buildRequest(message);

    let response: Response;
    try {
      response = await this.fetch(request.url, {
        method: 'POST',
        headers: request.headers,
        body: request.body,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      // DNS failure, connection reset, timeout — always worth another attempt.
      const timedOut = cause instanceof Error && cause.name === 'TimeoutError';
      throw new MessagingError(
        `${this.deps.providerName} request failed: ${timedOut ? 'timeout' : describe(cause)}`,
        { code: 'network', retryable: true, cause },
      );
    }

    if (response.ok) return;

    // Read the body before interpreting: provider error details live in it, and
    // a body left unread keeps the connection from being reused.
    const bodyText = await response.text().catch(() => '');
    throw this.deps.interpretFailure({
      status: response.status,
      bodyText,
      headers: response.headers,
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
