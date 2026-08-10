/**
 * Composition root: the only place that knows which concrete adapters exist.
 *
 * Swapping an adapter is a change in this file and nowhere else.
 */

import { randomInt } from 'node:crypto';

import { loadConfigOrExit, type AppConfig } from './config.js';
import { createRecoveryIdFactory } from './core/recovery-id.js';
import { RecoveryService } from './core/recovery-service.js';
import type { Logger } from './core/types.js';
import { createConsoleLogger } from './logger.js';
import type { MessagingAdapter } from './interfaces/messaging/messaging-port.js';
import { StubMessaging } from './interfaces/messaging/stub-messaging.js';
import { createTwilioMessaging } from './interfaces/messaging/twilio-messaging.js';
import { SqlitePersistence } from './interfaces/persistence/sqlite-persistence.js';

export type App = {
  config: AppConfig;
  service: RecoveryService;
  persistence: SqlitePersistence;
  messaging: MessagingAdapter;
  logger: Logger;
  close(): void;
};

function createMessaging(config: AppConfig, logger: Logger): MessagingAdapter {
  switch (config.whatsappProvider) {
    case 'stub':
      return new StubMessaging();
    case 'twilio': {
      // config.twilio is guaranteed present by the conditional env validation;
      // the check keeps that guarantee honest rather than asserting it away.
      if (!config.twilio) throw new Error('Twilio-Konfiguration fehlt trotz WHATSAPP_PROVIDER=twilio');
      return createTwilioMessaging(config.twilio, { logger });
    }
    case 'meta_cloud':
      // Failing loudly beats silently falling back to the stub and letting an
      // operator believe customers were messaged.
      throw new Error(
        `WHATSAPP_PROVIDER="${config.whatsappProvider}" ist noch nicht implementiert. ` +
          'Bitte WHATSAPP_PROVIDER=stub oder twilio setzen.',
      );
    default: {
      const exhaustive: never = config.whatsappProvider;
      throw new Error(`Unbekannter WhatsApp-Provider: ${String(exhaustive)}`);
    }
  }
}

export function createApp(config: AppConfig = loadConfigOrExit()): App {
  const logger = createConsoleLogger();
  const persistence = new SqlitePersistence({ databasePath: config.databasePath });
  const messaging = createMessaging(config, logger);

  const service = new RecoveryService({
    persistence,
    messaging,
    now: () => new Date().toISOString(),
    // crypto.randomInt is rejection-sampled, so no modulo bias in the ids.
    generateRecoveryId: createRecoveryIdFactory((maxExclusive) => randomInt(maxExclusive)),
    ownerPhone: config.ownerPhone,
    timeZone: config.timeZone,
    logger,
  });

  logger.info('app wired', {
    provider: config.whatsappProvider,
    database: config.databasePath,
    timeZone: config.timeZone,
  });

  return {
    config,
    service,
    persistence,
    messaging,
    logger,
    close: () => persistence.close(),
  };
}
