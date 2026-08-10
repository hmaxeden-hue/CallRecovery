/**
 * Environment configuration, validated once at startup.
 *
 * A missing or malformed variable must stop the process with a message that
 * names every problem at once — not one restart per typo. Provider credentials
 * are validated conditionally: switching WHATSAPP_PROVIDER to twilio makes the
 * Twilio variables mandatory in the same pass, so the process never starts
 * half-configured.
 */

import { z } from 'zod';

import { normalizePhone } from './core/phone.js';
import type { TemplateKey } from './core/messages.js';
import type { TwilioConfig } from './interfaces/messaging/twilio-messaging.js';

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

/** Content SIDs are template ids from the Twilio Content Template Builder. */
const contentSidSchema = z
  .string()
  .min(1, 'darf nicht leer sein')
  .refine((value) => value.startsWith('HX'), 'muss eine Twilio Content SID sein (beginnt mit "HX")');

const twilioEnvSchema = z.object({
  TWILIO_ACCOUNT_SID: z
    .string()
    .min(1, 'darf nicht leer sein')
    .refine((value) => value.startsWith('AC'), 'muss mit "AC" beginnen'),
  TWILIO_AUTH_TOKEN: z.string().min(1, 'darf nicht leer sein'),
  TWILIO_WHATSAPP_FROM: phoneSchema,
  TWILIO_CONTENT_SID_CUSTOMER_MISSED_CALL: contentSidSchema,
  TWILIO_CONTENT_SID_CUSTOMER_INCOMPLETE_ORDER: contentSidSchema,
  TWILIO_CONTENT_SID_OWNER_LOST_ORDER: contentSidSchema,
  TWILIO_CONTENT_SID_OWNER_UNDELIVERABLE: contentSidSchema,
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
  /** Present exactly when whatsappProvider is "twilio". */
  twilio?: TwilioConfig;
};

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Ungültige Konfiguration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

function describeIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const key = issue.path.join('.') || '(unbekannt)';
    const detail = issue.code === 'invalid_type' ? 'fehlt' : issue.message;
    return `${key}: ${detail}`;
  });
}

function toTwilioConfig(parsed: z.infer<typeof twilioEnvSchema>): TwilioConfig {
  const contentSids: Record<TemplateKey, string> = {
    customer_missed_call: parsed.TWILIO_CONTENT_SID_CUSTOMER_MISSED_CALL,
    customer_incomplete_order: parsed.TWILIO_CONTENT_SID_CUSTOMER_INCOMPLETE_ORDER,
    owner_lost_order: parsed.TWILIO_CONTENT_SID_OWNER_LOST_ORDER,
    owner_undeliverable: parsed.TWILIO_CONTENT_SID_OWNER_UNDELIVERABLE,
  };

  return {
    accountSid: parsed.TWILIO_ACCOUNT_SID,
    authToken: parsed.TWILIO_AUTH_TOKEN,
    whatsappFrom: parsed.TWILIO_WHATSAPP_FROM,
    contentSids,
  };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const base = envSchema.safeParse(env);
  const problems = base.success ? [] : describeIssues(base.error);

  // Provider credentials are checked in the same pass, so a fresh install sees
  // every missing variable at once instead of discovering them one restart at
  // a time. `env` is read directly because base parsing may have failed.
  const wantsTwilio = (env['WHATSAPP_PROVIDER'] ?? 'stub') === 'twilio';
  const twilio = wantsTwilio ? twilioEnvSchema.safeParse(env) : null;
  if (twilio && !twilio.success) problems.push(...describeIssues(twilio.error));

  if (problems.length > 0) throw new ConfigError(problems);
  if (!base.success) throw new ConfigError(['unbekannter Konfigurationsfehler']);

  const parsed = base.data;
  return {
    vapiWebhookSecret: parsed.VAPI_WEBHOOK_SECRET,
    vapiSignatureMode: parsed.VAPI_SIGNATURE_MODE,
    whatsappProvider: parsed.WHATSAPP_PROVIDER,
    ownerPhone: parsed.OWNER_PHONE,
    databasePath: parsed.DATABASE_PATH,
    port: parsed.PORT,
    timeZone: parsed.TIMEZONE,
    ...(twilio?.success ? { twilio: toTwilioConfig(twilio.data) } : {}),
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
