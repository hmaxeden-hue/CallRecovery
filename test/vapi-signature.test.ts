import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  SHARED_SECRET_HEADER,
  SIGNATURE_HEADER,
  verifyVapiRequest,
} from '../src/interfaces/intake/vapi-signature.js';

const SECRET = 'super-secret';
const BODY = '{"message":{"type":"end-of-call-report"}}';

function headers(map: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(map).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower[name.toLowerCase()];
}

describe('shared secret mode', () => {
  const verify = (map: Record<string, string>) =>
    verifyVapiRequest({ rawBody: BODY, header: headers(map), secret: SECRET, mode: 'shared_secret' });

  it('accepts the matching secret', () => {
    expect(verify({ [SHARED_SECRET_HEADER]: SECRET })).toEqual({ ok: true });
  });

  it('is case-insensitive about the header name', () => {
    expect(verify({ 'X-Vapi-Secret': SECRET })).toEqual({ ok: true });
  });

  it('rejects a wrong secret', () => {
    expect(verify({ [SHARED_SECRET_HEADER]: 'wrong' })).toMatchObject({ ok: false });
  });

  it('rejects a secret of a different length without throwing', () => {
    expect(verify({ [SHARED_SECRET_HEADER]: 'x' })).toMatchObject({ ok: false });
    expect(verify({ [SHARED_SECRET_HEADER]: `${SECRET}-plus-more` })).toMatchObject({ ok: false });
  });

  it('rejects a missing header', () => {
    expect(verify({})).toMatchObject({ ok: false, reason: expect.stringContaining('missing') });
  });
});

describe('hmac mode', () => {
  const signature = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
  const verify = (map: Record<string, string>, rawBody = BODY) =>
    verifyVapiRequest({ rawBody, header: headers(map), secret: SECRET, mode: 'hmac_sha256' });

  it('accepts a correct signature', () => {
    expect(verify({ [SIGNATURE_HEADER]: signature })).toEqual({ ok: true });
  });

  it('accepts the sha256= prefix and uppercase hex', () => {
    expect(verify({ [SIGNATURE_HEADER]: `sha256=${signature.toUpperCase()}` })).toEqual({ ok: true });
  });

  it('rejects a signature computed over a different body', () => {
    expect(verify({ [SIGNATURE_HEADER]: signature }, `${BODY} `)).toMatchObject({ ok: false });
  });

  it('rejects garbage and missing signatures', () => {
    expect(verify({ [SIGNATURE_HEADER]: 'deadbeef' })).toMatchObject({ ok: false });
    expect(verify({})).toMatchObject({ ok: false });
  });
});
