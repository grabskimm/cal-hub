# AvailCal — macOS agent (EventKit)

Reads busy intervals from the **local** macOS calendar store via EventKit and
uploads privacy-safe busy JSON to the AvailCal **Cloudflare Worker** (or, for
legacy deployments, Azure Blob). Because it reads the on-device store, it covers
work accounts that sync to Calendar.app even when the server forbids published
ICS.

- **Script:** `export_calendar.py` (stdlib + PyObjC only).
- **App identity:** `AvailCal.app` — a tiny signed bundle (`app/launcher.c` +
  `app/Info.plist`) that gives the job a real macOS app identity so the Calendar
  prompt appears and the grant persists under "AvailCal".
- **Schedule:** `com.availcal.export.plist` loaded by **launchd** (hourly),
  pointed at the app's launcher.
- **Installer:** `install.sh` builds the venv, compiles + signs the app, renders
  the plist, loads the job.
- **Stuck?** See [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) — stale-file / wrong
  interpreter / TCC / `sudo` recovery.

---

## How it works (30-second version)

1. EventKit asks macOS for **full** calendar access (and fails loud if it isn't
   granted — see [TCC](#step-4--grant-calendar-access-tcc)).
2. It reads events in the next `--horizon-days` (default **90**) days from every
   calendar, drops anything marked **Free**, and keeps only
   `{source, start, end, status}` per busy block.
3. It `PUT`s that JSON to `/raw/<Label>.json` on your Worker (or an Azure SAS
   URL). Nothing else leaves the machine.

---

## What leaves the machine

Only `{source, start, end, status}` per busy block (single-word label + UTC
start/end + coarse status). **Free events are dropped at the source.** No event
titles, notes, attendees or locations are ever read.

---

## Prerequisites

- **macOS 14+** (Sonoma or newer — uses the
  `requestFullAccessToEventsWithCompletion:` API).
- **Python 3.9+.** The system `/usr/bin/python3` is fine; you do **not** need
  Homebrew. Check: `/usr/bin/python3 --version`.
- **Xcode Command Line Tools** (provides `cc` + `codesign`, used to build and
  sign `AvailCal.app`). You already have these if `/usr/bin/python3` exists;
  otherwise `xcode-select --install`.
- The calendars you want to publish are already syncing into **Calendar.app**
  (iCloud, Google, Exchange, etc.).
- Your AvailCal upload URL and (for the Cloudflare Worker) the `AGENT_TOKEN`.

> **Why a venv?** The agent runs inside a dedicated virtualenv
> (`<install-dir>/venv`) with PyObjC installed into it, and launchd is pointed
> at `<install-dir>/venv/bin/python`. This removes the single most common cause
> of setup failures — PyObjC installed under one `python3` while a *different*
> `python3` (or a stale copy of the script) actually runs, producing
> `cannot import name UTC from datetime` or `EventKit/PyObjC not available`.
> **Docker won't work**: a Linux container has no EventKit, no calendar store,
> and no macOS permission model.

---

## Step-by-step setup

All commands assume the install dir is `~/availcal`. Substitute your own path if
different — but use the **same** path everywhere.

### Step 1 — Put the agent files in place

```bash
mkdir -p ~/availcal
# from your clone of this repo:
cp agents/macos/export_calendar.py ~/availcal/
cp agents/macos/com.availcal.export.plist agents/macos/install.sh ~/availcal/   # optional, for convenience
cd ~/availcal
```

You should now have `~/availcal/export_calendar.py`. Confirm it's the current
version (no legacy `UTC` import):

```bash
grep -n "from datetime" ~/availcal/export_calendar.py
# expect:  from datetime import datetime, timezone     (NOT  import UTC)
```

### Step 2 — Create the venv and install PyObjC

If you'll use `install.sh` (Step 7), it does this for you and you can skip ahead
— **but** you still need the venv now to grant TCC in Step 4, so do it here:

```bash
cd ~/availcal
/usr/bin/python3 -m venv ./venv
./venv/bin/python -m pip install --upgrade pip
./venv/bin/python -m pip install pyobjc-framework-EventKit
# prove EventKit imports in THIS interpreter:
./venv/bin/python -c "import EventKit; print('EventKit OK')"
```

From here on, **always run the agent with `./venv/bin/python`** — never a bare
`python3`. That one rule prevents the wrong-interpreter errors.

### Step 3 — Configure `sources.toml`

Create `~/availcal/sources.toml` with a `[device]` section mapping each
**Calendar.app calendar name** to a short one-word **label**. The label becomes
the `source` field in the feed and the `/raw/<Label>.json` upload path.

```toml
# ~/availcal/sources.toml
[device]
# "Calendar name as shown in Calendar.app" = "OneWordLabel"
"Work"      = "Work"
"Personal"  = "Home"
"iCloud"    = "iCloud"
```

To list the exact calendar names macOS sees (so they match precisely), run:

```bash
./venv/bin/python - <<'PY'
from EventKit import EKEventStore, EKEntityTypeEvent
s = EKEventStore.alloc().init()
for c in s.calendarsForEntityType_(EKEntityTypeEvent):
    print(repr(str(c.title())))
PY
```

Any calendar **not** listed in `[device]` is still exported, but its label is
auto-slugified from the title and a warning is printed — so map the ones you
care about.

### Step 4 — Grant calendar access (TCC)

macOS gates calendar reads behind **TCC** (Transparency, Consent & Control). An
app without permission gets **zero events with no error** — exactly the silent
failure that would publish a false "I'm totally free" feed. The agent therefore
checks the authorization state and **exits non-zero** unless full access is
granted.

Trigger the prompt by running a dry run with the **venv** python (the same
interpreter launchd will use, so the grant attaches to the right binary):

```bash
cd ~/availcal
./venv/bin/python export_calendar.py --dry-run --sources-toml ./sources.toml
```

1. Click **Allow** / **OK** on the "… would like to access your Calendar" prompt.
2. Verify in **System Settings → Privacy & Security → Calendars** that
   **Python** (or your Terminal) is toggled **on**, with **Full Access** if
   offered.
3. If you see `full calendar access NOT granted (authorization status=…)`,
   re-toggle it there and re-run. The agent refuses to upload until access is
   real.

> **Important — the Terminal grant ≠ the scheduled-job grant.** macOS attributes
> a calendar grant to the **responsible process**. A dry run from Terminal grants
> *Terminal*, so the manual run works — but the scheduled job isn't run by
> Terminal, so it needs its **own** grant. That's exactly why the installer
> builds **AvailCal.app**: the launchd job runs the app's launcher, so the prompt
> appears as **"AvailCal"** and the grant persists under that name for every run.
>
> After installing (Step 7), trigger the first run in your GUI session and
> approve the **"AvailCal" would like to access your Calendar** prompt:
>
> ```bash
> launchctl kickstart -k gui/$(id -u)/com.availcal.export
> ```
>
> If no prompt appears, clear stale state and try once more:
> `tccutil reset Calendar && launchctl kickstart -k gui/$(id -u)/com.availcal.export`.
> The plist uses `ProcessType Standard` so the first-run prompt isn't suppressed.
> Note: **Full Disk Access does not help** — EventKit is gated by the separate
> *Calendars* permission class. (The `--dry-run` in Step 5 is still useful for
> checking the JSON, but it grants *Terminal*, not the scheduled job.)

### Step 5 — Dry run (verify the JSON, no upload)

```bash
./venv/bin/python export_calendar.py --dry-run --sources-toml ./sources.toml
```

Prints the exact JSON it would upload plus a summary, and exits 0. Confirm the
`source` labels and busy blocks look right before wiring up uploads.

### Step 6 — Choose your upload target

Pick the method matching your deployment and have the values ready for Step 7.

- **Cloudflare Worker (current):** URL `https://availcal.<domain>/raw/<Label>.json`
  + the Worker's `AGENT_TOKEN`.
- **Azure Blob (legacy):** a write-scoped **SAS URL**; no token.

See [Upload target details](#upload-target-details) below for the full
explanation of each.

### Step 7 — Install the hourly launchd job

From the directory containing `install.sh` (e.g. `~/availcal`):

```bash
cd ~/availcal
AVAILCAL_AGENT_SAS_URL="https://availcal.example.com/raw/Work.json" \
AVAILCAL_AGENT_TOKEN="…the Worker AGENT_TOKEN…" \
./install.sh ~/availcal
```

The installer will:

1. Build/refresh `~/availcal/venv` and install PyObjC into it.
2. **Abort** if EventKit can't import in the venv (so a broken interpreter fails
   now, not silently at 3am).
3. Compile + ad-hoc-sign **`~/availcal/AvailCal.app`** (the app identity that
   makes the Calendar prompt appear as "AvailCal"). Requires `cc` + `codesign`
   from the Command Line Tools.
4. Render `com.availcal.export.plist` pointed at the app launcher + the upload
   URL/token, writing it to `~/Library/LaunchAgents/com.availcal.export.plist`.
5. `launchctl bootstrap` it into your GUI session — hourly via `StartInterval`,
   plus once immediately (`RunAtLoad`).

Then **trigger the first run and approve the prompt** (Step 4):
```bash
launchctl kickstart -k gui/$(id -u)/com.availcal.export
```

> **launchd does not inherit your shell environment**, so the URL and token are
> baked into the plist's `EnvironmentVariables` at install time. Re-run
> `install.sh` whenever they change.

To build the venv from a non-default base interpreter, set
`AVAILCAL_BASE_PYTHON=/path/to/python3` before running `install.sh`.

> **Never run `install.sh` (or any of these commands) under `sudo`.** It sends
> the job and the calendar grant to root and breaks both. Everything runs as you.

### Step 8 — Verify it's running

```bash
# the job is loaded:
launchctl list | grep com.availcal.export

# logs (stdout + stderr); a fail-loud non-zero exit lands in the .err.log:
tail -f ~/availcal/export.log ~/availcal/export.err.log

# confirm what launchd actually runs (interpreter + script path):
plutil -p ~/Library/LaunchAgents/com.availcal.export.plist | grep -A6 ProgramArguments

# force a run now instead of waiting for the hour:
launchctl kickstart -k gui/$(id -u)/com.availcal.export
```

A healthy run uploads `/raw/<Label>.json` and exits 0. Confirm the feed appears
at your Worker URL.

---

## Reference: CLI flags

| Flag | Default | Purpose |
|------|---------|---------|
| `--dry-run` | off | Print the JSON and a summary; never upload. Exit 0. |
| `--sources-toml PATH` | `./sources.toml` | Path to the `[device]` label map. |
| `--horizon-days N` | `90` | How many days ahead to read. |
| `--sas-url URL` | `$AVAILCAL_AGENT_SAS_URL` | Upload target (Worker URL or Azure SAS). |
| `--token TOKEN` | `$AVAILCAL_AGENT_TOKEN` | Bearer token for the Worker (blank for Azure). |
| `--cf-access-client-id ID` | `$AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID` | Cloudflare Access service-token ID (only if the Worker host is behind Access). |
| `--cf-access-client-secret SECRET` | `$AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET` | Cloudflare Access service-token secret. |

## Reference: `sources.toml` format

```toml
[device]
"Exact Calendar.app name" = "Label"
```

- Keys are matched against the calendar **title** exactly; unmatched calendars
  are slugified with a warning.
- Labels should be a single word (they become the `source` field and the
  `/raw/<Label>.json` path).
- Parsed with `tomllib` on Python 3.11+, and a built-in minimal parser on 3.9/3.10.

---

## Upload target details

The agent `PUT`s the busy JSON to a single object path, `/raw/<Label>.json`,
where `<Label>` is this source's one-word label.

### Cloudflare Worker (current deployment)

The Worker accepts `PUT https://availcal.<domain>/raw/<Label>.json` with an
`Authorization: Bearer <AGENT_TOKEN>` header (the Worker's `AGENT_TOKEN` secret).
Uploads go to the **private** host (`availcal.<domain>`), never the public one.

- `--sas-url` / `AVAILCAL_AGENT_SAS_URL` → `https://availcal.<domain>/raw/<Label>.json`
- `--token` / `AVAILCAL_AGENT_TOKEN` → the Worker's `AGENT_TOKEN`

```bash
export AVAILCAL_AGENT_SAS_URL="https://availcal.example.com/raw/Work.json"
export AVAILCAL_AGENT_TOKEN="…the worker AGENT_TOKEN…"
./venv/bin/python export_calendar.py --sources-toml ./sources.toml
```

> **Note:** the upload is sent via the system **`curl`**, not Python's urllib.
> Cloudflare Bot Fight Mode / Bot Management fingerprints the HTTP/TLS client and
> blocks stdlib urllib with a **403 at the edge** (before Access or the Worker, so
> neither logs it), while curl is allowed. This is handled for you; you don't need
> to do anything. If a 403 persists, see TROUBLESHOOTING.md (exempt `/raw/` from
> Bot Fight Mode).

#### Only if the private host is *also* behind Cloudflare Access (Zero Trust)

Test first: if a **bearer-token-only `curl` PUT returns 201**, Access is **not**
gating `/raw/` and you can skip this section. If it returns **403** (and a
service-token curl returns 201), the host is fronted by **Cloudflare Access**,
which a machine can't SSO into. Give the agent a **service token**:

1. In **Cloudflare Zero Trust → Access → Service Auth → Service Tokens**, create a
   token. Copy the **Client ID** and **Client Secret**.
2. On the Access **application** that covers `availcal.<domain>` (at least the
   `/raw/*` path), add a policy: **Action = Service Auth**, include your service
   token. (Alternatively, add a **Bypass** policy scoped to `/raw/*` — the Worker
   already enforces `AGENT_TOKEN` on PUT — but that also un-gates `GET /raw/*`.)
3. Configure the agent with both halves:

```bash
export AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID="…service-token client id…"
export AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET="…service-token client secret…"
./venv/bin/python export_calendar.py --sources-toml ./sources.toml
```

The agent sends these as `CF-Access-Client-Id` / `CF-Access-Client-Secret`;
Access validates them and forwards the request to the Worker, which still checks
the Bearer `AGENT_TOKEN`. Pass them to `install.sh` the same way (export both
before running it) so they're baked into the launchd plist.

### Azure Blob (legacy)

- **Managed Identity (Arc-enrolled Mac):** grant the machine's MI **Storage Blob
  Data Contributor** on *only* the AvailCal container (no secret on the endpoint).
- **SAS fallback:** a write-only SAS scoped to this source's single blob path,
  exported as `AVAILCAL_AGENT_SAS_URL` (token left blank), rotated quarterly
  (see `docs/RUNBOOK.md`).

```bash
export AVAILCAL_AGENT_SAS_URL="https://acct.blob.core.windows.net/availcal/raw/Work.json?sv=...&sig=..."
./venv/bin/python export_calendar.py --sources-toml ./sources.toml
```

The agent auto-detects Azure (it adds the `x-ms-blob-type` header only for
`*.blob.core.windows.net` URLs) vs the Worker (Bearer token), so the same script
serves both.

---

## Troubleshooting

**`cannot import name UTC from datetime` (Python 3.9)**
A *stale* copy of `export_calendar.py` is running — the current file imports
`datetime, timezone`, never `UTC`. Find the offender and replace it:
```bash
grep -rl "from datetime import UTC" ~ /usr/local /opt 2>/dev/null   # the stale file(s)
cp agents/macos/export_calendar.py ~/availcal/                      # overwrite with current
rm -rf ~/availcal/__pycache__                                       # clear stale bytecode
```
Then check that **launchd** isn't pointed at the old path:
`plutil -p ~/Library/LaunchAgents/com.availcal.export.plist | grep -A6 ProgramArguments`.

**`EventKit/PyObjC not available`**
PyObjC isn't importable by the interpreter that ran. Install it into the venv
and test with that exact python:
```bash
~/availcal/venv/bin/python -m pip install pyobjc-framework-EventKit
~/availcal/venv/bin/python -c "import EventKit; print('OK')"
```
If launchd still reports it, the plist is pointing at a non-venv python — re-run
`install.sh` so it rewrites the interpreter path.

**Wrong-interpreter checklist.** The pip install, the dry-run, and the plist
must all use the **same** python — `~/availcal/venv/bin/python`. Mixing system,
Homebrew, and venv pythons is the usual culprit.

**`full calendar access NOT granted` — but the dry run works fine**
Classic Terminal-vs-launchd split: your Terminal dry run granted *Terminal*, so
it passes, but the **launchd** job runs python with no grant of its own and
fails. Give the launchd job its own grant by kicking it in your GUI session and
approving the prompt:
```bash
launchctl kickstart -k gui/$(id -u)/com.availcal.export
# no prompt? clear stale state and retry:
tccutil reset Calendar && launchctl kickstart -k gui/$(id -u)/com.availcal.export
```
Confirm under *Privacy & Security → Calendars* that access is **Full Access**
(not "Add Only"). Full Disk Access does **not** cover EventKit.

**`0 busy events in the next 90 days`**
Either you really have nothing, or the calendars aren't mapped/visible. List the
titles macOS sees (Step 3) and confirm they're enabled in Calendar.app.

**Uploads return 401**
For the Worker, `AVAILCAL_AGENT_TOKEN` is missing or wrong. Re-run `install.sh`
with the correct token (launchd doesn't see your shell env).

**Nothing runs on schedule**
```bash
launchctl list | grep com.availcal.export      # is it loaded?
cat ~/availcal/export.err.log                   # last fail-loud error
launchctl kickstart -k gui/$(id -u)/com.availcal.export   # force a run
```

---

## Uninstall

```bash
launchctl unload ~/Library/LaunchAgents/com.availcal.export.plist
rm ~/Library/LaunchAgents/com.availcal.export.plist
rm -rf ~/availcal          # removes the script, venv, logs, sources.toml
```
Optionally remove Python from *Privacy & Security → Calendars*.
