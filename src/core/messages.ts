/**
 * German message templates. Pure functions of the form (ctx) => string, so
 * every wording change can be tested without a running server or provider.
 *
 * Style rules for customer-facing text: Sie-Form, Swiss-compatible, no emoji,
 * no name (the caller name from a voice agent is unreliable — it lands in the
 * owner notification instead, where a wrong guess costs nothing).
 */

import type { RecoveryReason } from './types.js';

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

const REASON_LABELS: Record<RecoveryReason, string> = {
  missed_call: 'Verpasster Anruf',
  incomplete_order: 'Unvollständige Bestellung',
};

export function reasonLabel(reason: RecoveryReason): string {
  return REASON_LABELS[reason];
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

export function customerMessage(ctx: CustomerMessageContext): string {
  switch (ctx.reason) {
    case 'missed_call':
      return (
        'Guten Tag, wir haben Ihren Anruf leider verpasst. ' +
        'Möchten Sie Ihre Bestellung schnell per WhatsApp aufgeben? ' +
        'Antworten Sie einfach direkt hier — wir kümmern uns darum. ' +
        `Ihre Referenz: ${ctx.recoveryId}.`
      );
    case 'incomplete_order':
      return (
        'Guten Tag, Ihre Bestellung ist noch nicht abgeschlossen. ' +
        'Antworten Sie hier, um sie fertigzustellen. ' +
        `Ihre Referenz: ${ctx.recoveryId}.`
      );
  }
}

export function ownerMessage(ctx: OwnerMessageContext): string {
  const name = ctx.name?.trim() ? ctx.name.trim() : 'unbekannt';

  return (
    '⚠️ Mögliche verlorene Bestellung — ' +
    `Nr.: ${ctx.phone} · ` +
    `Name: ${name} · ` +
    `Grund: ${reasonLabel(ctx.reason)} · ` +
    `Ref: ${ctx.recoveryId} · ` +
    `Zeit: ${formatLocalTime(ctx.at, ctx.timeZone)}.`
  );
}
