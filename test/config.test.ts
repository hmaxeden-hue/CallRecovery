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

  it('leaves twilio config absent for the stub provider', () => {
    expect(loadConfig(validEnv).twilio).toBeUndefined();
  });

  describe('with WHATSAPP_PROVIDER=twilio', () => {
    const twilioEnv = {
      ...validEnv,
      WHATSAPP_PROVIDER: 'twilio',
      TWILIO_ACCOUNT_SID: 'ACxxx',
      TWILIO_AUTH_TOKEN: 'token',
      TWILIO_WHATSAPP_FROM: '+41445556677',
      TWILIO_CONTENT_SID_CUSTOMER_MISSED_CALL: 'HX1',
      TWILIO_CONTENT_SID_CUSTOMER_INCOMPLETE_ORDER: 'HX2',
      TWILIO_CONTENT_SID_OWNER_LOST_ORDER: 'HX3',
      TWILIO_CONTENT_SID_OWNER_UNDELIVERABLE: 'HX4',
    };

    it('builds the twilio config with a content sid per template key', () => {
      expect(loadConfig(twilioEnv).twilio).toEqual({
        accountSid: 'ACxxx',
        authToken: 'token',
        whatsappFrom: '+41445556677',
        contentSids: {
          customer_missed_call: 'HX1',
          customer_incomplete_order: 'HX2',
          owner_lost_order: 'HX3',
          owner_undeliverable: 'HX4',
        },
      });
    });

    it('refuses to start when credentials are missing', () => {
      expect(() => loadConfig({ ...validEnv, WHATSAPP_PROVIDER: 'twilio' })).toThrow(ConfigError);
    });

    it('names base and provider problems in the same pass', () => {
      try {
        loadConfig({ WHATSAPP_PROVIDER: 'twilio', OWNER_PHONE: '+41790000000' });
        expect.unreachable('should have thrown');
      } catch (error) {
        const problems = (error as ConfigError).problems.join('\n');
        expect(problems).toContain('VAPI_WEBHOOK_SECRET');
        expect(problems).toContain('TWILIO_ACCOUNT_SID');
        expect(problems).toContain('TWILIO_CONTENT_SID_OWNER_UNDELIVERABLE');
      }
    });

    it('catches pasted ids of the wrong kind', () => {
      expect(() => loadConfig({ ...twilioEnv, TWILIO_ACCOUNT_SID: 'SKxxx' })).toThrow(/AC/);
      expect(() =>
        loadConfig({ ...twilioEnv, TWILIO_CONTENT_SID_OWNER_LOST_ORDER: 'MG123' }),
      ).toThrow(/HX/);
    });
  });

  it('rejects an unknown provider, signature mode or time zone', () => {
    expect(() => loadConfig({ ...validEnv, WHATSAPP_PROVIDER: 'signal' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, VAPI_SIGNATURE_MODE: 'none' })).toThrow(ConfigError);
    expect(() => loadConfig({ ...validEnv, TIMEZONE: 'Mars/Olympus' })).toThrow(ConfigError);
  });
});
