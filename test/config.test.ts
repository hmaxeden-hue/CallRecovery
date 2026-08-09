import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const validEnv = {
  VAPI_WEBHOOK_SECRET: 'secret',
  OWNER_PHONE: '+41790000000',
};

describe('loadConfig', () => {
  it('applies the documented defaults', () => {
    expect(loadConfig(validEnv)).toEqual({
      vapiWebhookSecret: 'secret',
      vapiSignatureMode: 'shared_secret',
      whatsappProvider: 'stub',
      ownerPhone: '+41790000000',
      databasePath: './data/recovery.sqlite',
      port: 3000,
      timeZone: 'Europe/Zurich',
    });
  });

  it('normalizes the owner phone number', () => {
    expect(loadConfig({ ...validEnv, OWNER_PHONE: '0041 79 000 00 00' }).ownerPhone).toBe(
      '+41790000000',
    );
  });

  it('coerces PORT to a number', () => {
    expect(loadConfig({ ...validEnv, PORT: '8080' }).port).toBe(8080);
  });

  it('reports every problem at once instead of one per restart', () => {
    try {
      loadConfig({ OWNER_PHONE: '0791234567', PORT: 'nope' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toContain('VAPI_WEBHOOK_SECRET');
      expect(problems).toContain('OWNER_PHONE');
      expect(problems).toContain('PORT');
    }
  });

  it('rejects an unknown provider, signature mode or time zone', () => {
    expect(() => loadConfig({ ...validEnv, WHATSAPP_PROVIDER: 'signal' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, VAPI_SIGNATURE_MODE: 'none' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
  });
});
