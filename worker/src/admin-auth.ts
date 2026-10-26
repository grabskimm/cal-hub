/**
 * Authorization for the admin merge trigger (POST /run).
 *
 * Two credentials get in, and they are NOT equivalent:
 *
 *   1. `Authorization: Bearer <RUN_TOKEN>` — what curl, CI and the runbook use.
 *      A bearer token is never attached by the browser on its own, so a hostile
 *      page cannot make a visitor send it. No CSRF surface.
 *
 *   2. A verified Cloudflare Access identity — lets the owner force a run from
 *      the private /calendar page with no token anywhere. The credential here is
 *      the `CF_Authorization` COOKIE, which is ambient: the browser attaches it
 *      to cross-site requests too, and a cross-origin "simple" POST (no custom
 *      headers, no JSON content type) is dispatched WITHOUT a CORS preflight.
 *      The attacker cannot read the reply, but the merge would still fire — so
 *      cookie auth needs CSRF defences that the token path does not.
 *
 * `csrfOk` is that defence, and it is deliberately two independent checks:
 *
 *   * a custom request header. Adding one makes the request non-simple, so the
 *     browser must preflight it; /run answers no preflight that allows this
 *     header, so the real request is never sent cross-origin.
 *   * an Origin check. Belt and braces for anything that still arrives — and
 *     the reason a missing Origin is accepted is that non-browser clients
 *     (curl) omit it entirely; they still need a valid Access JWT to get in.
 */

/** The header our own page sends. Its presence forces a CORS preflight. */
export const RUN_CSRF_HEADER = 'X-AvailCal-Run';
export const RUN_CSRF_VALUE = '1';

export interface RunCsrfInput {
  /** Value of the RUN_CSRF_HEADER request header, or null when absent. */
  header: string | null;
  /** Value of the Origin request header, or null when absent (curl). */
  origin: string | null;
  /** This Worker's own origin, e.g. "https://availcal.example.com". */
  selfOrigin: string;
}

/**
 * True when a cookie-authorized POST /run may proceed. Call this BEFORE
 * verifying the Access JWT: it is pure and cheap, and short-circuiting here
 * saves a JWKS fetch on junk traffic.
 */
export function csrfOk({ header, origin, selfOrigin }: RunCsrfInput): boolean {
  if (header !== RUN_CSRF_VALUE) return false;
  // A browser always sends Origin on POST. A missing one means a non-browser
  // client, which carries no ambient cookie of its own.
  if (origin !== null && origin !== selfOrigin) return false;
  return true;
}
