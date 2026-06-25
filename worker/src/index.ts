/**
 * AvailCal Cloudflare Worker.
 *
 * Three responsibilities, all scale-to-zero:
 *
 *  1. Cron Trigger (hourly) -> boot the merge Container and call POST /run,
 *     which pulls every source, merges, and writes the feed to R2. The Container
 *     then idles and Cloudflare sleeps it (see `sleepAfter`).
 *  2. Serve the feed: GET /availability.ics (and /raw/<label>.ics overlays) read
 *     straight from R2 via the native binding, gated by a secret token in the
 *     query string (calendar clients can't send headers).
 *  3. Accept device-agent uploads: PUT /raw/<source>.json with a Bearer token,
 *     written to R2 via the native binding.
 *
 * On the PUBLIC host it also exposes a token-free, CORS-enabled scheduling
 * surface for webpages: /freebusy.json (anonymized busy), /slots.json (computed
 * bookable free slots), and a demo page at /.
 *
 * The Container computes + writes to R2 with a scoped R2 token (boto3); the
 * Worker serves + accepts uploads via its R2 binding. Both touch one bucket.
 */
import { Container, getContainer } from '@cloudflare/containers';

import { verifyAccessJwt } from './access';
import { availabilityHtml } from './availability-page';
import { type BookingPageCfg, bookingHtml } from './booking';
import {
  type AiBinding,
  callModel,
  chatEnabled,
  type ChatMode,
  chatSlotParams,
  findSlots,
  formatProposedReply,
  parseAction,
  rankSlots,
  systemPrompt,
} from './chat';
import { calendarHtml } from './calendar-view';
import { type ChatPageCfg, chatPageHtml } from './chat-page';
import { fetchOwnerProjects } from './github';
import { OWNER_BIO_DEFAULT, OWNER_PROJECTS_FALLBACK } from './owner-bio';
import { contactEnabled, contactHtml, sendContact, validateMessage } from './contact';
import { EMBED_JS } from './embed';
import {
  bookingNotifyConfig,
  buildGraphEvent,
  createGraphEvent,
  graphToken,
  schedulingEnabled,
  sendBookingNotification,
  slotIsBookable,
  turnstileEnabled,
  validateBooking,
  verifyTurnstile,
  zoomEnabled,
} from './scheduling';
import { type Busy, type Slot, computeSlots, parseDays } from './slots';

export interface Env {
  // Durable Object namespace backing the merge Container.
  MERGE_CONTAINER: DurableObjectNamespace<MergeContainer>;
  // Native R2 binding used for serving the feed and accepting agent uploads.
  AVAILCAL_BUCKET: R2Bucket;

  // --- auth tokens (Workers Secrets) ---
  FEED_TOKEN: string; // read the merged feed (?token=)
  AGENT_TOKEN: string; // device-agent PUT uploads (Bearer)
  RUN_TOKEN: string; // Worker<->Container trigger + manual POST /run (Bearer)

  // Hostname for the fully-anonymized PUBLIC feed (no token, no labels). When a
  // request arrives on this host, only the public feed is served. Empty = off.
  PUBLIC_FEED_HOST: string;

  // --- config passed through to the Container process ---
  AVAILCAL_R2_BUCKET: string;
  AVAILCAL_R2_ACCOUNT_ID: string;
  AVAILCAL_R2_ACCESS_KEY_ID: string;
  AVAILCAL_R2_SECRET_ACCESS_KEY: string;
  AVAILCAL_ICS_FEEDS: string;
  // Inline sources.toml content (secret). Keeps the real label registry out of
  // git/the image; overrides the baked placeholder at runtime.
  SOURCES_TOML?: string;
  AVAILCAL_DEFAULT_TZ: string;
  AVAILCAL_HORIZON_DAYS: string;
  AVAILCAL_INCLUDE_TENTATIVE: string;
  // "true" makes the merge job also write the anonymized public feed to R2.
  AVAILCAL_EMIT_PUBLIC: string;

  // --- public scheduling defaults (optional; overridable per request) ---
  SCHEDULE_SLOT_MINUTES?: string; // default slot length (min)
  SCHEDULE_WORK_START?: string; // owner's working-hours start HH:MM (business tz)
  SCHEDULE_WORK_END?: string; // owner's working-hours end HH:MM (business tz)
  SCHEDULE_WORK_TZ?: string; // business timezone the working hours are in
  SCHEDULE_DAYS?: string; // default allowed weekdays, e.g. "1-5"
  SCHEDULE_MAX_RANGE_DAYS?: string; // clamp the requested date range

  // --- Outlook booking page (/book on the public host) ---
  BOOKING_OWNER_EMAIL?: string; // invitee on the composed Outlook event
  BOOKING_TITLE?: string; // default event subject
  BOOKING_OUTLOOK_FLAVOR?: string; // 'office' (M365, default) | 'live' (personal)

  // --- "Book it for me" → create the event on the owner's M365 calendar (app-only
  //     Microsoft Graph). All optional: absent => the feature is disabled and
  //     /book only serves the add-to-your-own-calendar links. ---
  MS_TENANT_ID?: string; // Entra tenant id
  MS_CLIENT_ID?: string; // app registration (client) id
  MS_CLIENT_SECRET?: string; // app client secret (a Worker secret)
  MS_MAILBOX?: string; // mailbox to write to (UPN / primary SMTP)
  ZOOM_PERSONAL_LINK?: string; // optional static Zoom URL for the "Zoom" choice
  BOOKING_PHONE?: string; // owner's phone shown for the "Phone" choice (enables it)
  TURNSTILE_SITE_KEY?: string; // Cloudflare Turnstile public site key (page widget)
  TURNSTILE_SECRET?: string; // Turnstile secret (server verify; a Worker secret)
  BOOKING_NOTIFY_TO?: string; // owner alert recipient on each booking (defaults to CONTACT_TO / owner)

  // --- natural-language chat booker (/chat, Workers AI) ---
  AI?: AiBinding; // Workers AI binding; absent => chat disabled
  CHAT_MODEL?: string; // override the default chat model
  CHAT_HOST?: string; // optional dedicated host (e.g. chat.example.com) that serves the chat at /
  OWNER_BIO?: string; // short bio used by the assistant-mode chat on CHAT_HOST to answer questions about the owner
  CHAT_DEBUG?: string; // "true" => include the underlying model error in the /chat JSON response (diagnostics)
  GITHUB_USER?: string; // GitHub username; assistant-mode chat lists this user's own repos for accurate project answers
  GITHUB_TOKEN?: string; // optional GitHub token to raise the API rate limit (a Worker secret)

  PUBLIC_PAGE_TITLE?: string; // friendly heading on the public availability page
  CALENDAR_FALLBACK_TZ?: string; // tz used if a viewer's local zone can't resolve
  OWNER_NAME?: string; // personalises headings, e.g. "Book a time with Mendel"
  FOOTER_OWNER?: string; // legal name for the © footer, e.g. "Mendel Grabski"
  OWNER_SITE_URL?: string; // linked from the footer, e.g. https://mendelg.tech
  SOURCE_URL?: string; // public source-code link shown in the footer

  // --- "Contact me" relay (/contact on the public host) ---
  CONTACT_TO?: string; // mailbox that receives notes
  CONTACT_FROM?: string; // verified sender address (Resend/SendGrid requirement)
  CONTACT_PROVIDER?: string; // 'resend' (default) | 'sendgrid'
  CONTACT_API_KEY?: string; // provider API key (a Worker secret)

  // --- Cloudflare Access SSO for /calendar + /busy.json (optional) ---
  // When both are set, a valid Access identity authorizes these routes WITHOUT
  // a URL token. Empty = disabled (token-only, unchanged).
  ACCESS_TEAM_DOMAIN?: string; // https://<team>.cloudflareaccess.com
  ACCESS_AUD?: string; // the Access application's Audience (AUD) tag
}

const MERGED_KEY = 'merged/availability.ics';
const MERGED_BUSY_KEY = 'merged/busy.json';
const ADDED_KEY = 'merged/added.json';
const PUBLIC_KEY = 'public/availability.ics';
const PUBLIC_FREEBUSY_KEY = 'public/freebusy.json';
const RAW_ICS_RE = /^\/raw\/[A-Za-z0-9_]+\.ics$/;
const RAW_JSON_RE = /^\/raw\/[A-Za-z0-9_]+\.json$/;

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400',
};

const DAY_MS = 86_400_000;

/**
 * The merge Container. It runs the Python HTTP server (image default CMD); the
 * Worker proxies POST /run to it. Env vars (incl. the scoped R2 token) are
 * injected from Workers Secrets so no secret is baked into the image.
 */
export class MergeContainer extends Container<Env> {
  defaultPort = 8080;
  // Idle this long after the last request, then scale to zero.
  sleepAfter = '5m';

  constructor(...args: ConstructorParameters<typeof Container<Env>>) {
    super(...args);
    const env = args[1];
    this.envVars = {
      // Storage backend: Cloudflare R2 (S3-compatible).
      AVAILCAL_R2_BUCKET: env.AVAILCAL_R2_BUCKET,
      AVAILCAL_R2_ACCOUNT_ID: env.AVAILCAL_R2_ACCOUNT_ID,
      AVAILCAL_R2_ACCESS_KEY_ID: env.AVAILCAL_R2_ACCESS_KEY_ID,
      AVAILCAL_R2_SECRET_ACCESS_KEY: env.AVAILCAL_R2_SECRET_ACCESS_KEY,
      // Sources + merge behaviour. The real label registry is supplied inline
      // via the SOURCES_TOML secret (overrides the image's placeholder).
      AVAILCAL_ICS_FEEDS: env.AVAILCAL_ICS_FEEDS ?? '',
      AVAILCAL_SOURCES_TOML_CONTENT: env.SOURCES_TOML ?? '',
      AVAILCAL_DEFAULT_TZ: env.AVAILCAL_DEFAULT_TZ ?? 'America/New_York',
      AVAILCAL_HORIZON_DAYS: env.AVAILCAL_HORIZON_DAYS ?? '90',
      AVAILCAL_INCLUDE_TENTATIVE: env.AVAILCAL_INCLUDE_TENTATIVE ?? 'true',
      AVAILCAL_EMIT_PUBLIC: env.AVAILCAL_EMIT_PUBLIC ?? 'false',
      // The Worker authenticates its /run call with this token.
      AVAILCAL_RUN_TOKEN: env.RUN_TOKEN,
    };
  }
}

/** Constant-time-ish string compare (avoids trivial timing oracles). */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function bearer(request: Request): string | null {
  const h = request.headers.get('Authorization') ?? '';
  return h.startsWith('Bearer ') ? h.slice('Bearer '.length) : null;
}

/** Trigger one merge cycle by proxying POST /run to the Container. */
async function triggerMerge(env: Env): Promise<Response> {
  const container = getContainer(env.MERGE_CONTAINER);
  return container.fetch(
    new Request('http://merge-container/run', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RUN_TOKEN}` },
    }),
  );
}

export default {
  /** Hourly Cron Trigger: run a merge cycle. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      (async () => {
        const resp = await triggerMerge(env);
        const body = await resp.text();
        console.log(`scheduled merge -> ${resp.status}: ${body.slice(0, 300)}`);
      })(),
    );
  },

  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const res = await routeRequest(request, env, ctx);
    // HTTP semantics: a HEAD response carries headers but no body.
    if (request.method === 'HEAD') {
      return new Response(null, { status: res.status, headers: res.headers });
    }
    return res;
  },
};

async function routeRequest(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;
  // Treat HEAD like GET for routing (clients probe feeds with HEAD).
  const isRead = request.method === 'GET' || request.method === 'HEAD';

  // --- dedicated chat host (e.g. chat.example.com): a standalone, embeddable
  //     chat surface that reuses the same /chat backend. Serves the chat UI at /
  //     and /chat, plus POST /chat. ---
  if (env.CHAT_HOST && url.hostname === env.CHAT_HOST) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!chatEnabled(env) || !schedulingEnabled(env)) {
      return new Response('Chat is not configured.', { status: 404, headers: CORS });
    }
    if (request.method === 'POST' && path === '/chat') return handleChatRequest(env, ctx, request, 'assistant');
    if (isRead && (path === '/' || path === '/chat')) return serveChatPage(env, 'assistant');
    return new Response('not found', { status: 404, headers: CORS });
  }

  // --- PUBLIC host: token-free, read-only scheduling surface ---
  // Only anonymized reads are reachable here; the token feed, overlays,
  // uploads, and /run are all unreachable, so the public hostname can never
  // expose labels or accept writes.
  if (env.PUBLIC_FEED_HOST && url.hostname === env.PUBLIC_FEED_HOST) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (isRead) {
      if (path === '/') {
        const name = (env.OWNER_NAME ?? '').trim();
        const html = availabilityHtml({
          title: env.PUBLIC_PAGE_TITLE || (name ? `Find a time with ${name}` : 'Find a time that works'),
          fallbackTz: env.CALENDAR_FALLBACK_TZ ?? 'America/Los_Angeles',
          footer: buildFooter(env),
          contactHref: contactAvailable(env) ? '/contact' : undefined,
          chat: chatEnabled(env) && schedulingEnabled(env)
            ? {
                heading: name ? `Chat with ${name}` : 'Chat to book a time',
                greeting: `Hi! Tell me roughly when you'd like to meet${name ? ` ${name}` : ''} — e.g. "30 minutes next week, afternoons" — and I'll find open times.`,
                turnstileSiteKey: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY ?? '') : '',
              }
            : undefined,
        });
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
        });
      }
      if (path === '/contact') {
        const name = (env.OWNER_NAME ?? '').trim();
        const html = contactHtml({
          heading: name ? `Contact ${name}` : 'Contact me',
          homeHref: '/',
          ownerEmail: env.BOOKING_OWNER_EMAIL,
          enabled: contactEnabled(env),
          footer: buildFooter(env),
        });
        return new Response(html, {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
        });
      }
      if (path === '/availability.ics') return serveObject(env, PUBLIC_KEY);
      if (path === '/freebusy.json') {
        return serveObject(env, PUBLIC_FREEBUSY_KEY, 'application/json; charset=utf-8', CORS);
      }
      if (path === '/slots.json') return handleSlots(url, env);
      if (path === '/embed.js') {
        return new Response(EMBED_JS, {
          headers: {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'public, max-age=3600',
            ...CORS,
          },
        });
      }
      if (path === '/book') {
        const name = (env.OWNER_NAME ?? '').trim();
        const cfg: BookingPageCfg = {
          owner: env.BOOKING_OWNER_EMAIL ?? '',
          title: env.BOOKING_TITLE ?? (name ? `Meeting with ${name}` : 'Meeting'),
          flavor: env.BOOKING_OUTLOOK_FLAVOR ?? 'office',
          tz: env.AVAILCAL_DEFAULT_TZ ?? 'America/New_York',
          durationMin: env.SCHEDULE_SLOT_MINUTES ?? '30',
          heading: name ? `Book a time with ${name}` : 'Book a time',
          footer: buildFooter(env),
          homeHref: '/',
          contactHref: contactAvailable(env) ? '/contact' : undefined,
          fallbackTz: env.CALENDAR_FALLBACK_TZ ?? 'America/Los_Angeles',
          slotsBase: '', // same origin
          scheduling: {
            enabled: schedulingEnabled(env),
            zoom: zoomEnabled(env),
            phone: (env.BOOKING_PHONE ?? '').trim(),
            turnstileSiteKey: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY ?? '') : '',
          },
        };
        return new Response(bookingHtml(cfg), {
          headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60' },
        });
      }
      if (path === '/chat' && chatEnabled(env) && schedulingEnabled(env)) {
        return serveChatPage(env, 'schedule');
      }
    }
    // Contact relay: accept the note and email it to the owner's mailbox.
    if (request.method === 'POST' && path === '/contact') {
      if (!contactEnabled(env)) {
        return jsonResponse({ error: 'Contact relay is not configured.' }, 503);
      }
      let payload: Record<string, unknown>;
      try {
        payload = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Invalid request.' }, 400);
      }
      if (typeof payload.company === 'string' && payload.company.trim()) {
        return jsonResponse({ ok: true }, 200); // honeypot: silently accept + drop
      }
      const v = validateMessage(payload as Record<string, string>);
      if (!v.ok) return jsonResponse({ error: v.error }, 400);
      const sent = await sendContact(env, v.msg);
      return sent.ok ? jsonResponse({ ok: true }, 200) : jsonResponse({ error: sent.error }, 502);
    }
    // "Book it for me": create the requested meeting on the owner's M365 calendar.
    if (request.method === 'POST' && path === '/book') {
      if (!schedulingEnabled(env)) return jsonResponse({ error: 'Booking is not configured.' }, 503);
      let payload: Record<string, unknown>;
      try {
        payload = (await request.json()) as Record<string, unknown>;
      } catch {
        return jsonResponse({ error: 'Invalid request.' }, 400);
      }
      if (typeof payload.company === 'string' && payload.company.trim()) {
        return jsonResponse({ ok: true }, 200); // honeypot: silently accept + drop
      }
      if (turnstileEnabled(env)) {
        const ok = await verifyTurnstile(
          env.TURNSTILE_SECRET ?? '', String(payload.turnstile ?? ''), request.headers.get('CF-Connecting-IP'),
        );
        if (!ok) return jsonResponse({ error: 'Verification failed — please retry.' }, 400);
      }
      const v = validateBooking(payload, {
        defaultSubject: env.BOOKING_TITLE ?? 'Meeting',
        zoomAvailable: zoomEnabled(env),
        phoneAvailable: Boolean((env.BOOKING_PHONE ?? '').trim()),
        nowMs: Date.now(),
      });
      if (!v.ok) return jsonResponse({ error: v.error }, 400);
      // Re-validate the slot server-side (anti double-book / tamper) with the SAME
      // rules as /slots.json — never trust the client's posted time.
      const obj = await env.AVAILCAL_BUCKET.get(PUBLIC_FREEBUSY_KEY);
      const busy: Busy[] = obj ? await obj.json() : [];
      const day = isoDate(Date.parse(v.booking.start));
      const slotMin = Number(env.SCHEDULE_SLOT_MINUTES ?? '30') || 30;
      let bookable = false;
      try {
        bookable = slotIsBookable(busy, {
          fromDate: day, toDate: day,
          tz: env.SCHEDULE_WORK_TZ || env.AVAILCAL_DEFAULT_TZ || 'America/New_York',
          durationMin: slotMin, stepMin: slotMin,
          workStart: env.SCHEDULE_WORK_START || '08:00',
          workEnd: env.SCHEDULE_WORK_END || '18:00',
          days: parseDays(env.SCHEDULE_DAYS || '1-5'),
          nowMs: Date.now(), maxSlots: 2000,
        }, v.booking.start, v.booking.end);
      } catch {
        bookable = false;
      }
      if (!bookable) return jsonResponse({ error: 'That time is no longer available.' }, 409);
      const token = await graphToken(env);
      if (!token) return jsonResponse({ error: 'Calendar authorization failed.' }, 502);
      const created = await createGraphEvent(
        env, token, buildGraphEvent(v.booking, { zoomLink: env.ZOOM_PERSONAL_LINK, ownerPhone: env.BOOKING_PHONE }),
      );
      if (!created.ok) return jsonResponse({ error: created.error }, 502);
      // Push a sync so the just-booked slot drops out of availability promptly,
      // and email the owner an alert — both in the background so the booker's
      // confirmation isn't blocked on them.
      ctx.waitUntil(triggerMerge(env).catch(() => {}));
      const notify = bookingNotifyConfig(env);
      if (notify) {
        const ntz = env.SCHEDULE_WORK_TZ || env.AVAILCAL_DEFAULT_TZ || 'UTC';
        const whenText =
          new Date(v.booking.start).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: ntz }) +
          ` ${ntz}`;
        ctx.waitUntil(sendBookingNotification(notify, v.booking, whenText).catch(() => {}));
      }
      return jsonResponse({ ok: true }, 200);
    }
    // Natural-language chat booker: the model parses intent; the Worker owns the
    // slots + booking (re-validated), so a small model can't book a bad time.
    if (request.method === 'POST' && path === '/chat') {
      if (!chatEnabled(env) || !schedulingEnabled(env)) {
        return jsonResponse({ error: 'Chat booking is not configured.' }, 503);
      }
      return handleChatRequest(env, ctx, request, 'schedule');
    }
    return new Response('not found', { status: 404, headers: CORS });
  }

  // --- serve the merged feed ---
  if (isRead && path === '/availability.ics') {
    const token = url.searchParams.get('token') ?? '';
    if (!safeEqual(token, env.FEED_TOKEN)) return new Response('forbidden', { status: 403 });
    return serveObject(env, MERGED_KEY);
  }

  // --- serve a per-source overlay ---
  if (isRead && RAW_ICS_RE.test(path)) {
    const token = url.searchParams.get('token') ?? '';
    if (!safeEqual(token, env.FEED_TOKEN)) return new Response('forbidden', { status: 403 });
    return serveObject(env, path.slice(1));
  }

  // --- owner's labeled busy JSON (backs the calendar view) ---
  // Authorized by EITHER the URL token OR a verified Cloudflare Access identity
  // (the page sends the CF_Authorization cookie on this same-origin fetch).
  if (isRead && path === '/busy.json') {
    const token = url.searchParams.get('token') ?? '';
    if (!safeEqual(token, env.FEED_TOKEN) && !(await verifyAccessJwt(request, env))) {
      return new Response('forbidden', { status: 403 });
    }
    return serveObject(env, MERGED_BUSY_KEY, 'application/json; charset=utf-8');
  }

  // --- newly-added busy blocks since the last run (backs the "new events"
  // notifications on the calendar view) — same auth as /busy.json. Returns an
  // empty list until the merge job has written one. ---
  if (isRead && path === '/notifications.json') {
    const token = url.searchParams.get('token') ?? '';
    if (!safeEqual(token, env.FEED_TOKEN) && !(await verifyAccessJwt(request, env))) {
      return new Response('forbidden', { status: 403 });
    }
    const obj = await env.AVAILCAL_BUCKET.get(ADDED_KEY);
    const body = obj ? obj.body : '[]';
    return new Response(body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // --- owner's calendar view ---
  // Token in the URL OR Cloudflare Access SSO (so the token can be dropped once
  // Access fronts /calendar). The page re-uses whatever got it here for /busy.json.
  if (isRead && path === '/calendar') {
    const token = url.searchParams.get('token') ?? '';
    if (!safeEqual(token, env.FEED_TOKEN) && !(await verifyAccessJwt(request, env))) {
      return new Response('forbidden', { status: 403 });
    }
    const calName = (env.OWNER_NAME ?? '').trim();
    const base = publicBase(env);
    const html = calendarHtml({
      title: calName ? `${calName}'s calendar` : 'My calendar',
      fallbackTz: env.CALENDAR_FALLBACK_TZ ?? 'America/Los_Angeles',
      footer: buildFooter(env),
      // Home stays on the PRIVATE side: the calendar itself is the private home,
      // so point back to it (preserving the token) rather than the public site.
      // Booking + contact live on the PUBLIC host, so those link absolutely.
      homeHref: `/calendar${token ? `?token=${encodeURIComponent(token)}` : ''}`,
      bookHref: base ? `${base}/book` : undefined,
      contactHref: contactHref(env) || undefined,
    });
    return new Response(html, {
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  // --- device-agent upload ---
  if (request.method === 'PUT' && RAW_JSON_RE.test(path)) {
    const tok = bearer(request);
    if (!tok || !safeEqual(tok, env.AGENT_TOKEN)) return new Response('unauthorized', { status: 401 });
    const key = path.slice(1); // raw/<source>.json
    await env.AVAILCAL_BUCKET.put(key, request.body, {
      httpMetadata: { contentType: 'application/json' },
    });
    return new Response(JSON.stringify({ status: 'ok', key }), {
      status: 201,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // --- manual trigger (admin) ---
  if (request.method === 'POST' && path === '/run') {
    const tok = bearer(request);
    if (!tok || !safeEqual(tok, env.RUN_TOKEN)) return new Response('unauthorized', { status: 401 });
    const resp = await triggerMerge(env);
    return new Response(await resp.text(), {
      status: resp.status,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (path === '/health') return new Response('ok');
  return new Response('not found', { status: 404 });
}

async function serveObject(
  env: Env,
  key: string,
  contentType = 'text/calendar; charset=utf-8',
  extra: Record<string, string> = {},
): Promise<Response> {
  const obj = await env.AVAILCAL_BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404, headers: extra });
  return new Response(obj.body, {
    headers: {
      'Content-Type': contentType,
      // Clients poll hourly; a few minutes of edge cache is plenty.
      'Cache-Control': 'public, max-age=300',
      ETag: obj.httpEtag,
      ...extra,
    },
  });
}

function jsonResponse(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function esc(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
}

// Bump this whenever the UI changes. It is shown (tiny) in the footer so you can
// confirm at a glance WHICH build a page is actually serving — ending any
// "is this the old cached version?" ambiguity.
const BUILD_TAG = 'b21 · 2026-06-24 outlook-app+holddrag';

/** Build the © footer HTML from env (empty when no owner configured). */
/**
 * Serve the chat UI. The entry point sets the persona:
 *  - 'schedule'  (public host /chat) — scheduling-focused greeting/heading.
 *  - 'assistant' (dedicated CHAT_HOST) — a personal assistant that also answers
 *    questions about the owner, then helps book.
 */
function serveChatPage(env: Env, mode: ChatMode): Response {
  const name = (env.OWNER_NAME ?? '').trim();
  const base = env.PUBLIC_FEED_HOST ? `https://${env.PUBLIC_FEED_HOST}` : '';
  const assistant = mode === 'assistant';
  const heading = assistant
    ? (name ? `Chat with ${name}'s assistant` : 'Chat with my assistant')
    : (name ? `Chat to book with ${name}` : 'Chat to book a time');
  const greeting = assistant
    ? `Hi! I'm ${name || 'the owner'}'s assistant. Ask me about ${name || 'them'} — what they work on, how to get in touch — or tell me when you'd like to meet and I'll find a time.`
    : `Hi! Tell me roughly when you'd like to meet${name ? ` ${name}` : ''} — e.g. "30 minutes next week, afternoons" — and I'll find open times.`;
  // On the standalone assistant host, "Home" should lead to the owner's actual
  // site rather than circling back to the scheduling host; fall back to the
  // public availability home when no site URL is configured.
  const ownerSite = (env.OWNER_SITE_URL ?? '').trim();
  const homeHref = assistant && ownerSite ? ownerSite : `${base}/`;
  const cfg: ChatPageCfg = {
    heading,
    homeHref,
    bookHref: `${base}/book`,
    footer: buildFooter(env),
    turnstileSiteKey: turnstileEnabled(env) ? (env.TURNSTILE_SITE_KEY ?? '') : '',
    greeting,
  };
  return new Response(chatPageHtml(cfg), {
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

/** Parse + Turnstile-verify a POST /chat, then run one turn. */
async function handleChatRequest(env: Env, ctx: ExecutionContext, request: Request, mode: ChatMode): Promise<Response> {
  let payload: Record<string, unknown>;
  try { payload = (await request.json()) as Record<string, unknown>; }
  catch { return jsonResponse({ error: 'Invalid request.' }, 400); }
  if (turnstileEnabled(env)) {
    const ok = await verifyTurnstile(env.TURNSTILE_SECRET ?? '', String(payload.turnstile ?? ''), request.headers.get('CF-Connecting-IP'));
    if (!ok) return jsonResponse({ error: 'Verification failed — please retry.' }, 400);
  }
  return handleChat(env, ctx, payload, mode);
}

/**
 * One turn of the chat booker. The model output is reduced to a structured
 * action; the Worker computes/validates slots and books — so the model can't
 * fabricate a time or skip the slot re-check.
 */
async function handleChat(env: Env, ctx: ExecutionContext, payload: Record<string, unknown>, mode: ChatMode): Promise<Response> {
  const history = Array.isArray(payload.messages)
    ? (payload.messages as Array<Record<string, unknown>>)
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: String(m.content).slice(0, 1000) }))
        .slice(-12)
    : [];
  if (!history.length) return jsonResponse({ error: 'No message.' }, 400);
  const proposed: Slot[] = Array.isArray(payload.proposed)
    ? (payload.proposed as Array<Record<string, unknown>>)
        .filter((s) => s && typeof s.start === 'string' && typeof s.end === 'string')
        .map((s) => ({ start: String(s.start), end: String(s.end) }))
        .slice(0, 10)
    : [];
  // Every slot start we've already shown this session, so a re-propose ("give me
  // more times") returns fresh options instead of repeating the same list.
  const seen: Set<string> = new Set(
    Array.isArray(payload.seen)
      ? (payload.seen as unknown[]).filter((x) => typeof x === 'string').map((x) => String(x)).slice(0, 300)
      : [],
  );
  for (const s of proposed) seen.add(s.start);

  const tz = env.SCHEDULE_WORK_TZ || env.AVAILCAL_DEFAULT_TZ || 'America/New_York';
  const durationMin = Number(env.SCHEDULE_SLOT_MINUTES ?? '30') || 30;
  const meetings = ['teams', ...(zoomEnabled(env) ? ['zoom'] : []), ...((env.BOOKING_PHONE ?? '').trim() ? ['phone'] : []), 'none'];
  const today = isoDate(Date.now());
  const bio = (env.OWNER_BIO ?? '').trim() || OWNER_BIO_DEFAULT;
  // Assistant mode answers about real projects: pull the owner's GitHub repos
  // (cached), falling back to the curated list if the lookup is unavailable.
  let projects = '';
  if (mode === 'assistant') {
    projects = (await fetchOwnerProjects(env, ctx).catch(() => '')) || OWNER_PROJECTS_FALLBACK;
  }
  const sys = systemPrompt({ todayIso: today, ownerName: (env.OWNER_NAME ?? 'me').trim() || 'me', tz, durationMin, proposed, meetings, mode, bio, projects });

  let action;
  try {
    action = parseAction(await callModel(env, sys, history));
  } catch (err) {
    // Surface the real cause: this fires when env.AI.run() rejects (bad model
    // id, model not enabled on the account, input rejected, etc.). Logged so it
    // shows up in `wrangler tail` / the dashboard (observability is enabled).
    console.error('chat: model call failed:', err instanceof Error ? `${err.name}: ${err.message}` : String(err));
    const body: Record<string, unknown> = { reply: 'Sorry — I had trouble there. Could you rephrase?' };
    if (env.CHAT_DEBUG === 'true') body.debug = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return jsonResponse(body, 200);
  }

  const obj = await env.AVAILCAL_BUCKET.get(PUBLIC_FREEBUSY_KEY);
  const busy: Busy[] = obj ? await obj.json() : [];
  const base = {
    tz, durationMin,
    workStart: env.SCHEDULE_WORK_START || '08:00', workEnd: env.SCHEDULE_WORK_END || '18:00',
    days: parseDays(env.SCHEDULE_DAYS || '1-5'), nowMs: Date.now(),
  };

  if (action.kind === 'propose') {
    const from = action.fromDate && /^\d{4}-\d\d-\d\d$/.test(action.fromDate) ? action.fromDate : today;
    const maxRange = Number(env.SCHEDULE_MAX_RANGE_DAYS ?? '62') || 62;
    const fromMs = Date.parse(from + 'T00:00:00Z');
    let to = action.toDate && /^\d{4}-\d\d-\d\d$/.test(action.toDate) ? action.toDate : isoDate(fromMs + 14 * DAY_MS);
    if (Date.parse(to + 'T00:00:00Z') - fromMs > maxRange * DAY_MS) to = isoDate(fromMs + maxRange * DAY_MS);
    const dur = action.durationMin && action.durationMin >= 5 && action.durationMin <= 480 ? action.durationMin : durationMin;
    let ranked: Slot[] = [];
    try {
      ranked = rankSlots(findSlots(busy, chatSlotParams({ ...base, durationMin: dur }, from, to)), { partOfDay: action.partOfDay, days: action.days, exclude: seen }, tz, 3);
    } catch { ranked = []; }
    return jsonResponse({ reply: formatProposedReply(action.reply ?? '', ranked, tz), proposed: ranked }, 200);
  }

  if (action.kind === 'book') {
    const pick = action.pickIndex && action.pickIndex >= 1 && action.pickIndex <= proposed.length ? proposed[action.pickIndex - 1] : null;
    if (!pick) return jsonResponse({ reply: action.reply || 'Which time works? Tell me the number from the list.', proposed }, 200);
    if (!action.email) return jsonResponse({ reply: "Great — what's the best email for the invite?", proposed }, 200);
    const day = isoDate(Date.parse(pick.start));
    let okSlot = false;
    try { okSlot = slotIsBookable(busy, chatSlotParams(base, day, day), pick.start, pick.end); } catch { okSlot = false; }
    if (!okSlot) return jsonResponse({ reply: 'Ah — that time just filled up. Want a few more options?', proposed: [] }, 200);
    const v = validateBooking(
      { start: pick.start, end: pick.end, email: action.email, name: action.name ?? '', subject: env.BOOKING_TITLE ?? 'Meeting', meeting: action.meeting ?? 'teams' },
      { defaultSubject: env.BOOKING_TITLE ?? 'Meeting', zoomAvailable: zoomEnabled(env), phoneAvailable: Boolean((env.BOOKING_PHONE ?? '').trim()), nowMs: Date.now() },
    );
    if (!v.ok) return jsonResponse({ reply: `Hmm: ${v.error}`, proposed }, 200);
    const token = await graphToken(env);
    if (!token) return jsonResponse({ reply: "I couldn't reach the calendar just now — please try again in a moment." }, 200);
    const created = await createGraphEvent(env, token, buildGraphEvent(v.booking, { zoomLink: env.ZOOM_PERSONAL_LINK, ownerPhone: env.BOOKING_PHONE }));
    if (!created.ok) return jsonResponse({ reply: 'Something went wrong creating the event — please try the booking page.' }, 200);
    ctx.waitUntil(triggerMerge(env).catch(() => {}));
    const whenText = new Date(pick.start).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: tz });
    const notify = bookingNotifyConfig(env);
    if (notify) ctx.waitUntil(sendBookingNotification(notify, v.booking, `${whenText} ${tz}`).catch(() => {}));
    return jsonResponse({ reply: `Done! You're booked for ${whenText} (${tz}). I've sent an invite to ${action.email}. 🎉`, booked: true }, 200);
  }

  return jsonResponse({ reply: action.reply || 'Happy to help you find a time — when works for you?' }, 200);
}

function buildFooter(env: Env): string {
  const owner = (env.FOOTER_OWNER ?? env.OWNER_NAME ?? '').trim();
  const year = new Date().getUTCFullYear();
  const url = (env.OWNER_SITE_URL ?? '').trim();
  const link = url
    ? ` · <a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\//, ''))}</a>`
    : '';
  const copyright = owner ? `© ${year} ${esc(owner)}. All rights reserved.${link}` : '';
  // "Built it myself" line: source link + the fact it runs on Cloudflare Workers.
  const src = (env.SOURCE_URL ?? '').trim();
  const srcLink = src ? `<a href="${esc(src)}" target="_blank" rel="noopener">source</a> · ` : '';
  const made = `<span class="madeby">⚡ Self-built · ${srcLink}runs on Cloudflare Workers</span>`;
  const lines = [copyright, made].filter(Boolean).join('<br>');
  // Build tag lives in an HTML comment — visible in view-source for diagnostics,
  // but not cluttering the page.
  return `<footer>${lines}</footer><!-- availcal build ${BUILD_TAG} -->`;
}

/** Origin of the PUBLIC host (where /book, /contact, / live), or '' if unset. */
function publicBase(env: Env): string {
  const host = (env.PUBLIC_FEED_HOST ?? '').trim();
  return host ? `https://${host}` : '';
}

/** A visitor can reach the owner if a relay is configured OR we have a mailto address. */
function contactAvailable(env: Env): boolean {
  return contactEnabled(env) || Boolean((env.BOOKING_OWNER_EMAIL ?? '').trim());
}

/** Absolute /contact URL on the public host, or '' when contact isn't available. */
function contactHref(env: Env): string {
  const base = publicBase(env);
  return base && contactAvailable(env) ? `${base}/contact` : '';
}

/**
 * Compute bookable free slots from the anonymized busy JSON in R2. All inputs
 * are query params with env-configurable defaults; the date range is clamped to
 * SCHEDULE_MAX_RANGE_DAYS to bound work.
 */
async function handleSlots(url: URL, env: Env): Promise<Response> {
  const q = url.searchParams;
  const nowMs = Date.now();
  // Working hours are the OWNER's business hours, interpreted in a fixed
  // business timezone (env), NOT the viewer's. The viewer's tz only changes how
  // the resulting UTC slots are displayed (done client-side), so it isn't needed
  // for computation. `displayTz` is echoed back as a hint.
  const workTz = env.SCHEDULE_WORK_TZ || env.AVAILCAL_DEFAULT_TZ || 'America/New_York';
  const displayTz = q.get('tz') || workTz;

  const fromDate = q.get('from') || isoDate(nowMs);
  const maxRange = Number(env.SCHEDULE_MAX_RANGE_DAYS ?? '62') || 62;
  const fromMs = Date.parse(fromDate + 'T00:00:00Z');
  let toDate = q.get('to') || isoDate(nowMs + 7 * DAY_MS);
  let toMs = Date.parse(toDate + 'T00:00:00Z');
  if (Number.isFinite(fromMs) && Number.isFinite(toMs)) {
    if (toMs < fromMs) toMs = fromMs;
    if (toMs - fromMs > maxRange * DAY_MS) toMs = fromMs + maxRange * DAY_MS;
    toDate = isoDate(toMs);
  }

  const num = (v: string | null, d: number) => {
    const n = Number(v);
    return v !== null && Number.isFinite(n) && n > 0 ? n : d;
  };
  const durationMin = num(q.get('duration'), Number(env.SCHEDULE_SLOT_MINUTES ?? '30') || 30);
  const stepMin = num(q.get('step'), durationMin);
  // Working hours come from env only (the owner controls them); default 08:00–18:00.
  const workStart = env.SCHEDULE_WORK_START || '08:00';
  const workEnd = env.SCHEDULE_WORK_END || '18:00';

  const obj = await env.AVAILCAL_BUCKET.get(PUBLIC_FREEBUSY_KEY);
  const busy: Busy[] = obj ? await obj.json() : [];

  try {
    const days = parseDays(q.get('days') || env.SCHEDULE_DAYS || '1-5');
    const slots = computeSlots(busy, {
      fromDate,
      toDate,
      tz: workTz, // working hours interpreted in the business timezone
      durationMin,
      stepMin,
      workStart,
      workEnd,
      days,
      nowMs,
      maxSlots: 2000,
    });
    return jsonResponse(
      { tz: displayTz, workTz, from: fromDate, to: toDate, durationMin, slots },
      200,
      { 'Cache-Control': 'public, max-age=60' },
    );
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 400);
  }
}
