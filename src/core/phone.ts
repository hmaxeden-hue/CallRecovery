/**
 * Phone number handling. Pure, no dependencies.
 *
 * We do not pull in a full E.164 library: phase 1 only needs to answer
 * "can we send a WhatsApp message to this number?", and a strict shape check
 * plus a placeholder blocklist answers that.
 */

/** E.164: leading +, country code 1-9, 7-15 digits total. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Values telephony providers use when the caller withheld their number.
 * These arrive in the `fromPhone` field instead of a number.
 */
const PLACEHOLDER_VALUES = new Set([
  'anonymous',
  'unknown',
  'private',
  'restricted',
  'withheld',
  'unavailable',
  'blocked',
  'sip',
]);

/**
 * Characters humans and dialers sprinkle into numbers: whitespace, brackets,
 * dots, slashes, and the ASCII plus unicode dash family (‐-―).
 */
const SEPARATOR_PATTERN = /[\s()./\- ‐-―]/g;

/**
 * Bring a raw number into E.164, or return null when it cannot be used.
 *
 * Handles the two shapes we actually see in the wild: separators inside an
 * otherwise valid number, and the international "00" prefix instead of "+".
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;
  if (PLACEHOLDER_VALUES.has(trimmed.toLowerCase())) return null;

  let candidate = trimmed.replace(SEPARATOR_PATTERN, '');
  if (candidate.startsWith('00')) {
    candidate = `+${candidate.slice(2)}`;
  }

  return E164_PATTERN.test(candidate) ? candidate : null;
}

/** True when we can reach this number — i.e. it normalizes to valid E.164. */
export function isUsablePhone(raw: string | null | undefined): boolean {
  return normalizePhone(raw) !== null;
}
