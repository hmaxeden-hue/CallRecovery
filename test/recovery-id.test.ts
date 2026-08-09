import { describe, expect, it } from 'vitest';

import {
  RECOVERY_ID_ALPHABET,
  createRecoveryIdFactory,
  generateRecoveryId,
  isRecoveryId,
} from '../src/core/recovery-id.js';

/** Deterministic random source cycling through the given indices. */
function sequence(indices: number[]): (max: number) => number {
  let cursor = 0;
  return () => indices[cursor++ % indices.length] ?? 0;
}

describe('generateRecoveryId', () => {
  it('renders R- plus four alphabet characters', () => {
    const id = generateRecoveryId(sequence([7, 15, 3, 19]));
    expect(id).toBe('R-7F3K');
    expect(isRecoveryId(id)).toBe(true);
  });

  it('never emits the ambiguous characters I, L, O or U', () => {
    expect(RECOVERY_ID_ALPHABET).not.toMatch(/[ILOU]/);

    for (let i = 0; i < 500; i += 1) {
      expect(generateRecoveryId().slice(2)).not.toMatch(/[ILOU]/);
    }
  });

  it('always produces well-formed ids with the real random source', () => {
    for (let i = 0; i < 500; i += 1) {
      expect(isRecoveryId(generateRecoveryId())).toBe(true);
    }
  });

  it('rejects malformed ids', () => {
    expect(isRecoveryId('R-7F3')).toBe(false);
    expect(isRecoveryId('7F3K')).toBe(false);
    expect(isRecoveryId('R-7F3I')).toBe(false);
    expect(isRecoveryId('R-7f3k')).toBe(false);
  });
});

describe('createRecoveryIdFactory', () => {
  it('returns a fresh id on every call', () => {
    const factory = createRecoveryIdFactory(sequence([0, 0, 0, 0, 1, 1, 1, 1]));
    expect(factory()).toBe('R-0000');
    expect(factory()).toBe('R-1111');
  });
});
