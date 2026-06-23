# Getting your secret ICS URLs (and CalDAV)

This is the manual, click-path part of setup. Every URL and password here is a
**secret** — store it in Key Vault (cloud) or your `.env` (local dev), never in
git. Each maps to a one-word label in `sources.toml`.

> Rule of thumb: if an account can give you a **secret ICS URL** or **published
> ICS**, use it (cloud channel). If the work tenant blocks both — which is
> common behind Conditional Access — use a **device agent** instead.

## Google Calendar — Secret iCal address

1. Open **Google Calendar → Settings** (gear → *See all settings*).
2. In the left sidebar, **select the specific calendar** under *Settings for my
   calendars*.
3. Scroll to **Integrate calendar**.
4. Copy the **Secret address in iCal format** — it ends in `…/basic.ics`.

- **Do NOT** use *Make available to public*. The secret address is private to
  whoever holds the URL; treat it like a password.
- Workspace (work) admins can disable secret URLs. If the field is missing or
  disabled, fall back to **CalDAV** or the **device agent**.
- Remember the [cache-staleness property](ARCHITECTURE.md#freshness--the-cache-staleness-model-important-by-design):
  Google's secret-iCal lags by hours. Fine for planning.

## Outlook.com / Microsoft 365 personal — Publish a calendar

1. Outlook web → **Calendar → Settings** (gear).
2. **Shared calendars** (a.k.a. *Calendars → Shared calendars*).
3. Under **Publish a calendar**, pick the calendar and **"Can view all
   details"**, then **Publish**.
4. Copy the **ICS** link (not the HTML link).

- **Work/EDU tenants usually disable publishing.** If you can't publish, use the
  **Windows device agent** (Outlook COM) — it reads the already-synced store and
  works behind Conditional Access without any server-side publish.

## iCloud / Fastmail — CalDAV (no clean secret ICS)

Neither offers a clean secret-ICS export, so use **CalDAV via `vdirsyncer`** with
an **app-specific password** (never your main password):

- **iCloud**: create an app-specific password at
  **appleid.apple.com → Sign-In and Security → App-Specific Passwords**. Server:
  `https://caldav.icloud.com/`.
- **Fastmail**: **Settings → Privacy & Security → App Passwords** → create one
  scoped to *Calendars (CalDAV)*. Server:
  `https://caldav.fastmail.com/dav/calendars/user/<you>/`.

Fill these into `merge/vdirsyncer/config` (copy from `config.example`). The
collection directory name must match a key in the `[caldav]` section of
`sources.toml`. The merge container has `vdirsyncer` baked in; enable the channel
with `AVAILCAL_ENABLE_CALDAV=1`.

## Device-bound work accounts — no URL at all

For a work calendar that blocks both secret-ICS and publishing, there is no URL.
Use the local agent on a machine where that account is already signed in and
synced:

- **Windows + Outlook desktop** → [agents/windows/README.md](../agents/windows/README.md)
- **macOS + Calendar.app** → [agents/macos/README.md](../agents/macos/README.md)

The agent reads the **local** store (no network calendar call), strips everything
to busy intervals, and pushes `/raw/<Label>.json` to blob storage.

## Where to put them

| Channel | Local dev | Cloud (production) |
| --- | --- | --- |
| Secret ICS URLs | `AVAILCAL_ICS_FEEDS` in `.env` | Key Vault secret `ics-<rawname>` |
| CalDAV passwords | `merge/vdirsyncer/config` | Key Vault + mounted config |
| Agent SAS | `AVAILCAL_AGENT_SAS_URL` env on the device | per-device, rotated quarterly |

Map every one of them to a label in `sources.toml`. See
[docs/RUNBOOK.md](RUNBOOK.md) for loading secrets into Key Vault.
