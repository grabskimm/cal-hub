/**
 * Verify a Cloudflare Access identity so SSO can authorize the private calendar
 * WITHOUT a URL token. Access authenticates the user at the edge and forwards a
 * signed JWT (the `Cf-Access-Jwt-Assertion` header, and the `CF_Authorization`
 * cookie on same-origin sub-requests like /busy.json). We validate that JWT's
 * RS256 signature against the team's public keys and check aud / iss / exp.
 *
 * Enabled only when ACCESS_TEAM_DOMAIN and ACCESS_AUD are set; otherwise
 * verifyAccessJwt() returns null and the routes fall back to token-only auth,
 * so existing deployments are unaffected.
 */
export interface AccessEnv {
  ACCESS_TEAM_DOMAIN?: string; // e.g. https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's Audience (AUD) tag
}

interface Jwk {
  kid: string;
  kty: string;
  n: string;
  e: string;
  alg?: string;
}

// Small per-isolate JWKS cache so we don't refetch the certs on every request.
const jwksCache = new Map<string, { keys: Jwk[]; exp: number }>();
const JWKS_TTL_MS = 5 * 60 * 1000;

function b64urlToBytes(s: string): Uint8Array {
  const pad = (4 - (s.length % 4)) % 4; // 0, 1 or 2 '=' chars
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlToJson<T>(s: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(s))) as T;
}

async function getJwks(teamDomain: string): Promise<Jwk[]> {
  const cached = jwksCache.get(teamDomain);
  if (cached && cached.exp > Date.now()) return cached.keys;
  const res = await fetch(`${teamDomain}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`JWKS ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  jwksCache.set(teamDomain, { keys: body.keys ?? [], exp: Date.now() + JWKS_TTL_MS });
  return body.keys ?? [];
}

/** Read the Access JWT from the assertion header or the CF_Authorization cookie. */
function extractToken(request: Request): string | null {
  const header = request.headers.get('Cf-Access-Jwt-Assertion');
  if (header) return header.trim();
  const cookie = request.headers.get('Cookie') ?? '';
  const m = cookie.match(/(?:^|;\s*)CF_Authorization=([^;]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

/**
 * Return the authenticated email when a valid Access JWT is present, else null.
 * Never throws — any failure is treated as "not authenticated".
 */
export async function verifyAccessJwt(request: Request, env: AccessEnv): Promise<string | null> {
  const teamDomain = (env.ACCESS_TEAM_DOMAIN ?? '').trim().replace(/\/$/, '');
  const aud = (env.ACCESS_AUD ?? '').trim();
  if (!teamDomain || !aud) return null; // Access not configured -> disabled

  try {
    const jwt = extractToken(request);
    if (!jwt) return null;
    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    if (!headerB64 || !payloadB64 || !sigB64) return null;

    const header = b64urlToJson<{ kid: string; alg: string }>(headerB64);
    if (header.alg !== 'RS256') return null;

    const jwk = (await getJwks(teamDomain)).find((k) => k.kid === header.kid);
    if (!jwk) return null;

    const key = await crypto.subtle.importKey(
      'jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(sigB64), data);
    if (!ok) return null;

    const claims = b64urlToJson<{ aud?: string | string[]; iss?: string; exp?: number; email?: string }>(payloadB64);
    const auds = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
    if (!auds.includes(aud)) return null;
    if (claims.iss !== teamDomain) return null;
    if (!claims.exp || claims.exp * 1000 <= Date.now()) return null;

    return claims.email ?? 'access-user';
  } catch {
    return null;
  }
}
