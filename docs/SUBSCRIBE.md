# Subscribing your calendar client

AvailCal publishes one merged feed to blob storage at:

```
<container>/merged/availability.ics
```

Subscribe a client to a **secret/SAS URL** of that blob (read-only). Because the
feed is private, generate a long-lived **read-only SAS** for the merged blob (or
a stored access policy) and hand that URL to your clients. Never make the
container public.

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
