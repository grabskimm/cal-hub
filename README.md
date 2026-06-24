# AvailCal

Aggregate calendar availability from many accounts — Google, Outlook/M365,
iCloud/Fastmail, plus **device-bound work accounts behind Conditional Access** —
into a **single private free/busy ICS feed** you subscribe to for personal
planning. Read-only, private, never shared externally.

> **Privacy by construction, with source attribution.** AvailCal ingests **only
> busy intervals** — `start` / `end` / `status` plus a **single owner-assigned
> one-word source label**. Titles, descriptions, attendees and locations are
> stripped at the earliest point. The label becomes each event's `SUMMARY`
> (and `CATEGORIES`) so you can still tell *which* calendar a block came from —
> a coarse tag like `Work`, `Perso`, `iCloud`, never event content.

## How it works (Model B: scale-to-zero)

```
Cloud-reachable accounts ─(secret ICS URL / CalDAV)─┐
                                                     ├─► Container Apps Job (cron, scale-to-zero)
Device-bound accounts ─(local agent → /raw JSON)─────┘     pull → normalize → merge → emit
                                                            ▼
                                    Blob:  /raw/*.json  +  /merged/availability.ics  +  /raw/*.ics
                                                            ▼
                          Apple Calendar / Thunderbird / Fantastical  (ICS subscription, hourly)
```

A **scheduled, scale-to-zero job** (hourly cron, no always-on server) pulls every
source, normalizes all times to **UTC**, merges per-source busy blocks, and writes
one merged `availability.ics` to object storage. Your calendar clients subscribe
to that object. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

It runs on **Cloudflare Workers + Containers + R2** (primary — a Worker cron
drives the merge Container and serves the feed from R2) or an **Azure Container
Apps Job + Blob** (alternative). The same `merge/` image runs on both.

**Storage is pluggable.** The same image writes to **Cloudflare R2** (S3-compatible,
zero egress), **Azure Blob**, or a **local directory** — selected by env vars
(`AVAILCAL_OUTPUT_DIR` > R2 > Azure). For R2, see
[infra/cloudflare/README.md](infra/cloudflare/README.md).

The only bespoke code is the **device-bound local reads** (agents) and the
**free/busy merge**. Everything else reuses existing tools: `recurring-ical-events`
(recurrence), `vdirsyncer` (CalDAV), `icalendar` (parse/emit), native OS calendar
stores (device reads), OS schedulers (agents), and Container Apps (cloud timer).

## Repository layout

| Path | What |
| --- | --- |
| `merge/` | The Python merge job (pull → normalize → merge → emit) + `Dockerfile` |
| `agents/windows/` | Outlook COM exporter + Scheduled Task installer |
| `agents/macos/` | EventKit exporter + launchd agent installer |
| `infra/` | Bicep for Storage, Key Vault, and the scheduled Container Apps Job |
| `.github/workflows/` | CI (lint/test/build) and OIDC deploy |
| `docs/` | Architecture, getting ICS URLs, subscribing, and the runbook |
| `sources.example.toml` | The source registry (rawname → one-word label) |

## Quick start (clone → deployed)

### 0. Prerequisites
- Python 3.12, Docker, and the Azure CLI (`az`) with the Bicep extension.
- An Azure subscription and an Azure Container Registry (ACR).

### 1. Run the tests locally
```bash
cd merge
pip install -e '.[dev]'
ruff check .
pytest -q
```

### 2. Define your sources
Copy `sources.example.toml` to `sources.toml` and map each raw input (ICS feed,
CalDAV account, device calendar name) to a **single-word label**. Labels must be
unique single tokens — the job validates this at startup and fails fast.

### 3. Collect your secret feed URLs
Follow [docs/GET-ICS-URLS.md](docs/GET-ICS-URLS.md) to obtain each account's
secret ICS URL (Google secret-iCal, Outlook published ICS) or set up CalDAV
(iCloud/Fastmail via `vdirsyncer`). Work accounts that block published ICS use
the **device agents** instead.

### 4. Try it locally against your sources (optional)
```bash
cd merge
AVAILCAL_SOURCES_TOML=../sources.toml \
AVAILCAL_ICS_FEEDS='GoogPersonal=https://…/basic.ics' \
AVAILCAL_OUTPUT_DIR=./out \
python -m availcal.main
# -> ./out/merged/availability.ics  (and ./out/raw/<Label>.ics overlays)
```

### 5. Deploy the cloud job

Two supported targets — the **same `merge/` image** runs on both:

**Cloudflare (Workers + Containers + R2)** — primary. A Worker runs the hourly
cron, drives the merge Container, serves the feed from R2, and accepts agent
uploads. See [worker/README.md](worker/README.md) and
[infra/cloudflare/README.md](infra/cloudflare/README.md).
```bash
wrangler r2 bucket create availcal          # one-time
cd worker
npm ci
npm run typecheck                           # tsc --noEmit
npx wrangler types                          # validate wrangler.jsonc + bindings
# set secrets once (FEED_TOKEN, AGENT_TOKEN, RUN_TOKEN, AVAILCAL_R2_*, AVAILCAL_ICS_FEEDS):
wrangler secret put FEED_TOKEN              # …repeat per secret (see worker/README.md)
npx wrangler deploy                         # builds+pushes the Container, binds R2, registers cron
# local dev: cp .dev.vars.example .dev.vars && npx wrangler dev
```
CI runs `wrangler types` + `tsc` on every PR; `npx wrangler deploy` runs from
`.github/workflows/deploy-cloudflare.yml` (manual/tag).

**Azure (Container Apps Job)** — alternative.
```bash
az acr login --name <ACR_NAME>
docker build -t <ACR_LOGIN_SERVER>/availcal:v1 ./merge
docker push <ACR_LOGIN_SERVER>/availcal:v1
./infra/deploy.sh availcal-rg eastus containerImage=<ACR_LOGIN_SERVER>/availcal:v1
```
Then load feed secrets into Key Vault / Workers Secrets and trigger a run — see
[docs/RUNBOOK.md](docs/RUNBOOK.md).

### 6. Install the device agents (for Conditional-Access work accounts)
- **Windows:** [agents/windows/README.md](agents/windows/README.md) — dry-run,
  then `Install-Task.ps1` for the hourly Scheduled Task.
- **macOS:** [agents/macos/README.md](agents/macos/README.md) — grant Calendar
  access (TCC), dry-run, then `install.sh` for the hourly launchd agent.

### 7. Subscribe your calendar client
Point Apple Calendar / Thunderbird / Fantastical at the feed URL — on Cloudflare
that's `https://availcal.example.com/availability.ics?token=<FEED_TOKEN>` (your
custom domain, or the `*.workers.dev` host) — see [docs/SUBSCRIBE.md](docs/SUBSCRIBE.md).

## Privacy & correctness guarantees

- **No event content leaves a source.** The internal model has no field that can
  carry a title/location/attendee; only `{start, end, source, status, uid}`.
- **The merged feed never carries the original UID** (it uses a stable hash of
  `source+start+end`); per-source overlay feeds keep the original UID for dedup.
- **All datetimes are timezone-aware UTC** from ingestion. A naive datetime is a
  hard error, and `ruff`'s `DTZ` rules gate against naive comparisons in CI.
- **Overlaps collapse only within a source**, never across — two calendars busy
  at the same time stay two separately-tagged events, preserving attribution.
- **Optional public feed**: a second, **fully-anonymized** feed
  (`public/availability.ics`) unions all sources into bare `Busy` blocks — no
  labels, no source count — for a token-free host like `availability.example.com`.
  Off by default; see [worker/README.md](worker/README.md#public-anonymized-feed-optional).
- **Web scheduling endpoints**: on the public host, `GET /freebusy.json` and a
  computed `GET /slots.json` (CORS-enabled) let a webpage render bookable free
  slots; a demo page is served at `/`. Read-only — booking is wired by your page.
- **Booking page (any platform)**: `GET /book` turns a free slot into a calendar
  event — universal `.ics` download + Add-to-Google/Outlook links (you're the
  invitee). Works whatever calendar the booker uses; no write credential —
  AvailCal stays read-only.

## Known, accepted properties

- **Google secret-iCal feeds lag by hours** regardless of poll rate (provider
  cache). This is fine for planning; CalDAV and device reads provide freshness.
  We document this rather than fight it — see ARCHITECTURE/RUNBOOK.
- The default design uses **secret-ICS, not OAuth**, so there are no refresh
  tokens to expire. (If you ever add personal-Gmail OAuth, the consent app must
  be published to *Production* or tokens die after 7 days.)

## License

MIT.
