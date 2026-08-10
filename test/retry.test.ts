import { describe, expect, it, vi } from 'vitest';

import { MessagingError } from '../src/interfaces/messaging/messaging-port.js';
import { backoffDelay, withRetry } from '../src/interfaces/messaging/retry.js';

function transient(message = 'boom'): MessagingError {
  return new MessagingError(message, { code: 'provider_unavailable', retryable: true });
}

function permanent(message = 'nope'): MessagingError {
  return new MessagingError(message, { code: 'not_on_whatsapp', retryable: false });
}

/** Collects sleeps instead of performing them, so tests are instant. */
function fakeSleep() {
  const slept: number[] = [];
  return { slept, sleep: async (ms: number) => void slept.push(ms) };
}

const options = (extra: Partial<Parameters<typeof withRetry>[1]> = {}) => ({
  attempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 1_000,
  random: () => 0, // lower bound of the jitter window: fully deterministic
  ...extra,
});

describe('withRetry', () => {
  it('returns the first successful result without sleeping', async () => {
    const { slept, sleep } = fakeSleep();
    const operation = vi.fn(async () => 'ok');

    await expect(withRetry(operation, options({ sleep }))).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('retries a transient failure and succeeds', async () => {
    const { slept, sleep } = fakeSleep();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, options({ sleep }))).resolves.toBe('ok');
    expect(operation).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([50]); // 100 * 2^0, jitter at the 0.5 lower bound
  });

  it('gives up after the configured number of attempts', async () => {
    const { slept, sleep } = fakeSleep();
    const operation = vi.fn(async () => {
      throw transient('still down');
    });

    await expect(withRetry(operation, options({ sleep }))).rejects.toThrow('still down');
    expect(operation).toHaveBeenCalledTimes(3);
    expect(slept).toEqual([50, 100]); // no sleep after the final attempt
  });

  it('does not retry a permanent failure', async () => {
    const { slept, sleep } = fakeSleep();
    const operation = vi.fn(async () => {
      throw permanent();
    });

    await expect(withRetry(operation, options({ sleep }))).rejects.toBeInstanceOf(MessagingError);
    expect(operation).toHaveBeenCalledTimes(1);
    expect(slept).toEqual([]);
  });

  it('does not retry an error that is not a MessagingError', async () => {
    // A bug inside the adapter, not a provider hiccup. Repeating it three times
    // only delays the report.
    const operation = vi.fn(async () => {
      throw new TypeError('undefined is not a function');
    });

    await expect(withRetry(operation, options())).rejects.toThrow(TypeError);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it('honours a Retry-After hint from the provider over its own curve', async () => {
    const { slept, sleep } = fakeSleep();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new MessagingError('slow down', {
          code: 'rate_limited',
          retryable: true,
          retryAfterMs: 5_000,
        }),
      )
      .mockResolvedValueOnce('ok');

    await expect(withRetry(operation, options({ sleep }))).resolves.toBe('ok');
    expect(slept).toEqual([5_000]);
  });

  it('reports each retry to the caller for logging', async () => {
    const { sleep } = fakeSleep();
    const onRetry = vi.fn();
    const operation = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(transient())
      .mockResolvedValueOnce('ok');

    await withRetry(operation, options({ sleep, onRetry }));

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1, delayMs: 50 });
  });
});

describe('backoffDelay', () => {
  const base = { baseDelayMs: 100, maxDelayMs: 1_000 };

  it('grows exponentially', () => {
    const random = () => 1; // upper bound of the jitter window
    expect(backoffDelay(1, { ...base, random })).toBe(100);
    expect(backoffDelay(2, { ...base, random })).toBe(200);
    expect(backoffDelay(3, { ...base, random })).toBe(400);
  });

  it('is capped', () => {
    expect(backoffDelay(10, { ...base, random: () => 1 })).toBe(1_000);
  });

  it('jitters within [delay/2, delay] so retries do not align', () => {
    for (const value of [0, 0.25, 0.5, 0.75, 0.999]) {
      const delay = backoffDelay(2, { ...base, random: () => value });
      expect(delay).toBeGreaterThanOrEqual(100);
      expect(delay).toBeLessThanOrEqual(200);
    }
  });
});
