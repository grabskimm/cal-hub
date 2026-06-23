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
 * The Container computes + writes to R2 with a scoped R2 token (boto3); the
 * Worker serves + accepts uploads via its R2 binding. Both touch one bucket.
 */
import { Container, getContainer } from '@cloudflare/containers';

export interface Env {
  // Durable Object namespace backing the merge Container.
  MERGE_CONTAINER: DurableObjectNamespace<MergeContainer>;
  // Native R2 binding used for serving the feed and accepting agent uploads.
  AVAILCAL_BUCKET: R2Bucket;

  // --- auth tokens (Workers Secrets) ---
  FEED_TOKEN: string; // read the merged feed (?token=)
  AGENT_TOKEN: string; // device-agent PUT uploads (Bearer)
  RUN_TOKEN: string; // Worker<->Container trigger + manual POST /run (Bearer)

  // --- config passed through to the Container process ---
  AVAILCAL_R2_BUCKET: string;
  AVAILCAL_R2_ACCOUNT_ID: string;
  AVAILCAL_R2_ACCESS_KEY_ID: string;
  AVAILCAL_R2_SECRET_ACCESS_KEY: string;
  AVAILCAL_ICS_FEEDS: string;
  AVAILCAL_DEFAULT_TZ: string;
  AVAILCAL_HORIZON_DAYS: string;
  AVAILCAL_INCLUDE_TENTATIVE: string;
}

const MERGED_KEY = 'merged/availability.ics';
const RAW_ICS_RE = /^\/raw\/[A-Za-z0-9_]+\.ics$/;
const RAW_JSON_RE = /^\/raw\/[A-Za-z0-9_]+\.json$/;

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
      // Sources + merge behaviour.
      AVAILCAL_ICS_FEEDS: env.AVAILCAL_ICS_FEEDS ?? '',
      AVAILCAL_DEFAULT_TZ: env.AVAILCAL_DEFAULT_TZ ?? 'America/New_York',
      AVAILCAL_HORIZON_DAYS: env.AVAILCAL_HORIZON_DAYS ?? '90',
      AVAILCAL_INCLUDE_TENTATIVE: env.AVAILCAL_INCLUDE_TENTATIVE ?? 'true',
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

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- serve the merged feed ---
    if (request.method === 'GET' && path === '/availability.ics') {
      const token = url.searchParams.get('token') ?? '';
      if (!safeEqual(token, env.FEED_TOKEN)) return new Response('forbidden', { status: 403 });
      return serveObject(env, MERGED_KEY);
    }

    // --- serve a per-source overlay ---
    if (request.method === 'GET' && RAW_ICS_RE.test(path)) {
      const token = url.searchParams.get('token') ?? '';
      if (!safeEqual(token, env.FEED_TOKEN)) return new Response('forbidden', { status: 403 });
      return serveObject(env, path.slice(1));
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
  },
};

async function serveObject(env: Env, key: string): Promise<Response> {
  const obj = await env.AVAILCAL_BUCKET.get(key);
  if (!obj) return new Response('not found', { status: 404 });
  return new Response(obj.body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      // Clients poll hourly; a few minutes of edge cache is plenty.
      'Cache-Control': 'public, max-age=300',
      ETag: obj.httpEtag,
    },
  });
}
