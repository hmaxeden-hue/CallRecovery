import { describe, expect, it } from 'vitest';

import {
  customerMessage,
  formatLocalTime,
  ownerMessage,
  reasonLabel,
} from '../src/core/messages.js';

const TZ = 'Europe/Zurich';

describe('customerMessage', () => {
  it('renders the missed-call text with the reference', () => {
    expect(customerMessage({ reason: 'missed_call', recoveryId: 'R-7F3K' })).toBe(
      'Guten Tag, wir haben Ihren Anruf leider verpasst. ' +
        'Möchten Sie Ihre Bestellung schnell per WhatsApp aufgeben? ' +
        'Antworten Sie einfach direkt hier — wir kümmern uns darum. ' +
        'Ihre Referenz: R-7F3K.',
    );
  });

  it('renders the incomplete-order text with the reference', () => {
    expect(customerMessage({ reason: 'incomplete_order', recoveryId: 'R-9QB2' })).toBe(
      'Guten Tag, Ihre Bestellung ist noch nicht abgeschlossen. ' +
        'Antworten Sie hier, um sie fertigzustellen. ' +
        'Ihre Referenz: R-9QB2.',
    );
  });

  it('uses the Sie form and no emoji, for both reasons', () => {
    for (const reason of ['missed_call', 'incomplete_order'] as const) {
      const text = customerMessage({ reason, recoveryId: 'R-7F3K' });
      expect(text).toMatch(/\bSie\b/);
      expect(text).not.toMatch(/\bdu\b|\bDu\b|\bdein/i);
      expect(text).not.toMatch(/\p{Extended_Pictographic}/u);
    }
  });

  it('never addresses the customer by name', () => {
    const text = customerMessage({ reason: 'incomplete_order', recoveryId: 'R-7F3K' });
    expect(text).not.toMatch(/Herr|Frau/);
    expect(text.startsWith('Guten Tag,')).toBe(true);
  });
});

describe('ownerMessage', () => {
  const base = {
    phone: '+41791234567',
    reason: 'missed_call' as const,
    recoveryId: 'R-7F3K',
    at: '2026-08-09T12:32:00.000Z',
    timeZone: TZ,
  };

  it('includes number, name, reason, reference and local time', () => {
    expect(ownerMessage({ ...base, name: 'Meier' })).toBe(
      '⚠️ Mögliche verlorene Bestellung — Nr.: +41791234567 · Name: Meier · ' +
        'Grund: Verpasster Anruf · Ref: R-7F3K · Zeit: 14:32.',
    );
  });

  it('falls back to "unbekannt" when no name was captured', () => {
    expect(ownerMessage({ ...base, name: null })).toContain('Name: unbekannt');
    expect(ownerMessage({ ...base, name: '   ' })).toContain('Name: unbekannt');
    expect(ownerMessage(base)).toContain('Name: unbekannt');
  });

  it('labels an incomplete order', () => {
    expect(ownerMessage({ ...base, reason: 'incomplete_order' })).toContain(
      'Grund: Unvollständige Bestellung',
    );
  });
});

describe('formatLocalTime', () => {
  it('converts UTC to the local wall-clock time the owner reads', () => {
    expect(formatLocalTime('2026-08-09T12:32:00.000Z', TZ)).toBe('14:32'); // CEST
    expect(formatLocalTime('2026-01-09T12:32:00.000Z', TZ)).toBe('13:32'); // CET
  });

  it('degrades gracefully on an unparsable timestamp', () => {
    expect(formatLocalTime('not-a-date', TZ)).toBe('unbekannt');
  });
});

describe('reasonLabel', () => {
  it('maps both reasons to German labels', () => {
    expect(reasonLabel('missed_call')).toBe('Verpasster Anruf');
    expect(reasonLabel('incomplete_order')).toBe('Unvollständige Bestellung');
  });
});
