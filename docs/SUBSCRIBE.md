# Subscribing your calendar client

AvailCal publishes one merged feed at object key `merged/availability.ics`.
Subscribe clients to a **private, read-only URL** of it:

- **Cloudflare (primary):** a custom domain
  `https://availcal.example.com/availability.ics?token=<FEED_TOKEN>` (or the
  `*.workers.dev` equivalent) — the Worker streams it from R2 and checks the
  token. Per-source overlays are `…/raw/<Label>.ics?token=<FEED_TOKEN>`. See
  [worker/README.md](../worker/README.md#custom-domain-enterprise) to enable the
  custom domain.
- **Azure:** a long-lived **read-only SAS** URL for the merged blob (or a stored
  access policy). Never make the container public.

### Optional public, anonymized feed

You can also expose a token-free, fully-anonymized feed on its own host (e.g.
`https://availability.example.com/availability.ics`). It shows only `Busy`
blocks — no titles, no source names, and sources are unioned so the calendar
count can't be inferred. Use this when you want to hand someone a "when am I
free" link without a token and without revealing anything but the time windows.
Enable it via the Worker (see
[worker/README.md](../worker/README.md#public-anonymized-feed-optional)); it is
**off by default**.

### Embedding availability in a webpage (scheduling)

For a "pick a time" UI rather than a calendar subscription, the public host also
serves JSON with CORS: `GET /freebusy.json` (anonymized busy blocks) and
`GET /slots.json?duration=30&tz=America/New_York&workStart=09:00&workEnd=17:00`
(computed bookable free slots). A copy-pasteable demo page lives at `/` on the
public host. This stays read-only — your page wires the chosen slot into its own
booking flow. Full param reference:
[worker/README.md](../worker/README.md#web-scheduling-endpoints-on-the-public-host).

**Booking (any platform):** `GET /book` on the public host turns those free slots
into a calendar event the booker can add anywhere — a universal `.ics` download
plus Add-to-Google and Add-to-Outlook links (you're added as invitee/guest). No
write credential; AvailCal stays read-only. Hosted tools like Calendly can't read
an external feed, so this page consumes `/slots.json` directly. Details:
[worker/README.md](../worker/README.md#booking-provider-agnostic-read-only).

> The merged feed is **self-describing**: each block's **title is its source's
> one word** (e.g. `Work`, `Perso`, `iCloud`), and `CATEGORIES` carries the same
> label so capable clients can color/filter by source — all within this single
> feed. So it answers both *"am I free?"* and *"from which calendar?"* at a
> glance. You do **not** need the per-source overlays for this.

## Apple Calendar (macOS / iOS)

1. **File → New Calendar Subscription…**
2. Paste the merged blob (SAS) URL → **Subscribe**.
3. Set **Auto-refresh** to **Every hour** (matches the job cadence).
4. Optional: choose a color; with `CATEGORIES` you already get per-source
   distinction inside the feed.

## Thunderbird

1. **Calendar → New Calendar → On the Network**.
2. Format **iCalendar (ICS)**, paste the merged blob URL.
3. Set refresh to hourly.

## Fantastical

1. **Settings → Calendar Accounts → Add Account → Calendar Subscription (URL)**.
2. Paste the merged blob URL; set refresh to hourly.

## Optional: per-source overlay calendars

If you prefer separate, individually-toggleable calendars (one color each),
subscribe to the per-source overlays instead of (or alongside) the merged feed:

```
<container>/raw/Work.ics
<container>/raw/Perso.ics
<container>/raw/iCloud.ics
…
```

These are emitted when `AVAILCAL_EMIT_PER_SOURCE=true` (the default). Add each as
its own subscription and give each its own color. Most people just use the single
merged feed, since it already carries per-source labels and categories.

## Refresh expectations

- Clients poll **hourly**; the job also runs **hourly**. Worst case end-to-end
  latency is roughly two hours plus any provider cache lag.
- **Google secret-iCal blocks can be hours stale** by the provider's design —
  see [ARCHITECTURE.md](ARCHITECTURE.md#freshness--the-cache-staleness-model-important-by-design).
  CalDAV/device-sourced blocks are near-real-time.
