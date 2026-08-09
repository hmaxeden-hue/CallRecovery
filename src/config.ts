/**
 * Environment configuration, validated once at startup.
 *
 * A missing or malformed variable must stop the process with a message that
 * names every problem at once — not one restart per typo.
 */

import { z } from 'zod';

import { normalizePhone } from './core/phone.js';

const phoneSchema = z
  .string()
  .min(1, 'darf nicht leer sein')
  .refine((value) => normalizePhone(value) !== null, 'muss eine gültige E.164-Nummer sein (z. B. +41791234567)')
  .transform((value) => normalizePhone(value) as string);

const timeZoneSchema = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('de-CH', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'muss eine gültige IANA-Zeitzone sein (z. B. Europe/Zurich)');

const envSchema = z.object({
  VAPI_WEBHOOK_SECRET: z.string().min(1, 'darf nicht leer sein'),
  VAPI_SIGNATURE_MODE: z.enum(['shared_secret', 'hmac_sha256']).default('shared_secret'),
  WHATSAPP_PROVIDER: z.enum(['stub', 'twilio', 'meta_cloud']).default('stub'),
  OWNER_PHONE: phoneSchema,
  DATABASE_PATH: z.string().min(1).default('./data/recovery.sqlite'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  TIMEZONE: timeZoneSchema.default('Europe/Zurich'),
});

export type WhatsappProvider = z.infer<typeof envSchema>['WHATSAPP_PROVIDER'];
export type VapiSignatureMode = z.infer<typeof envSchema>['VAPI_SIGNATURE_MODE'];

export type AppConfig = {
  vapiWebhookSecret: string;
  vapiSignatureMode: VapiSignatureMode;
  whatsappProvider: WhatsappProvider;
  /** Normalized E.164. */
  ownerPhone: string;
  databasePath: string;
  port: number;
  timeZone: string;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Ungültige Konfiguration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    const problems = result.error.issues.map((issue) => {
      const key = issue.path.join('.') || '(unbekannt)';
      const detail = issue.code === 'invalid_type' ? 'fehlt' : issue.message;
      return `${key}: ${detail}`;
    });
    throw new ConfigError(problems);
  }

  const parsed = result.data;
  return {
    vapiWebhookSecret: parsed.VAPI_WEBHOOK_SECRET,
    vapiSignatureMode: parsed.VAPI_SIGNATURE_MODE,
    whatsappProvider: parsed.WHATSAPP_PROVIDER,
    ownerPhone: parsed.OWNER_PHONE,
    databasePath: parsed.DATABASE_PATH,
    port: parsed.PORT,
    timeZone: parsed.TIMEZONE,
  };
}

/** Entry-point helper: print the problems plainly and stop. */
export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      console.error('\nVorlage: .env.example nach .env kopieren und ausfüllen.');
      process.exit(1);
    }
    throw error;
  }
}
