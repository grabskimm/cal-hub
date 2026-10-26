import { describe, expect, it } from 'vitest';

import { csrfOk, runAuthPlan, RUN_CSRF_HEADER, RUN_CSRF_VALUE } from '../src/admin-auth';

const SELF = 'https://availcal.example.com';

describe('csrfOk', () => {
  it('accepts our own page: custom header + same-origin', () => {
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: SELF, selfOrigin: SELF })).toBe(true);
  });

  it('rejects a POST with no custom header', () => {
    // This is the forgeable shape: a cross-origin "simple" POST is dispatched
    // WITHOUT a preflight, so the browser would attach CF_Authorization. The
    // header requirement is what makes that request non-simple.
    expect(csrfOk({ header: null, origin: 'https://evil.example', selfOrigin: SELF })).toBe(false);
    expect(csrfOk({ header: null, origin: SELF, selfOrigin: SELF })).toBe(false);
  });

  it('rejects a wrong header value', () => {
    expect(csrfOk({ header: '0', origin: SELF, selfOrigin: SELF })).toBe(false);
    expect(csrfOk({ header: '', origin: SELF, selfOrigin: SELF })).toBe(false);
  });

  it('rejects a cross-origin Origin even with the header', () => {
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: 'https://evil.example', selfOrigin: SELF })).toBe(false);
    // A near-miss hostname must not pass.
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: 'https://availcal.example.com.evil.test', selfOrigin: SELF })).toBe(false);
    // Scheme and port are part of the origin.
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: 'http://availcal.example.com', selfOrigin: SELF })).toBe(false);
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: 'https://availcal.example.com:8443', selfOrigin: SELF })).toBe(false);
  });

  it('allows a missing Origin (curl) — the Access JWT is still required', () => {
    // Non-browser clients omit Origin and carry no ambient cookie; the caller
    // still has to pass verifyAccessJwt after this returns true.
    expect(csrfOk({ header: RUN_CSRF_VALUE, origin: null, selfOrigin: SELF })).toBe(true);
  });

  it("names the header the page actually sends", () => {
    expect(RUN_CSRF_HEADER).toBe('X-AvailCal-Run');
  });
});

describe('runAuthPlan', () => {
  const sameOrigin = { header: RUN_CSRF_VALUE, origin: SELF, selfOrigin: SELF };
  const noCsrf = { header: null, origin: null, selfOrigin: SELF };

  it('lets a valid bearer through WITHOUT the CSRF header', () => {
    // This is the documented runbook command:
    //   curl -X POST .../run -H "Authorization: Bearer <RUN_TOKEN>"
    // It sends no X-AvailCal-Run and no Origin. Reordering the handler so the
    // CSRF check runs first would 401 it — this test is what fails instead.
    expect(runAuthPlan({ bearerValid: true, csrf: noCsrf })).toEqual({ kind: 'allow-token' });
  });

  it('lets a valid bearer through even from a cross-origin caller', () => {
    // A bearer token is not ambient: no page can make a browser send it, so
    // there is nothing here for CSRF to protect against.
    expect(runAuthPlan({
      bearerValid: true,
      csrf: { header: null, origin: 'https://evil.example', selfOrigin: SELF },
    })).toEqual({ kind: 'allow-token' });
  });

  it('falls to the Access path only when the CSRF proof is present', () => {
    expect(runAuthPlan({ bearerValid: false, csrf: sameOrigin })).toEqual({ kind: 'try-access' });
  });

  it('rejects a cookie-only POST with no CSRF proof before any JWT work', () => {
    // The forgeable shape. Rejecting here also means junk traffic never costs
    // a JWKS fetch.
    expect(runAuthPlan({ bearerValid: false, csrf: noCsrf })).toEqual({ kind: 'reject' });
    expect(runAuthPlan({
      bearerValid: false,
      csrf: { header: RUN_CSRF_VALUE, origin: 'https://evil.example', selfOrigin: SELF },
    })).toEqual({ kind: 'reject' });
  });

  it('never reports allow-access on its own — the caller must still verify the JWT', () => {
    // runAuthPlan is a plan, not a verdict: 'try-access' is the strongest
    // thing it can say, so no refactor can accidentally make the cookie
    // path self-authorizing.
    const kinds = [
      runAuthPlan({ bearerValid: false, csrf: sameOrigin }).kind,
      runAuthPlan({ bearerValid: true, csrf: sameOrigin }).kind,
      runAuthPlan({ bearerValid: false, csrf: noCsrf }).kind,
    ];
    expect(kinds).toEqual(['try-access', 'allow-token', 'reject']);
  });
});
