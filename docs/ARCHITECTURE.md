# Architecture

AvailCal merges free/busy availability from many calendars into one private ICS
feed. This document is the decided design; it does not get redesigned per run.

## Goals & non-goals

**Goals**
- One private, read-only free/busy feed the owner subscribes to for planning.
- Cover accounts that *can't* publish ICS (work tenants behind Conditional
  Access) via on-device reads.
- Privacy by construction: no event content ever leaves a source.
- Source attribution: the owner can see *which* calendar each busy block came
  from, by a coarse one-word label.

**Non-goals**
- Not a sharing/scheduling product; the feed is never shared externally.
- Not a two-way sync; strictly read-only.
- Not an always-on service (see *Model B* below).

## Topology

```
Cloud-reachable accounts ─(secret ICS URL / CalDAV)─┐
                                                     ├─► Container Apps Job (cron, scale-to-zero)
Device-bound accounts ─(local agent → /raw JSON)─────┘     pull → normalize → merge → emit
                                                            ▼
                                    Blob:  /raw/*.json  +  /merged/availability.ics  +  /raw/*.ics
                                                            ▼
                          Apple Calendar / Thunderbird / Fantastical  (ICS subscription, hourly)
```

Two ingestion channels converge in one scheduled job that emits a single merged
ICS to blob storage. Clients subscribe to the blob URL.

## Model B: scheduled, scale-to-zero

The cloud component is a **scheduled job**, hourly (`0 * * * *`), **not** an
always-on server. It spins up, runs one pull→merge→emit→upload cycle, writes the
feed, and goes back to zero. Cost at idle is effectively nil. This is a
deliberate choice (Model B) over an always-on server (Model A).

### Deployment targets (same image, two homes)

The merge image is identical across targets; only orchestration + storage differ.

**Cloudflare (primary): Workers + Containers + R2.** A single **Worker**:

1. runs the **Cron Trigger** (hourly) which boots the merge **Container** (the
   `merge/` image, running its `availcal-server` HTTP server) and calls
   `POST /run`. The Container is fronted by a Durable Object and sleeps back to
   zero after `sleepAfter`;
2. **serves** the feed: `GET /availability.ics?token=…` streams from R2 via the
   native binding;
3. **accepts** device-agent uploads: `PUT /raw/<source>.json` (Bearer) → R2.

The Container is request-oriented (Cloudflare proxies HTTP to a port), which is
why the image runs a tiny HTTP server (`availcal/server.py`) by default rather
than a one-shot CLI. It writes to R2 with a scoped R2 API token (boto3). Defined
in `worker/wrangler.jsonc`; deployed with `wrangler deploy`.

**Azure (alternative): Container Apps Job + Blob.** A `Microsoft.App/jobs` with a
`Schedule` trigger runs the same image but overridden to the one-shot `availcal`
CLI (`command: ["availcal"]`), reads secrets from Key Vault, and writes to Blob
via Managed Identity. Defined in `infra/main.bicep`.

```
              Cloudflare                                  Azure
  ┌─────────────────────────────┐          ┌──────────────────────────────┐
  Cron→Worker→Container POST /run            ACA Job (Schedule) runs CLI
  Worker serves /availability.ics            client reads secret/SAS blob URL
  Worker PUT /raw/*.json → R2                agent PUT → SAS blob
  storage: R2                                storage: Azure Blob
  secrets: Workers Secrets                   secrets: Key Vault + Managed Identity
  ```

## Components

### 1. Pull (`merge/src/availcal/pull.py`)
- **ICS feeds**: `httpx.get` each secret URL with a 30s timeout and exponential
  backoff. A single feed failing is logged and skipped — it never aborts the
  run (one stale Google feed shouldn't blank your whole calendar).
- **CalDAV** (iCloud/Fastmail): `vdirsyncer` syncs into a local vdir; the `.ics`
  files are then read through the same normalize path. We don't reimplement
  CalDAV.
- **Device JSON**: `/raw/*.json` blobs pushed by the local agents are read and
  re-validated through the model (rejecting any naive/non-UTC data).

### 2. Normalize (`normalize.py`)
- Recurrence is expanded with **`recurring-ical-events`** over `[now, now+HORIZON]`
  (default 90 days). We never hand-roll RRULE/EXDATE.
- `TRANSP:TRANSPARENT` and free-status events are dropped.
- All-day (date-only `DTSTART`) is expanded as a full day in the component's
  TZID (fallback `DEFAULT_TZ`), then converted to UTC.
- Floating (naive) times are pinned to `DEFAULT_TZ`, then UTC.
- Output is a list of `BusyInterval`.

### 3. Merge (`merge.py`)
- **Dedup**: by `(source, uid)` first (same event via two feeds), then a fuzzy
  pass (same start/end within ±1 minute) within a source.
- **Collapse overlaps per-source only**: group by the one-word label and merge
  overlapping/adjacent blocks within each group into maximal blocks. Blocks from
  *different* sources are **never** merged — that would destroy attribution. The
  merged result may contain time-overlapping blocks, each keeping its own label.
- When a source's blocks collapse, the merged block takes the **strongest**
  status present (`oof` > `busy` > `tentative`).

### 4. Emit (`emit.py`)
- The **merged feed** is self-describing: each VEVENT's `SUMMARY` is the source's
  single word and `CATEGORIES` carries the same label (so clients can color/filter
  by source within the one feed). `TRANSP:OPAQUE`. `UID` is a stable hash of
  `(source, start, end)` — so the same time block from two calendars yields two
  distinct, separately-tagged events.
- **Per-source overlays** (`/raw/<Label>.ics`, optional) preserve the original
  event UID for anyone who prefers separate toggleable calendars. They still
  carry no event content.

### 5. Orchestrate (`main.py`)
Env-driven config; loads+validates the source registry; optionally resolves feed
secrets from a secret store; pulls all channels; merges; emits; and writes
through a **pluggable storage backend**.

### 6. Storage backends (`storage.py`)
One small contract — `upload(name, data)` + `iter_raw_json()` — with three
implementations selected by config (first wins): a **local directory**
(dev/CI/container demo), **Cloudflare R2** via its S3-compatible API (`boto3`),
and **Azure Blob** (connection string or Managed Identity). The object layout is
identical on every backend:

```
raw/<source>.json        # device-agent uploads (input)
merged/availability.ics  # the merged free/busy feed (output)
raw/<label>.ics          # optional per-source overlays (output)
```

R2 is the default target for the Cloudflare deployment (S3-compatible, **zero
egress fees** — ideal for an hourly-polled feed). The merge image is identical
across backends; only env vars differ.

## Data model & contracts

`BusyInterval` (frozen dataclass) is the only thing flowing through the
pipeline:

```python
start: datetime   # aware, UTC (validated)
end:   datetime   # aware, UTC (validated, > start)
source: str       # single-word label, ^\w+$ (validated)
status: str       # busy | tentative | oof
uid: str | None   # original UID, internal/per-source only
```

There is **no field** in which a title, description, attendee or location could
survive — that is the structural privacy guarantee.

**Agent upload JSON** (`/raw/<source-id>.json`): an array of
`{source, start, end, status}` with ISO-8601 UTC times and free dropped at the
source.

**Source registry** (`sources.toml`): the single place mapping every raw input
to its one-word label. Read by both the job and the agents. Labels validated as
unique single tokens; unmapped sources are slugified and logged.

## Time correctness

Every datetime passes through `timeutil.py`:
- `ensure_aware()` raises on naive input — no guessing zones.
- `to_utc()` converts aware → UTC.
- All-day/floating get explicit, documented handling.

DST boundaries, all-day events and floating times are the classic
silent-corruption zone; they are covered by `timeutil` plus dedicated tests
(a DST spring-forward, an all-day, and a floating event are all in the suite),
and `ruff`'s `DTZ` rule set gates naive datetime usage in CI.

## Freshness & the cache-staleness model (important, by design)

Different channels have different freshness, and we **design around it rather
than fight it**:

- **Google secret-iCal** feeds are cached by Google and can lag **hours** behind
  reality regardless of how often we poll. This is a provider property, not a
  bug. It is acceptable for *planning* — you'll see most commitments, just not
  the one created five minutes ago.
- **CalDAV** (iCloud/Fastmail) and **device reads** (Outlook COM / EventKit) are
  near-real-time and provide the freshness that the cached ICS feeds lack.

So: put accounts you need *fresh* on CalDAV or a device agent; secret-ICS is for
the long tail where hour-scale lag is fine.

## Security model

- **Secrets never touch git.** Only `.env.example` and `*.example` configs are
  committed. Real feed URLs and CalDAV passwords live in **Key Vault**; the job
  reads them at runtime via its **system-assigned managed identity** (Key Vault
  Secrets User).
- **Storage** is private (`allowBlobPublicAccess: false`); clients subscribe via
  a secret/SAS blob URL.
- **Agents** authenticate with a **write-scoped SAS** limited to their own blob
  path, or — preferred on Arc-enrolled machines — an **Arc Managed Identity**
  with Storage Blob Data Contributor on just the one container. No broad
  credentials live on endpoints. SAS is rotated quarterly (see RUNBOOK).

## Why no OAuth by default

The default design uses **secret-ICS / CalDAV / device reads — no OAuth**. This
avoids the personal-Gmail trap where, unless the OAuth consent app is published
to **Production**, refresh tokens expire after 7 days and the pipeline silently
breaks. If you ever add Gmail OAuth, publish the app to Production.
