/**
 * Sends one real WhatsApp message through the configured provider.
 *
 * This is the only way to prove the credentials and the approved templates
 * actually work — the unit tests verify the request shape, not the account.
 *
 *   npm run send-test -- --to +41791234567
 *   npm run send-test -- --to +41791234567 --template customer_incomplete_order
 *   npm run send-test -- --to +41791234567 --owner
 *
 * With WHATSAPP_PROVIDER=stub nothing leaves the machine; the message is only
 * printed, which makes this safe to run before credentials exist.
 */

import { createApp } from '../src/app.js';
import {
  customerMessage,
  customerTemplate,
  ownerMessage,
  ownerTemplate,
  ownerUndeliverableMessage,
  ownerUndeliverableTemplate,
  type MessageTemplate,
} from '../src/core/messages.js';
import { MessagingError } from '../src/interfaces/messaging/messaging-port.js';

const TEST_RECOVERY_ID = 'R-TEST';

function option(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

type Variant = { body: string; template: MessageTemplate };

function buildVariant(key: string, phone: string, timeZone: string): Variant {
  switch (key) {
    case 'customer_missed_call':
      return {
        body: customerMessage({ reason: 'missed_call', recoveryId: TEST_RECOVERY_ID }),
        template: customerTemplate({ reason: 'missed_call', recoveryId: TEST_RECOVERY_ID }),
      };
    case 'customer_incomplete_order':
      return {
        body: customerMessage({ reason: 'incomplete_order', recoveryId: TEST_RECOVERY_ID }),
        template: customerTemplate({ reason: 'incomplete_order', recoveryId: TEST_RECOVERY_ID }),
      };
    case 'owner_lost_order': {
      const context = {
        phone,
        name: 'Testkunde',
        reason: 'missed_call' as const,
        recoveryId: TEST_RECOVERY_ID,
        at: new Date().toISOString(),
        timeZone,
      };
      return { body: ownerMessage(context), template: ownerTemplate(context) };
    }
    case 'owner_undeliverable': {
      const context = { phone, recoveryId: TEST_RECOVERY_ID, code: 'not_on_whatsapp' as const };
      return {
        body: ownerUndeliverableMessage(context),
        template: ownerUndeliverableTemplate(context),
      };
    }
    default:
      throw new Error(
        `Unbekanntes Template "${key}". Erlaubt: customer_missed_call, ` +
          'customer_incomplete_order, owner_lost_order, owner_undeliverable',
      );
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const toOwner = flag('owner');
  const to = option('to') ?? (toOwner ? app.config.ownerPhone : undefined);

  if (!to) {
    console.error('Bitte Zielnummer angeben: npm run send-test -- --to +41791234567');
    process.exit(1);
  }

  const templateKey = option('template') ?? (toOwner ? 'owner_lost_order' : 'customer_missed_call');
  const variant = buildVariant(templateKey, to, app.config.timeZone);

  console.log(`Provider: ${app.config.whatsappProvider}`);
  console.log(`An:       ${to}`);
  console.log(`Template: ${variant.template.key} (${variant.template.variables.join(' | ')})\n`);

  const message = { toPhone: to, body: variant.body, template: variant.template, recoveryId: TEST_RECOVERY_ID };

  try {
    if (toOwner) await app.messaging.sendToOwner(message);
    else await app.messaging.sendToCustomer(message);

    console.log('\n✓ Übergeben. Bei einem echten Provider heißt das: angenommen, noch nicht');
    console.log('  zugestellt — die Zustellbestätigung käme per Status-Callback.');
  } catch (error) {
    if (error instanceof MessagingError) {
      console.error(`\n✗ Fehlgeschlagen: ${error.message}`);
      console.error(
        `  code=${error.code} retryable=${error.retryable} ` +
          `providerCode=${error.providerCode ?? '-'} status=${error.status ?? '-'}`,
      );
    } else {
      console.error('\n✗ Unerwarteter Fehler:', error);
    }
    app.close();
    process.exit(1);
  }

  app.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
