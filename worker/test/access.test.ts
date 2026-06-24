import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { verifyAccessJwt } from '../src/access';

const TEAM = 'https://team.cloudflareaccess.com';
const AUD = 'aud-tag-123';

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
const b64urlStr = (s: string) => b64url(new TextEncoder().encode(s));

let keyPair: CryptoKeyPair;
let jwk: JsonWebKey;

beforeAll(async () => {
  keyPair = (await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  jwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
});

async function makeJwt(claims: Record<string, unknown>, kid = 'kid-1'): Promise<string> {
  const header = b64urlStr(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }));
  const payload = b64urlStr(JSON.stringify(claims));
  const data = new TextEncoder().encode(`${header}.${payload}`);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, data);
  return `${header}.${payload}.${b64url(new Uint8Array(sig))}`;
}

function stubJwks(kid = 'kid-1') {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ keys: [{ ...jwk, kid, alg: 'RS256' }] }) })),
  );
}

function req(jwt: string): Request {
  return new Request('https://availcal.example/calendar', { headers: { 'Cf-Access-Jwt-Assertion': jwt } });
}

const env = { ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: AUD };
const future = () => Math.floor(Date.now() / 1000) + 3600;

afterEach(() => vi.unstubAllGlobals());

describe('verifyAccessJwt', () => {
  it('returns the email for a valid token', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: TEAM, exp: future(), email: 'me@corp.com' });
    expect(await verifyAccessJwt(req(jwt), env)).toBe('me@corp.com');
  });

  it('is disabled (null) when not configured', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: TEAM, exp: future(), email: 'me@corp.com' });
    expect(await verifyAccessJwt(req(jwt), {})).toBeNull();
  });

  it('rejects a wrong audience', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: ['someone-else'], iss: TEAM, exp: future(), email: 'me@corp.com' });
    expect(await verifyAccessJwt(req(jwt), env)).toBeNull();
  });

  it('rejects a wrong issuer', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: 'https://evil.example', exp: future(), email: 'me@corp.com' });
    expect(await verifyAccessJwt(req(jwt), env)).toBeNull();
  });

  it('rejects an expired token', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: TEAM, exp: Math.floor(Date.now() / 1000) - 10, email: 'me@corp.com' });
    expect(await verifyAccessJwt(req(jwt), env)).toBeNull();
  });

  it('rejects a tampered payload', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: TEAM, exp: future(), email: 'me@corp.com' });
    const parts = jwt.split('.');
    parts[1] = b64urlStr(JSON.stringify({ aud: [AUD], iss: TEAM, exp: future(), email: 'attacker@evil.com' }));
    expect(await verifyAccessJwt(req(parts.join('.')), env)).toBeNull();
  });

  it('reads the JWT from the CF_Authorization cookie too', async () => {
    stubJwks();
    const jwt = await makeJwt({ aud: [AUD], iss: TEAM, exp: future(), email: 'me@corp.com' });
    const r = new Request('https://availcal.example/busy.json', { headers: { Cookie: `CF_Authorization=${jwt}` } });
    expect(await verifyAccessJwt(r, env)).toBe('me@corp.com');
  });

  it('returns null when no token is present', async () => {
    stubJwks();
    const r = new Request('https://availcal.example/calendar');
    expect(await verifyAccessJwt(r, env)).toBeNull();
  });
});
