/**
 * German message templates. Pure functions of the form (ctx) => string, so
 * every wording change can be tested without a running server or provider.
 *
 * Two representations of the same message, deliberately kept side by side:
 *
 *  - the rendered text, used by the stub, the logs, and later by phase 3 when
 *    the customer has replied and free-form text is allowed;
 *  - a MessageTemplate descriptor, because WhatsApp only accepts pre-approved
 *    templates for business-initiated messages and a phone call does not open
 *    the 24-hour free-form window.
 *
 * The descriptor names a domain-level key, never a provider template id — the
 * adapter resolves the key to a Twilio Content SID or a Meta template name.
 * A test asserts that every template variable also appears in the rendered
 * text, so the two representations cannot drift apart.
 *
 * Style rules for customer-facing text: Sie-Form, Swiss-compatible, no emoji,
 * no name (the caller name from a voice agent is unreliable — it lands in the
 * owner notification instead, where a wrong guess costs nothing).
 */

import type { MessagingFailureCode } from '../interfaces/messaging/messaging-port.js';
import type { RecoveryReason } from './types.js';

/** Domain-level identity of an approved WhatsApp template. */
export type TemplateKey =
  | 'customer_missed_call'
  | 'customer_incomplete_order'
  | 'owner_lost_order'
  | 'owner_undeliverable';

export type MessageTemplate = {
  key: TemplateKey;
  /** BCP-47-ish language tag as WhatsApp expects it. */
  language: string;
  /** Positional values for {{1}}, {{2}}, … in the approved body. */
  variables: string[];
};

export const TEMPLATE_LANGUAGE = 'de';

export type CustomerMessageContext = {
  reason: RecoveryReason;
  recoveryId: string;
};

export type OwnerMessageContext = {
  /** E.164 number of the customer. */
  phone: string;
  name?: string | null;
  reason: RecoveryReason;
  recoveryId: string;
  /** ISO timestamp of the call. */
  at: string;
  /** IANA time zone the owner reads times in, e.g. "Europe/Zurich". */
  timeZone: string;
};

export type UndeliverableMessageContext = {
  phone: string;
  recoveryId: string;
  code: MessagingFailureCode;
};

const REASON_LABELS: Record<RecoveryReason, string> = {
  missed_call: 'Verpasster Anruf',
  incomplete_order: 'Unvollständige Bestellung',
};

/**
 * Short German labels for delivery failures. They are shown to the owner, so
 * they say what to do about it rather than quoting a provider error code.
 */
const FAILURE_LABELS: Record<MessagingFailureCode, string> = {
  invalid_number: 'Ungültige Rufnummer',
  not_on_whatsapp: 'Nummer nicht bei WhatsApp registriert',
  template_rejected: 'Nachrichtenvorlage nicht freigegeben',
  authentication: 'Zugangsdaten abgelehnt',
  rate_limited: 'Versandlimit erreicht',
  provider_unavailable: 'Anbieter nicht erreichbar',
  network: 'Netzwerkfehler',
  unknown: 'Unbekannter Fehler',
};

export function reasonLabel(reason: RecoveryReason): string {
  return REASON_LABELS[reason];
}

export function failureLabel(code: MessagingFailureCode): string {
  return FAILURE_LABELS[code];
}

/**
 * Renders the ISO timestamp as local wall-clock time for the owner.
 * Vapi reports UTC; "14:32" is the only value an owner can act on.
 */
export function formatLocalTime(at: string, timeZone: string): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return 'unbekannt';

  return new Intl.DateTimeFormat('de-CH', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}

function displayName(name: string | null | undefined): string {
  return name?.trim() ? name.trim() : 'unbekannt';
}

// ─── Customer ────────────────────────────────────────────────────────────────

export function customerMessage(ctx: CustomerMessageContext): string {
  switch (ctx.reason) {
    case 'missed_call':
      return (
        'Guten Tag, wir haben Ihren Anruf leider verpasst. ' +
        'Möchten Sie Ihre Bestellung schnell per WhatsApp aufgeben? ' +
        'Antworten Sie einfach direkt hier – wir kümmern uns darum. ' +
        `Ihre Referenz: ${ctx.recoveryId}. Vielen Dank!`
      );
    case 'incomplete_order':
      return (
        `Guten Tag, Ihre Bestellung mit der Referenz ${ctx.recoveryId} ist noch nicht ` +
        'abgeschlossen. Antworten Sie hier, um sie fertigzustellen. Vielen Dank!'
      );
  }
}

export function customerTemplate(ctx: CustomerMessageContext): MessageTemplate {
  return {
    key: ctx.reason === 'missed_call' ? 'customer_missed_call' : 'customer_incomplete_order',
    language: TEMPLATE_LANGUAGE,
    variables: [ctx.recoveryId],
  };
}

// ─── Owner: possible lost order ──────────────────────────────────────────────

export function ownerMessage(ctx: OwnerMessageContext): string {
  return [
    '⚠️ Mögliche verlorene Bestellung',
    `Nummer: ${ctx.phone}`,
    `Name: ${displayName(ctx.name)}`,
    `Grund: ${reasonLabel(ctx.reason)}`,
    `Referenz: ${ctx.recoveryId}`,
    `Zeit: ${formatLocalTime(ctx.at, ctx.timeZone)} Uhr`,
  ].join('\n');
}

export function ownerTemplate(ctx: OwnerMessageContext): MessageTemplate {
  return {
    key: 'owner_lost_order',
    language: TEMPLATE_LANGUAGE,
    variables: [
      ctx.phone,
      displayName(ctx.name),
      reasonLabel(ctx.reason),
      ctx.recoveryId,
      formatLocalTime(ctx.at, ctx.timeZone),
    ],
  };
}

// ─── Owner: customer could not be reached at all ─────────────────────────────

/**
 * Sent when the customer message failed permanently. Without this the call
 * would disappear in silence — nobody messaged, nobody informed — which is the
 * exact failure this system exists to prevent.
 */
export function ownerUndeliverableMessage(ctx: UndeliverableMessageContext): string {
  return [
    '⚠️ WhatsApp nicht zustellbar',
    `Nummer: ${ctx.phone}`,
    `Referenz: ${ctx.recoveryId}`,
    `Fehler: ${failureLabel(ctx.code)}`,
    'Bitte den Kunden manuell zurückrufen.',
  ].join('\n');
}

export function ownerUndeliverableTemplate(ctx: UndeliverableMessageContext): MessageTemplate {
  return {
    key: 'owner_undeliverable',
    language: TEMPLATE_LANGUAGE,
    variables: [ctx.phone, ctx.recoveryId, failureLabel(ctx.code)],
  };
}
