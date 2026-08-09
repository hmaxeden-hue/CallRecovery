/**
 * HTTP bootstrap. Assembles the Hono app from the wired application and starts
 * listening. Everything domain-related already happened in app.ts.
 */

import { serve } from '@hono/node-server';
import { Hono } from 'hono';

import { createApp, type App } from './app.js';
import { VAPI_WEBHOOK_PATH, createVapiWebhookRoute } from './interfaces/intake/vapi-webhook.js';

export function createHttpApp(app: App): Hono {
  const http = new Hono();

  http.get('/health', (c) =>
    c.json({ status: 'ok', provider: app.config.whatsappProvider, time: new Date().toISOString() }),
  );

  http.route(
    VAPI_WEBHOOK_PATH,
    createVapiWebhookRoute({ service: app.service, config: app.config, logger: app.logger }),
  );

  return http;
}

function main(): void {
  const app = createApp();
  const http = createHttpApp(app);

  const server = serve({ fetch: http.fetch, port: app.config.port }, (info) => {
    app.logger.info('server listening', {
      port: info.port,
      webhook: VAPI_WEBHOOK_PATH,
      signatureMode: app.config.vapiSignatureMode,
    });
  });

  // Close the database explicitly so WAL files are checkpointed on shutdown.
  const shutdown = (signal: string) => {
    app.logger.info('shutting down', { signal });
    server.close(() => {
      app.close();
      process.exit(0);
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only start a server when executed directly, so tests can import createHttpApp.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main();
}
