/**
 * Bounded retry with exponential backoff and jitter, for provider adapters.
 *
 * Only a MessagingError marked `retryable` is retried. Anything else is a bug
 * inside the adapter rather than a provider hiccup, and repeating it three
 * times only delays the report. (The service classifies more leniently — see
 * classifyMessagingError — because there an unexpected throw must not be
 * mistaken for "this customer is unreachable".)
 *
 * Sleep and randomness are injected so tests run instantly and deterministically.
 */

import { MessagingError } from './messaging-port.js';

export type RetryAttemptInfo = {
  /** 1-based number of the attempt that just failed. */
  attempt: number;
  delayMs: number;
  error: MessagingError;
};

export type RetryOptions = {
  /** Total attempts, including the first. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Returns [0, 1). Injected for deterministic tests. */
  random?: () => number;
  onRetry?: (info: RetryAttemptInfo) => void;
};

export const DEFAULT_RETRY: Required<Pick<RetryOptions, 'attempts' | 'baseDelayMs' | 'maxDelayMs'>> =
  {
    attempts: 3,
    baseDelayMs: 250,
    maxDelayMs: 4_000,
  };

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Full jitter: a random point in [delay/2, delay). Without it, a provider
 * outage makes every pending call retry in lockstep and hit the recovering
 * service simultaneously.
 */
export function backoffDelay(
  attempt: number,
  options: { baseDelayMs: number; maxDelayMs: number; random: () => number },
): number {
  const exponential = options.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, options.maxDelayMs);
  return Math.round(capped * (0.5 + 0.5 * options.random()));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  const maxDelayMs = options.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;

  let lastError: MessagingError | undefined;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!(error instanceof MessagingError) || !error.retryable) throw error;

      lastError = error;
      if (attempt === attempts) break;

      // A provider that tells us how long to wait knows better than our curve.
      const delayMs =
        error.retryAfterMs ??
        backoffDelay(attempt, { baseDelayMs: options.baseDelayMs, maxDelayMs, random });

      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw lastError ?? new Error('withRetry: no attempt was made');
}
