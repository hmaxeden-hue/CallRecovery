/**
 * Request authentication for the Vapi webhook.
 *
 * Two modes, because Vapi setups differ:
 *
 *  - `shared_secret` (default): Vapi echoes back the secret configured on the
 *    server URL in the `x-vapi-secret` header. Plain equality — but constant
 *    time, and over a digest so that the comparison does not leak the secret's
 *    length either.
 *  - `hmac_sha256`: the `x-vapi-signature` header carries an HMAC over the raw
 *    request body. This is why the route must read the body as text before any
 *    JSON parsing — a re-serialized body produces a different digest.
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

import type { VapiSignatureMode } from '../../config.js';

export const SHARED_SECRET_HEADER = 'x-vapi-secret';
export const SIGNATURE_HEADER = 'x-vapi-signature';

export type SignatureVerification = { ok: true } | { ok: false; reason: string };

export type VerifyInput = {
  /** Exact request body as received, unparsed. */
  rawBody: string;
  /** Case-insensitive header lookup, e.g. Hono's `c.req.header`. */
  header: (name: string) => string | undefined;
  secret: string;
  mode: VapiSignatureMode;
};

/**
 * Constant-time comparison of two arbitrary-length strings.
 * Hashing first keeps the timingSafeEqual inputs equal in length, so no length
 * information leaks and the call cannot throw.
 */
function safeEquals(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}

export function verifyVapiRequest(input: VerifyInput): SignatureVerification {
  switch (input.mode) {
    case 'shared_secret': {
      const provided = input.header(SHARED_SECRET_HEADER);
      if (!provided) return { ok: false, reason: `missing ${SHARED_SECRET_HEADER} header` };
      return safeEquals(provided, input.secret)
        ? { ok: true }
        : { ok: false, reason: 'shared secret mismatch' };
    }

    case 'hmac_sha256': {
      const provided = input.header(SIGNATURE_HEADER);
      if (!provided) return { ok: false, reason: `missing ${SIGNATURE_HEADER} header` };

      // Tolerate the common "sha256=<hex>" prefix.
      const signature = provided.startsWith('sha256=') ? provided.slice(7) : provided;
      const expected = createHmac('sha256', input.secret).update(input.rawBody, 'utf8').digest('hex');

      return safeEquals(signature.toLowerCase(), expected)
        ? { ok: true }
        : { ok: false, reason: 'signature mismatch' };
    }

    default: {
      const exhaustive: never = input.mode;
      return { ok: false, reason: `unknown signature mode: ${String(exhaustive)}` };
    }
  }
}
