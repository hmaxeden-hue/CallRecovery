import { describe, expect, it } from 'vitest';

import { isUsablePhone, normalizePhone } from '../src/core/phone.js';

describe('normalizePhone', () => {
  it('keeps a clean E.164 number', () => {
    expect(normalizePhone('+41791234567')).toBe('+41791234567');
  });

  it('strips separators humans and dialers add', () => {
    expect(normalizePhone(' +41 79 123 45 67 ')).toBe('+41791234567');
    expect(normalizePhone('+41 (79) 123-45.67')).toBe('+41791234567');
  });

  it('converts the international 00 prefix to +', () => {
    expect(normalizePhone('0041791234567')).toBe('+41791234567');
  });

  it('rejects national numbers without a country code', () => {
    expect(normalizePhone('0791234567')).toBeNull();
  });

  it('rejects withheld-caller placeholders', () => {
    for (const value of ['anonymous', 'Anonymous', 'unknown', 'private', 'restricted']) {
      expect(normalizePhone(value)).toBeNull();
    }
  });

  it('rejects empty, missing and malformed values', () => {
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone('   ')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone(undefined)).toBeNull();
    expect(normalizePhone('+0791234567')).toBeNull(); // country code may not start with 0
    expect(normalizePhone('+4179')).toBeNull(); // too short
    expect(normalizePhone('+4179123456789012')).toBeNull(); // too long
    expect(normalizePhone('+4179123abc')).toBeNull();
  });
});

describe('isUsablePhone', () => {
  it('mirrors normalizePhone', () => {
    expect(isUsablePhone('+41791234567')).toBe(true);
    expect(isUsablePhone('anonymous')).toBe(false);
  });
});
