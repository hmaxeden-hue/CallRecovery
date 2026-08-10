/**
 * Local end-to-end run without HTTP: feeds one simulated IncomingCallEvent
 * through the real wiring (SQLite + stub messaging), then feeds the identical
 * event a second time to demonstrate idempotency.
 *
 *   npm run simulate
 *   npm run simulate -- --phone +41791111111 --name Meier --partial
 *   npm run simulate -- --completed          # nothing should happen
 */

import { randomUUID } from 'node:crypto';

import { createApp } from '../src/app.js';
import type { IncomingCallEvent, HandleResult } from '../src/core/types.js';

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

function option(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) return fallback;
  return process.argv[index + 1] ?? fallback;
}

function describe(result: HandleResult): string {
  switch (result.outcome) {
    case 'skipped':
      return `übersprungen (${result.decision.action === 'skip' ? result.decision.skipReason : '-'})`;
    case 'duplicate':
      return `Duplikat — ${result.recoveryId} steht bereits auf "${result.status}", kein erneuter Versand`;
    case 'notified':
      return (
        `benachrichtigt — ${result.recoveryId} (${result.reason})` +
        (result.retriedPending ? ', Wiederholung eines offenen Versands' : '') +
        (result.ownerNotified ? '' : ', Owner-Benachrichtigung fehlgeschlagen')
      );
    case 'send_failed':
      return `Versand fehlgeschlagen für ${result.recoveryId}: ${result.error} (Wiederholung folgt)`;
    case 'send_rejected':
      return (
        `dauerhaft unzustellbar — ${result.recoveryId} geschlossen (${result.code}), ` +
        (result.ownerNotified
          ? 'Owner wurde zum Rückruf aufgefordert'
          : 'ACHTUNG: auch der Owner konnte nicht benachrichtigt werden')
      );
  }
}

async function main(): Promise<void> {
  const app = createApp();

  const endedAt = new Date();
  const startedAt = new Date(endedAt.getTime() - 42_000);
  const name = option('name', '');

  const event: IncomingCallEvent = {
    callId: option('call-id', `sim-${randomUUID().slice(0, 8)}`),
    fromPhone: option('phone', '+41791234567'),
    toPhone: option('to', '+41445556677'),
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    endedReason: option('ended-reason', 'customer-hung-up'),
    orderCompleted: flag('completed'),
    ...(name ? { callerName: name } : {}),
    ...(flag('partial') ? { partialOrder: { items: [{ sku: 'BIER-50', qty: 2 }] } } : {}),
  };

  console.log(`\n── Anruf 1 (callId=${event.callId}) ───────────────────────────`);
  const first = await app.service.handle(event);
  console.log(`→ ${describe(first)}`);

  if (!flag('once')) {
    console.log(`\n── Anruf 2: identischer Webhook (Vapi-Retry) ─────────────────`);
    const second = await app.service.handle(event);
    console.log(`→ ${describe(second)}`);
  }

  console.log(`\n── Datenbank (${app.config.databasePath}) ─────────────────────`);
  for (const recovery of app.persistence.listRecoveries()) {
    console.log(
      `  ${recovery.recoveryId}  ${recovery.reason.padEnd(16)} ${recovery.status.padEnd(8)}` +
        ` call=${recovery.callId} notified=${recovery.notifiedAt ?? '-'}`,
    );
  }
  console.log('');

  app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
