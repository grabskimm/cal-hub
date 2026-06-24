# AvailCal macOS agent — Troubleshooting

Field guide to the failures seen setting up the EventKit agent
(`export_calendar.py` + `com.availcal.export.plist` + `install.sh`). Most of
them are **environment** problems — wrong Python, stale file, or macOS
permissions — not bugs in the script.

Assumes the install dir is `~/availcal` and the agent runs from its venv at
`~/availcal/venv/bin/python`. Substitute your path if different, but use the
**same** one everywhere.

> **Golden rules**
> 1. Always run the agent with `~/availcal/venv/bin/python` — never a bare `python3`.
> 2. **Never use `sudo`.** LaunchAgents and calendar (TCC) permissions are
>    per-user; `sudo` sends the job and the grant to the wrong user and breaks both.
> 3. The job runs as *you*, in your GUI login session (`gui/$(id -u)`).

---

## Quick diagnosis

```bash
# Which file/interpreter is real, and is the job healthy?
grep -n "from datetime" ~/availcal/export_calendar.py        # expect: datetime, timezone (NOT UTC)
~/availcal/venv/bin/python -c "import EventKit; print('EventKit OK')"
plutil -p ~/Library/LaunchAgents/com.availcal.export.plist | grep -A6 ProgramArguments
launchctl print gui/$(id -u)/com.availcal.export | grep -i state
cat ~/availcal/export.err.log
```

---

## 1. `cannot import name UTC from datetime` (Python 3.9)

A **stale copy** of `export_calendar.py` is running. The current script imports
`datetime, timezone` and never uses `UTC` (a 3.11+ symbol), so this error can
only come from an old file.

```bash
# find the stale file(s):
grep -rl "from datetime import UTC" ~ /usr/local /opt 2>/dev/null
# overwrite the install copy with the current one:
cp /path/to/cal-centrel/agents/macos/export_calendar.py ~/availcal/
# clear stale bytecode:
rm -rf ~/availcal/__pycache__
# make sure launchd isn't pointed at a different/old path:
plutil -p ~/Library/LaunchAgents/com.availcal.export.plist | grep -A6 ProgramArguments
```

Verify: `grep -n "from datetime" ~/availcal/export_calendar.py` →
`from datetime import datetime, timezone`.

---

## 2. `EventKit/PyObjC not available`

PyObjC isn't importable by the interpreter that ran. Install it into the **venv**
and test with that exact python:

```bash
~/availcal/venv/bin/python -m pip install pyobjc-framework-EventKit
~/availcal/venv/bin/python -c "import EventKit; print('OK')"
```

If launchd still reports it, the plist points at a non-venv python — re-run
`install.sh` (no sudo) so it rewrites the interpreter path to the venv.

**Root cause is almost always the wrong interpreter.** The pip install, the dry
run, and the plist's `ProgramArguments[0]` must all be the **same**
`~/availcal/venv/bin/python`. Mixing system / Homebrew / pyenv / venv pythons is
the usual culprit. Rebuild the venv from scratch if unsure:

```bash
cd ~/availcal && rm -rf venv __pycache__
/usr/bin/python3 -m venv ./venv
./venv/bin/python -m pip install --upgrade pip pyobjc-framework-EventKit
./venv/bin/python -c "import EventKit; print('OK')"
```

---

## 3. `full calendar access NOT granted` — but the dry run works fine

The **single most common** issue. The dry run passing proves the script and
interpreter are correct; the **launchd** run is what's failing.

**Why:** macOS attributes a calendar grant to the **responsible process**. A dry
run from Terminal grants *Terminal*, so the manual run works. The scheduled job
isn't run by Terminal, so it needs its **own** grant. That's why the installer
builds **`AvailCal.app`** — the launchd job runs the app's launcher, so the
prompt and grant are attributed to **"AvailCal"** (not Terminal, not Python).

**Fix** — trigger a run in your GUI session and approve the prompt it raises:

```bash
launchctl kickstart -k gui/$(id -u)/com.availcal.export
```

Click **Allow → Full Access** on the **"AvailCal" would like to access your
Calendar** prompt. If **no prompt** appears, clear stale state and retry:

```bash
tccutil reset Calendar          # NO sudo
launchctl kickstart -k gui/$(id -u)/com.availcal.export
```

Then confirm in **System Settings → Privacy & Security → Calendars** that
**AvailCal** is listed and set to **Full Access** (not "Add Only").

Notes:
- The plist ships with `ProcessType Standard` so this first-run prompt isn't
  suppressed/deprioritized.
- **Full Disk Access does *not* help** — EventKit is gated by the separate
  *Calendars* permission class, not FDA.

### A bare interpreter never appears in Privacy → Calendars

This is *why* the app exists. A plain `python3` launched by launchd has no app
bundle and no usage-description string, so macOS won't present the calendar
prompt for it and never lists it — the job stays silently denied. `AvailCal.app`
(a signed bundle whose `Info.plist` carries `NSCalendarsFullAccessUsageDescription`)
gives the job a real, stable identity macOS can prompt for and remember.

If **"AvailCal" is missing** from the Calendars pane after a kickstart, rebuild
and re-sign the bundle, then retry:

```bash
cd ~/availcal
AVAILCAL_AGENT_SAS_URL="…/raw/<Label>.json" AVAILCAL_AGENT_TOKEN="…" ./install.sh ~/availcal
tccutil reset Calendar
launchctl kickstart -k gui/$(id -u)/com.availcal.export
```

To see what macOS decides in real time, stream the TCC log while you kickstart:
```bash
log stream --predicate 'subsystem == "com.apple.TCC" AND category == "access"' --info
```
The lines name the requesting/responsible process — you want to see
`com.availcal.export` / `AvailCal`. If you instead see the request auto-denied
with no prompt, confirm the app is signed (`codesign -dv ~/availcal/AvailCal.app`)
and that `cc`/`codesign` were available at install time.

---

## 4. `Load failed: 5: Input/output error` / empty logs (the `sudo` trap)

Caused by running launchctl or `install.sh` under **`sudo`**. That loads the job
into the wrong domain (root/system instead of your GUI session), grants any
calendar approval to **root**, and can leave **root-owned files** in `~/availcal`
that your user-session job can't write — hence the empty logs.

**Recover — every command as your normal user, no sudo:**

```bash
# 1. tear down every copy of the job, both domains
launchctl bootout gui/$(id -u)/com.availcal.export 2>/dev/null
launchctl unload ~/Library/LaunchAgents/com.availcal.export.plist 2>/dev/null
sudo launchctl bootout system/com.availcal.export 2>/dev/null   # ONLY to undo a prior sudo load

# 2. reclaim anything sudo took ownership of
ls -le ~/Library/LaunchAgents/com.availcal.export.plist ~/availcal
sudo chown -R "$(id -u):$(id -g)" ~/availcal ~/Library/LaunchAgents/com.availcal.export.plist

# 3. clear the polluted TCC state (root got the grant, not you)
tccutil reset Calendar          # NO sudo

# 4. sanity-check the plist
plutil -lint ~/Library/LaunchAgents/com.availcal.export.plist   # -> ... OK

# 5. load into YOUR session and run it
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.availcal.export.plist
launchctl kickstart -k gui/$(id -u)/com.availcal.export
# approve the Calendar prompt (Full Access)

# 6. verify
launchctl print gui/$(id -u)/com.availcal.export | grep -i state
cat ~/availcal/export.err.log
```

If `install.sh` was originally run under sudo, the venv is likely root-owned and
broken — after step 2's `chown`, rebuild it by re-running the installer **without
sudo**:

```bash
cd ~/availcal
AVAILCAL_AGENT_SAS_URL="…/raw/<Label>.json" AVAILCAL_AGENT_TOKEN="…" ./install.sh ~/availcal
```

Other causes of `Load failed: 5` (rare): the job is already bootstrapped (do the
`bootout` in step 1 first), or the plist is malformed (`plutil -lint` catches it).

---

## 5. `0 busy events in the next 90 days`

Either you genuinely have nothing in the window, or the calendars aren't
mapped/visible. List the titles EventKit actually sees and confirm they're
enabled in Calendar.app:

```bash
~/availcal/venv/bin/python - <<'PY'
from EventKit import EKEventStore, EKEntityTypeEvent
s = EKEventStore.alloc().init()
for c in s.calendarsForEntityType_(EKEntityTypeEvent):
    print(repr(str(c.title())))
PY
```

Copy each title verbatim into the `[device]` section of `sources.toml`. Widen
the window with `--horizon-days N` if needed (default 90).

---

## 6. Uploads return `401` or `403`

The status code tells you **which** layer rejected the upload:

**`401 unauthorized`** — the **Worker** rejected the Bearer token.
`AVAILCAL_AGENT_TOKEN` is missing or wrong. **launchd does not inherit your shell
env**, so the token must be baked into the plist — re-run `install.sh` (no sudo)
with the correct `AVAILCAL_AGENT_SAS_URL` and `AVAILCAL_AGENT_TOKEN`.

**`403 Forbidden` with NO Worker logs AND NO Access logs** — the block is at
Cloudflare's edge **before** both layers, so neither logs it. Two distinct causes:

- **Bot Fight Mode / Bot Management** (most common): Cloudflare fingerprints the
  HTTP/TLS client and blocks Python's stdlib `urllib` as "automated" — even
  though `curl` with the *same* token/URL returns 201, and changing the
  User-Agent does nothing (the block is on the connection fingerprint, not the
  UA). **The agent already mitigates this by sending the upload via `curl`**
  (which Cloudflare allows) instead of urllib. If you still see it, exempt the
  path: a WAF custom rule that **Skips** Super Bot Fight Mode / managed rules for
  `http.request.uri.path starts_with "/raw/"` (the Worker still enforces the
  token), or turn Bot Fight Mode off for that hostname.
- **Cloudflare Access** (only if Access actually fronts the host): Access SSO,
  which a machine can't complete. Confirm by testing whether a bearer-token-only
  `curl` succeeds — if it 201s, Access is **not** gating `/raw/` and you don't
  need a service token. If it 403s, add a **service token**:

1. Cloudflare **Zero Trust → Access → Service Auth → Service Tokens** → create
   one; copy the Client ID + Client Secret.
2. On the Access application covering `availcal.<domain>` (at least `/raw/*`),
   add a **Service Auth** policy including that token. (Or a **Bypass** policy on
   `/raw/*` — the Worker still enforces `AGENT_TOKEN` on PUT — but that also
   un-gates `GET /raw/*`.)
3. Re-run `install.sh` (no sudo) with both halves exported so they're baked into
   the plist:
   ```bash
   export AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID="…"
   export AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET="…"
   AVAILCAL_AGENT_SAS_URL="…/raw/<Label>.json" AVAILCAL_AGENT_TOKEN="…" ./install.sh ~/availcal
   ```

Confirm which layer you're hitting with a direct request (shows the response
headers/body — Access serves an HTML challenge, the Worker a short text body):
```bash
curl -i -X PUT "https://availcal.<domain>/raw/<Label>.json" \
  -H "Authorization: Bearer $AVAILCAL_AGENT_TOKEN" \
  -H "CF-Access-Client-Id: $AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID" \
  -H "CF-Access-Client-Secret: $AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET" \
  --data '[]'
```

---

## 7. Nothing runs on schedule

```bash
launchctl list | grep com.availcal.export                  # is it loaded?
launchctl print gui/$(id -u)/com.availcal.export | grep -i state
cat ~/availcal/export.err.log                              # last fail-loud error
launchctl kickstart -k gui/$(id -u)/com.availcal.export    # force a run now
```

A LaunchAgent only runs while you're logged in. The job runs hourly
(`StartInterval 3600`) and once at load (`RunAtLoad`).

---

## Reset / start clean

```bash
# remove the job and everything it installed
launchctl bootout gui/$(id -u)/com.availcal.export 2>/dev/null
rm ~/Library/LaunchAgents/com.availcal.export.plist
rm -rf ~/availcal           # script, venv, logs, sources.toml

# wipe calendar permission (re-approve on next run)
tccutil reset Calendar
```

Then redo setup from the [README](./README.md) — as your normal user, no sudo.
