/**
 * Short, human-readable recovery references such as "R-7F3K".
 *
 * These get read out on the phone and typed back by customers, so the alphabet
 * is Crockford base32: digits plus uppercase letters without I, L, O and U —
 * the characters that get confused with 1, 0 and each other.
 */

import type { RecoveryIdFactory } from './types.js';

export const RECOVERY_ID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_ID_PREFIX = 'R-';
export const RECOVERY_ID_LENGTH = 4;

/** 32^4 = 1_048_576 possible ids. Collisions are handled by retrying. */
export const RECOVERY_ID_SPACE = RECOVERY_ID_ALPHABET.length ** RECOVERY_ID_LENGTH;

/** Returns an integer in [0, maxExclusive). Injected so tests are deterministic. */
export type RandomSource = (maxExclusive: number) => number;

export const mathRandomSource: RandomSource = (maxExclusive) =>
  Math.floor(Math.random() * maxExclusive);

export function generateRecoveryId(random: RandomSource = mathRandomSource): string {
  let id = '';
  for (let i = 0; i < RECOVERY_ID_LENGTH; i += 1) {
    id += RECOVERY_ID_ALPHABET[random(RECOVERY_ID_ALPHABET.length)] ?? '0';
  }
  return `${RECOVERY_ID_PREFIX}${id}`;
}

export function createRecoveryIdFactory(random: RandomSource = mathRandomSource): RecoveryIdFactory {
  return () => generateRecoveryId(random);
}

const RECOVERY_ID_PATTERN = new RegExp(
  `^${RECOVERY_ID_PREFIX}[${RECOVERY_ID_ALPHABET}]{${RECOVERY_ID_LENGTH}}$`,
);

export function isRecoveryId(value: string): boolean {
  return RECOVERY_ID_PATTERN.test(value);
}
