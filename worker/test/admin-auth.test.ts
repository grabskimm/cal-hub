import { describe, expect, it } from 'vitest';

import { csrfOk, RUN_CSRF_HEADER, RUN_CSRF_VALUE } from '../src/admin-auth';

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
