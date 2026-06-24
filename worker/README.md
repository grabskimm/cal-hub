# AvailCal — Cloudflare Worker + Container

The Cloudflare deployment of AvailCal. One Worker does four jobs, all
scale-to-zero:

1. **Hourly Cron Trigger** boots the **merge Container** (the `merge/` Python
   image) and calls `POST /run`, which pulls all sources, merges, and writes
   `merged/availability.ics` (+ per-source overlays, + optional anonymized public
   feeds) to **R2**.
2. **Serves the private feed**: `GET /availability.ics?token=…` streams from R2.
3. **Accepts device-agent uploads**: `PUT /raw/<source>.json` (Bearer auth) → R2.
4. **Public scheduling host** (optional, separate domain, token-free): anonymized
   `/availability.ics`, `/freebusy.json`, computed `/slots.json`, a slots demo,
   and a provider-agnostic booking page (`/book`).

```
Cron (hourly) ─► Worker.scheduled() ─► Container POST /run ─► pull/merge/emit ─► R2
Calendar client ─► Worker GET /availability.ics?token=… ─► R2 (text/calendar)
Device agent  ─► Worker PUT /raw/<src>.json (Bearer) ─► R2
Webpage       ─► Worker GET /slots.json (public host, CORS) ─► free slots JSON
```

> Requires a Cloudflare plan with **Containers** (Enterprise). R2 + Workers +
> Cron are on standard paid plans.

## Deploy end-to-end (clone → live)

Do these in order. Steps 1–9 stand up the private token feed; steps 3 + 10
add the public/scheduling host; step 11 wires device-bound accounts.

### 0. Prerequisites
- A Cloudflare account on a plan with **Containers** (Enterprise); R2, Workers,
  and Cron Triggers (paid).
- **Node 22+** and `npm` (wrangler 4.x requires Node ≥ 22). `wrangler` ships as a
  dev dependency here — no global install.
- Docker available locally if you run `wrangler deploy` from your machine (it
  builds the Container image); CI runners already have it.

### 1. Clone & install
```bash
git clone https://github.com/grabskimm/cal-centrel.git
cd cal-centrel/worker
npm ci
npx wrangler login          # or export CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
```

### 2. Create the R2 bucket + an API token
```bash
npx wrangler r2 bucket create availcal
```
Then in the dashboard: **R2 → Manage R2 API Tokens → Create** an **Object Read &
Write** token scoped to the `availcal` bucket. Note the **Account ID**, **Access
Key ID**, and **Secret Access Key** (used in step 5). Details:
[`infra/cloudflare/README.md`](../infra/cloudflare/README.md).

### 3. Choose your hosts (edit `wrangler.jsonc`)
- **Private feed (token):** works on `availcal.<your-subdomain>.workers.dev` out
  of the box, or a custom domain `availcal.example.com`.
- **Public + scheduling host (no token):** needs a **separate custom domain**
  (e.g. `availability.example.com`) — you can't host-split on a single
  `*.workers.dev` URL. Skip if you don't want the public endpoints.

In `wrangler.jsonc`:
- Uncomment/extend `routes` for your custom domain(s). The zone must already be
  in this Cloudflare account; Cloudflare provisions DNS + TLS on deploy.
- Set `PUBLIC_FEED_HOST` to your public hostname (or `""` to disable the public
  feed + scheduling entirely).
- Set `AVAILCAL_EMIT_PUBLIC` (`true`/`false`), `AVAILCAL_DEFAULT_TZ`, the
  `SCHEDULE_*` defaults, and (for the Outlook booking page) `BOOKING_OWNER_EMAIL`
  / `BOOKING_TITLE` / `BOOKING_OUTLOOK_FLAVOR`.

### 4. Define your sources (labels)
Edit [`../merge/sources.default.toml`](../merge/sources.default.toml): map each
ICS feed rawname, CalDAV account, or device calendar name to a **one-word label**
(this becomes the `SUMMARY`/`CATEGORIES` on the private feed). It is baked into
the Container image at build (override at runtime with `AVAILCAL_SOURCES_TOML` if
you prefer).

> Channels that work cleanly on Workers: **secret-ICS feeds** (Google/Outlook)
> and **device-agent JSON** (step 11). CalDAV (vdirsyncer) needs extra in-image
> config and is an advanced add-on here.
>
> **Keep your real mapping private.** `merge/sources.default.toml` is committed,
> so it must hold only generic placeholders. Put your actual labels in the
> **`SOURCES_TOML` secret** (step 5) — it's passed to the container at runtime and
> overrides the placeholder, so nothing private lands in git or the image. This
> also means CI/Actions deploys use your real mapping (from the secret) without it
> ever being committed.

### 5. Set secrets (`wrangler secret put`)
Everything sensitive is a Workers Secret — never in `wrangler.jsonc` or git:
```bash
# auth tokens — generate strong random values, e.g. `openssl rand -hex 32`
npx wrangler secret put FEED_TOKEN      # calendar clients append ?token=<this>
npx wrangler secret put AGENT_TOKEN     # device agents send Authorization: Bearer <this>
npx wrangler secret put RUN_TOKEN       # Worker<->Container + manual POST /run

# R2 credentials handed to the Container (boto3 → R2 S3 API)
npx wrangler secret put AVAILCAL_R2_ACCOUNT_ID
npx wrangler secret put AVAILCAL_R2_ACCESS_KEY_ID
npx wrangler secret put AVAILCAL_R2_SECRET_ACCESS_KEY

# secret ICS feed URLs: rawname=url,rawname=url  (rawnames match [ics] in sources.toml)
npx wrangler secret put AVAILCAL_ICS_FEEDS

# OPTIONAL: your real source registry as inline TOML, kept private (out of git
# and the image). Overrides the committed placeholder. e.g.:
#   printf '[ics]\nGoogPersonal="LoganG"\nOutlookPub="MendelG"\n' | npx wrangler secret put SOURCES_TOML
npx wrangler secret put SOURCES_TOML

# OPTIONAL: "Contact me" relay (the /contact page on the public host). The API
# key is the only secret; CONTACT_TO / CONTACT_FROM / CONTACT_PROVIDER live in
# wrangler.jsonc. Without a key, /contact still renders and falls back to a
# mailto: link to BOOKING_OWNER_EMAIL. Provider = "resend" (default) or "sendgrid".
npx wrangler secret put CONTACT_API_KEY
```

> **SSO on the private `/calendar`** — put it behind Cloudflare Access (Zero
> Trust) scoped to `/calendar*`. It's an edge policy: no Worker change, and the
> token-based feed endpoints are untouched. See
> [`infra/cloudflare/ACCESS.md`](../infra/cloudflare/ACCESS.md).

### 6. Validate
```bash
npm run typecheck     # tsc --noEmit
npm test              # vitest — slot-computation unit tests
npx wrangler types    # validates wrangler.jsonc + bindings
```

### 7. Deploy
```bash
npx wrangler deploy
```
Builds `../merge/Dockerfile`, pushes it to the Cloudflare container registry,
provisions the Durable Object + Container, binds R2, registers the hourly cron,
and (if `routes` are set) provisions custom-domain DNS + TLS.

### 8. Trigger the first run & verify
```bash
curl -X POST https://availcal.example.com/run -H "Authorization: Bearer <RUN_TOKEN>"
npx wrangler tail                                   # watch logs live
npx wrangler r2 object get availcal/merged/availability.ics --file -   # sanity
```
The hourly cron then keeps it fresh; you don't need to call `/run` again.

### 9. Subscribe calendar clients (private feed)
Apple Calendar / Thunderbird / Fantastical →
`https://availcal.example.com/availability.ics?token=<FEED_TOKEN>` (or the
`*.workers.dev` host). See [`docs/SUBSCRIBE.md`](../docs/SUBSCRIBE.md).

### 10. (Optional) public feed + web scheduling + Outlook booking
With step 3's public host set and `AVAILCAL_EMIT_PUBLIC=true`, the public host
serves the anonymized ICS, `/freebusy.json`, `/slots.json`, a slots demo at `/`,
and a **booking page at `/book`** — all token-free. See
[Public anonymized feed](#public-anonymized-feed-optional),
[Web scheduling endpoints](#web-scheduling-endpoints-on-the-public-host), and
[Booking](#booking-provider-agnostic-read-only).

### 11. (Optional) device agents — Conditional-Access work accounts
On each machine where that account is signed in, set:
```bash
AVAILCAL_AGENT_SAS_URL=https://availcal.example.com/raw/<Label>.json
AVAILCAL_AGENT_TOKEN=<AGENT_TOKEN>
```
then install per [`agents/windows/README.md`](../agents/windows/README.md) or
[`agents/macos/README.md`](../agents/macos/README.md). Hourly uploads land in R2
and fold into the next merge.

For local development instead of deploying: `cp .dev.vars.example .dev.vars`
(fill in), then `npx wrangler dev`.

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/availability.ics?token=…` | `FEED_TOKEN` (query) | merged feed (text/calendar) |
| GET | `/raw/<Label>.ics?token=…` | `FEED_TOKEN` (query) | per-source overlay |
| PUT | `/raw/<source>.json` | `AGENT_TOKEN` (Bearer) | device-agent upload |
| POST | `/run` | `RUN_TOKEN` (Bearer) | manual merge trigger |
| GET | `/health` | none | liveness |

## Public anonymized feed (optional)

In addition to the private token feed, you can expose a **fully-anonymized
public** free/busy feed on its own hostname — no token, no calendar names, no
source labels, and sources unioned so a viewer can't even tell how many
calendars you have. It answers only "busy or free, when".

```
private:  https://availcal.example.com/availability.ics?token=<FEED_TOKEN>   (named, token)
public:   https://availability.example.com/availability.ics                  (just "Busy", no token)
```

Enable it:

1. Set `AVAILCAL_EMIT_PUBLIC: "true"` in `wrangler.jsonc` `vars` so the merge job
   writes `public/availability.ics` to R2.
2. Set `PUBLIC_FEED_HOST` to the hostname that serves it (e.g.
   `availability.example.com`) and add that hostname to the `routes` block.
3. `npx wrangler deploy`.

On `PUBLIC_FEED_HOST` the Worker serves **only** anonymized reads — the token
feed, per-source overlays, uploads, and `/run` are all unreachable there, so the
public hostname can never expose labels or accept writes.

### Web scheduling endpoints (on the public host)

For driving a "pick a time" UI from a webpage, the public host also serves JSON
with permissive CORS (`Access-Control-Allow-Origin: *`):

| Path | Returns |
| --- | --- |
| `GET /` | A self-contained demo page that renders bookable slots. |
| `GET /freebusy.json` | Anonymized busy blocks: `[{"start","end"}]` (UTC). |
| `GET /slots.json?…` | Computed **free** slots (see params below). |
| `GET /book` | A **booking page**: free slots → modal that launches Gmail / Outlook / Mail / calendar. |
| `GET /contact` | A **"contact me" note form** (relays to your mailbox; mailto: fallback). |
| `POST /contact` | Relay endpoint: `{name,email,message}` → emailed to `CONTACT_TO` via Resend/SendGrid. |
| `GET /embed.js` | Embeddable widget script (injects an iframe to `/book` or `/`). |
| `GET /availability.ics` | The anonymized ICS (calendar subscription). |

Private host (token-gated, on `availcal.<domain>`):

| Path | Returns |
| --- | --- |
| `GET /availability.ics?token=…` | merged, labeled feed (calendar subscription) |
| `GET /calendar?token=…` | **your week calendar view** — busy blocks labeled by source |
| `GET /busy.json?token=…` | merged, labeled busy blocks as JSON (backs the calendar view) |

`/slots.json` query params (all optional; env sets the defaults):

| Param | Default | Meaning |
| --- | --- | --- |
| `from` / `to` | today / +7d | date range (YYYY-MM-DD), clamped to `SCHEDULE_MAX_RANGE_DAYS` |
| `tz` | `AVAILCAL_DEFAULT_TZ` | IANA timezone the working hours are interpreted in |
| `duration` | `SCHEDULE_SLOT_MINUTES` | slot length in minutes |
| `step` | = `duration` | gap between slot starts |
| `workStart` / `workEnd` | `SCHEDULE_WORK_START/END` | working hours, local `HH:MM` |
| `days` | `SCHEDULE_DAYS` | allowed weekdays, e.g. `1-5` (0=Sun) |

Response: `{ "tz", "from", "to", "durationMin", "slots": [{"start","end"}] }`,
slot times in UTC. Slot computation handles DST correctly (unit-tested in
`test/slots.test.ts`). It's **read-only** — slots come from your busy data; the
page wires the chosen slot into its own booking flow (the demo dispatches an
`availcal:slot-selected` event). Example fetch:

```js
const r = await fetch('https://availability.example.com/slots.json?duration=30&tz=America/New_York');
const { slots } = await r.json();   // [{ start: '2026-06-24T13:00:00.000Z', end: '…' }, …]
```

> ⚠️ This endpoint is genuinely public: anyone with the URL sees your busy/free
> windows (not the contents). It's anonymized — no titles, names, or source
> count — but the time windows themselves are visible. Leave it off unless you
> want that.

### Booking (provider-agnostic, read-only)

`GET /book` on the public host is a ready-made booking page that **uses the
availability AvailCal generates** (it fetches the same `/slots.json`, so only
genuinely-free times are offered). The booker's platform is unknown, so picking a
slot opens a **modal that launches their preferred app**, prefilled with the time:

- **Email the request** — opens **Gmail**, **Outlook mail**, or the **default Mail
  app** (`mailto:`) composing a message to you with the chosen time.
- **Add to calendar** — **Google Calendar** / **Outlook Calendar** quick-links
  (you're added as guest/invitee), or a universal **`.ics`** download for Apple
  Calendar / Outlook desktop / anything.

The Google/Outlook links add **you (the owner)** as guest/invitee, so saving on
those paths notifies you; the `.ics` is the universal fallback. There is **no
write credential, no OAuth, no backend** — AvailCal stays read-only. Once the
booked event lands on a calendar AvailCal already reads, that slot drops out of
availability on the next hourly merge (subject to the usual feed-cache lag).

Configure it with `vars` in `wrangler.jsonc`:

| Var | Meaning |
| --- | --- |
| `BOOKING_OWNER_EMAIL` | mailbox added as guest/invitee on the event |
| `BOOKING_TITLE` | default event subject |
| `BOOKING_OUTLOOK_FLAVOR` | which Outlook quick-link to use: `office` (M365) or `live` (personal) |

> **Why not a hosted tool (Calendly, Microsoft Bookings, Acuity)?** They derive
> availability from the calendar account they're *connected to* — they do **not**
> read an external feed — so they can't natively reflect AvailCal's *aggregated*
> availability. To use one anyway, subscribe AvailCal's **private** ICS feed into
> the calendar that tool checks for conflicts; caveat: subscribed-ICS refresh lags
> hours and not every tool honors subscribed calendars. The `/book` page avoids
> that by consuming `/slots.json` directly. If you want a hosted tool's polish
> (reminders, reschedule, payments) AND fully-automated booking, point your own
> backend at `/slots.json` and create events via the provider's API (Google /
> Microsoft Graph) — that backend, not AvailCal, holds the write credential.

### Your private calendar view

`GET /calendar?token=<FEED_TOKEN>` on the **private** host (e.g.
`https://availcal.example.com/calendar?token=…`) is a week-grid view of your
**labeled** busy blocks across every calendar — colored per source, with the
source name on each block, in a timezone you pick. It's gated by `FEED_TOKEN`
(the same token as the private feed) and reads `merge/busy.json` from R2.

### Embed on your site

Drop a single `<script>` tag where you want the widget; it injects a responsive
iframe to the booking page (or the availability page):

```html
<script src="https://availability.example.com/embed.js"
        data-view="book"
        data-height="640"
        async></script>
```

`data-view` is `book` (default) or `availability`; `data-height` is px or any CSS
height. Or embed the iframe directly (no script):

```html
<iframe src="https://availability.example.com/book"
        style="width:100%;height:640px;border:0;border-radius:16px"
        title="Book a time" loading="lazy"></iframe>
```

Both are token-free (public host) and use your live availability. The pages set
no `X-Frame-Options`, so they embed anywhere; restrict with a CSP
`frame-ancestors` on your own site if you want to limit which domains can frame it.

**Self-hosting** your own booking page instead of `/book`: copy the same flow —
`fetch('https://availability.example.com/slots.json?…')` (CORS is open), render
slots, then build the calendar links (the builders live in
[`src/calendar-links.ts`](src/calendar-links.ts)). The standalone demo at `/`
also dispatches an `availcal:slot-selected` event you can wire up however you
like.

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
