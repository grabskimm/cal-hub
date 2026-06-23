# AvailCal — Cloudflare Worker + Container

The Cloudflare deployment of AvailCal. One Worker does three jobs, all
scale-to-zero:

1. **Hourly Cron Trigger** boots the **merge Container** (the `merge/` Python
   image) and calls `POST /run`, which pulls all sources, merges, and writes
   `merged/availability.ics` (+ per-source overlays) to **R2**.
2. **Serves the feed**: `GET /availability.ics?token=…` streams from R2.
3. **Accepts device-agent uploads**: `PUT /raw/<source>.json` (Bearer auth) → R2.

```
Cron (hourly) ─► Worker.scheduled() ─► Container POST /run ─► pull/merge/emit ─► R2
Calendar client ─► Worker GET /availability.ics?token=… ─► R2 (text/calendar)
Device agent  ─► Worker PUT /raw/<src>.json (Bearer) ─► R2
```

> Requires a Cloudflare plan with **Containers** (Enterprise). R2 + Workers +
> Cron are on standard paid plans.

## Prerequisites

- Node 18+ and `npm`.
- `wrangler` (installed as a dev dependency here): `npm install`.
- An R2 bucket named `availcal` (see [`infra/cloudflare/README.md`](../infra/cloudflare/README.md)).
- An R2 API token (Object Read & Write on that bucket) for the Container.

## Configure

Non-secret config lives in `wrangler.jsonc` (`vars`). Everything sensitive is a
**Workers Secret**:

```bash
cd worker
npm install

# Auth tokens (generate strong random values, e.g. `openssl rand -hex 32`)
wrangler secret put FEED_TOKEN      # clients append ?token=<this>
wrangler secret put AGENT_TOKEN     # device agents send Authorization: Bearer <this>
wrangler secret put RUN_TOKEN       # Worker<->Container + manual POST /run

# R2 credentials handed to the Container (boto3 S3 against R2)
wrangler secret put AVAILCAL_R2_ACCOUNT_ID
wrangler secret put AVAILCAL_R2_ACCESS_KEY_ID
wrangler secret put AVAILCAL_R2_SECRET_ACCESS_KEY

# Secret ICS feed URLs (rawname=url,rawname=url; matches sources.toml [ics] keys)
wrangler secret put AVAILCAL_ICS_FEEDS
```

For local development, copy `.dev.vars.example` to `.dev.vars` (gitignored) and
fill it in; `wrangler dev` reads it.

## Typecheck / deploy

```bash
npm run typecheck        # tsc --noEmit
npm run deploy           # wrangler deploy (builds + pushes the Container image)
```

`wrangler deploy` builds `../merge/Dockerfile`, pushes it to the Cloudflare
container registry, provisions the Durable Object + Container, binds R2, and
registers the hourly cron. (In a restricted build network you'd hit the same
Docker Hub / pip egress limits as any image build; in normal CI it just works.)

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/availability.ics?token=…` | `FEED_TOKEN` (query) | merged feed (text/calendar) |
| GET | `/raw/<Label>.ics?token=…` | `FEED_TOKEN` (query) | per-source overlay |
| PUT | `/raw/<source>.json` | `AGENT_TOKEN` (Bearer) | device-agent upload |
| POST | `/run` | `RUN_TOKEN` (Bearer) | manual merge trigger |
| GET | `/health` | none | liveness |

## Custom domain (Enterprise)

To serve the feed from your own hostname instead of `*.workers.dev`:

1. Make sure the domain (e.g. `example.com`) is a **zone in this Cloudflare
   account**.
2. In `wrangler.jsonc`, uncomment the `routes` line and set your hostname:
   ```jsonc
   "routes": [{ "pattern": "availcal.example.com", "custom_domain": true }],
   ```
3. `npx wrangler deploy` — Cloudflare provisions the DNS record and TLS cert and
   maps the **whole hostname (all paths)** to this Worker.

The feed is then
`https://availcal.example.com/availability.ics?token=<FEED_TOKEN>`, uploads go to
`https://availcal.example.com/raw/<Label>.json`, etc. The `*.workers.dev` URL
keeps working alongside it. Leave the line commented until the zone exists, or
deploy fails on an unknown zone.

## Point clients & agents at the Worker

- **Calendar clients** (see [`docs/SUBSCRIBE.md`](../docs/SUBSCRIBE.md)) subscribe
  to `https://availcal.example.com/availability.ics?token=<FEED_TOKEN>` (custom
  domain) or the `*.workers.dev` equivalent.
- **Device agents** set
  `AVAILCAL_AGENT_SAS_URL=https://availcal.example.com/raw/<Label>.json`
  and `AVAILCAL_AGENT_TOKEN=<AGENT_TOKEN>`. The agents send the Bearer token
  automatically; no presigned URLs needed.

## Why a server in the container?

Cloudflare Containers are request-oriented (a Worker proxies HTTP to a port), so
the image runs `availcal-server` by default and the Worker calls `POST /run`.
The same image still runs a one-shot `availcal` CLI for Azure Container Apps Jobs
or local use — the command is just overridden there.
