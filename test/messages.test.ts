import { describe, expect, it } from 'vitest';

import {
  customerMessage,
  customerTemplate,
  failureLabel,
  formatLocalTime,
  ownerMessage,
  ownerTemplate,
  ownerUndeliverableMessage,
  ownerUndeliverableTemplate,
  reasonLabel,
  type MessageTemplate,
} from '../src/core/messages.js';
import type { MessagingFailureCode } from '../src/interfaces/messaging/messaging-port.js';

const TZ = 'Europe/Zurich';

describe('customerMessage', () => {
  it('renders the missed-call text with the reference', () => {
    expect(customerMessage({ reason: 'missed_call', recoveryId: 'R-7F3K' })).toBe(
      'Guten Tag, wir haben Ihren Anruf leider verpasst. ' +
        'Möchten Sie Ihre Bestellung schnell per WhatsApp aufgeben? ' +
        'Antworten Sie einfach direkt hier – wir kümmern uns darum. ' +
        'Ihre Referenz: R-7F3K. Vielen Dank!',
    );
  });

  it('renders the incomplete-order text with the reference', () => {
    expect(customerMessage({ reason: 'incomplete_order', recoveryId: 'R-9QB2' })).toBe(
      'Guten Tag, Ihre Bestellung mit der Referenz R-9QB2 ist noch nicht abgeschlossen. ' +
        'Antworten Sie hier, um sie fertigzustellen. Vielen Dank!',
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

  it('never ends on a variable — WhatsApp rejects such templates', () => {
    for (const reason of ['missed_call', 'incomplete_order'] as const) {
      expect(customerMessage({ reason, recoveryId: 'R-7F3K' }).endsWith('R-7F3K')).toBe(false);
    }
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

  it('lists number, name, reason, reference and local time', () => {
    expect(ownerMessage({ ...base, name: 'Meier' })).toBe(
      '⚠️ Mögliche verlorene Bestellung\n' +
        'Nummer: +41791234567\n' +
        'Name: Meier\n' +
        'Grund: Verpasster Anruf\n' +
        'Referenz: R-7F3K\n' +
        'Zeit: 14:32 Uhr',
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

describe('ownerUndeliverableMessage', () => {
  it('says what failed and what to do about it', () => {
    expect(
      ownerUndeliverableMessage({
        phone: '+41791234567',
        recoveryId: 'R-7F3K',
        code: 'not_on_whatsapp',
      }),
    ).toBe(
      '⚠️ WhatsApp nicht zustellbar\n' +
        'Nummer: +41791234567\n' +
        'Referenz: R-7F3K\n' +
        'Fehler: Nummer nicht bei WhatsApp registriert\n' +
        'Bitte den Kunden manuell zurückrufen.',
    );
  });

  it('has a German label for every failure code', () => {
    const codes: MessagingFailureCode[] = [
      'invalid_number',
      'not_on_whatsapp',
      'template_rejected',
      'authentication',
      'rate_limited',
      'provider_unavailable',
      'network',
      'unknown',
    ];

    for (const code of codes) {
      expect(failureLabel(code)).toMatch(/\S/);
      expect(failureLabel(code)).not.toMatch(/undefined/);
    }
  });
});

describe('templates', () => {
  const ownerContext = {
    phone: '+41791234567',
    name: 'Meier',
    reason: 'missed_call' as const,
    recoveryId: 'R-7F3K',
    at: '2026-08-09T12:32:00.000Z',
    timeZone: TZ,
  };

  it('picks the template that matches the reason', () => {
    expect(customerTemplate({ reason: 'missed_call', recoveryId: 'R-7F3K' })).toEqual({
      key: 'customer_missed_call',
      language: 'de',
      variables: ['R-7F3K'],
    });
    expect(customerTemplate({ reason: 'incomplete_order', recoveryId: 'R-7F3K' }).key).toBe(
      'customer_incomplete_order',
    );
  });

  it('fills the owner template in the approved variable order', () => {
    expect(ownerTemplate(ownerContext)).toEqual({
      key: 'owner_lost_order',
      language: 'de',
      variables: ['+41791234567', 'Meier', 'Verpasster Anruf', 'R-7F3K', '14:32'],
    });
  });

  it('fills the undeliverable template', () => {
    expect(
      ownerUndeliverableTemplate({
        phone: '+41791234567',
        recoveryId: 'R-7F3K',
        code: 'invalid_number',
      }),
    ).toEqual({
      key: 'owner_undeliverable',
      language: 'de',
      variables: ['+41791234567', 'R-7F3K', 'Ungültige Rufnummer'],
    });
  });

  /**
   * The rendered text and the template variables are two views of the same
   * message. If a wording change drops a value from one of them, the real
   * WhatsApp and the stub output would disagree — this catches that.
   */
  it('keeps every template variable present in the rendered text', () => {
    const pairs: Array<[MessageTemplate, string]> = [
      [
        customerTemplate({ reason: 'missed_call', recoveryId: 'R-7F3K' }),
        customerMessage({ reason: 'missed_call', recoveryId: 'R-7F3K' }),
      ],
      [
        customerTemplate({ reason: 'incomplete_order', recoveryId: 'R-7F3K' }),
        customerMessage({ reason: 'incomplete_order', recoveryId: 'R-7F3K' }),
      ],
      [ownerTemplate(ownerContext), ownerMessage(ownerContext)],
      [
        ownerUndeliverableTemplate({
          phone: '+41791234567',
          recoveryId: 'R-7F3K',
          code: 'not_on_whatsapp',
        }),
        ownerUndeliverableMessage({
          phone: '+41791234567',
          recoveryId: 'R-7F3K',
          code: 'not_on_whatsapp',
        }),
      ],
    ];

    for (const [template, text] of pairs) {
      for (const variable of template.variables) {
        expect(text).toContain(variable);
      }
    }
  });

  it('never puts a newline into a variable — WhatsApp rejects those', () => {
    const templates = [
      customerTemplate({ reason: 'missed_call', recoveryId: 'R-7F3K' }),
      ownerTemplate(ownerContext),
      ownerUndeliverableTemplate({ phone: '+41791234567', recoveryId: 'R-7F3K', code: 'unknown' }),
    ];

    for (const template of templates) {
      for (const variable of template.variables) {
        expect(variable).not.toMatch(/[\n\r\t]/);
      }
    }
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
