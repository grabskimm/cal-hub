# Runbook

Operational guide for AvailCal: secrets, the manual live-validation checklist,
rotation, and troubleshooting — especially the silent-failure modes.

## Assumptions baked into the build

These are the working defaults chosen during the build (override via env/params):

- **Default timezone** for all-day/floating events without a TZID:
  `America/New_York` (`AVAILCAL_DEFAULT_TZ`). Set this to your home zone.
- **Horizon**: 90 days (`AVAILCAL_HORIZON_DAYS`).
- **Tentative counts as busy** (`AVAILCAL_INCLUDE_TENTATIVE=true`).
- **Per-source overlays emitted** (`AVAILCAL_EMIT_PER_SOURCE=true`).
- **Schedule**: hourly (`cronExpression: "0 * * * *"`, UTC).
- The job authenticates to Storage/Key Vault via its **system-assigned managed
  identity**; agents prefer **Arc MI**, falling back to a **write-scoped SAS**.

## One-time setup — Cloudflare (primary)

Runs the merge Container on an hourly Worker cron, stores in R2, serves the feed.
Requires a plan with **Containers** (Enterprise).

```bash
# 1. Create the R2 bucket and an Object Read&Write API token (dashboard or CLI)
wrangler r2 bucket create availcal

# 2. Worker deps + config validation
cd worker
npm ci
npm run typecheck            # tsc --noEmit
npx wrangler types           # validates wrangler.jsonc + bindings

# 3. Secrets (run once each; strong random tokens, e.g. `openssl rand -hex 32`)
wrangler secret put FEED_TOKEN                 # clients append ?token=<this>
wrangler secret put AGENT_TOKEN                # device agents Bearer-auth
wrangler secret put RUN_TOKEN                  # Worker<->Container + manual /run
wrangler secret put AVAILCAL_R2_ACCOUNT_ID
wrangler secret put AVAILCAL_R2_ACCESS_KEY_ID
wrangler secret put AVAILCAL_R2_SECRET_ACCESS_KEY
wrangler secret put AVAILCAL_ICS_FEEDS         # rawname=url,rawname=url

# 4. (Optional) custom domain: uncomment the `routes` line in wrangler.jsonc
#    (set availcal.example.com to a zone in this account) before deploying.

# 5. Deploy (builds+pushes the Container, binds R2, registers the hourly cron,
#    and provisions the custom domain DNS+TLS if a route is set)
npx wrangler deploy

# 6. Trigger a one-off run and tail logs
curl -X POST https://availcal.example.com/run -H "Authorization: Bearer <RUN_TOKEN>"
npx wrangler tail
```

Agents point at the Worker upload endpoint:
`AVAILCAL_AGENT_SAS_URL=https://availcal.example.com/raw/<Label>.json` and
`AVAILCAL_AGENT_TOKEN=<AGENT_TOKEN>`. Clients subscribe to
`https://availcal.example.com/availability.ics?token=<FEED_TOKEN>`. (Substitute
your `*.workers.dev` host if you skip the custom domain.)

Local dev: `cp worker/.dev.vars.example worker/.dev.vars` (fill in), then
`npx wrangler dev`.

## One-time setup — Azure (alternative)

### 1. Deploy infrastructure
```bash
az acr login --name <ACR_NAME>
docker build -t <ACR_LOGIN_SERVER>/availcal:v1 ./merge
docker push <ACR_LOGIN_SERVER>/availcal:v1
./infra/deploy.sh availcal-rg eastus containerImage=<ACR_LOGIN_SERVER>/availcal:v1
```
Outputs include the storage account, Key Vault name/URI, and job name.

### 2. Load feed secrets into Key Vault
The job reads each secret-ICS URL from a Key Vault secret named `ics-<rawname>`,
where `<rawname>` matches a key in the `[ics]` section of `sources.toml`:
```bash
az keyvault secret set --vault-name <KV_NAME> \
  --name ics-GoogPersonal --value 'https://calendar.google.com/.../basic.ics'
az keyvault secret set --vault-name <KV_NAME> \
  --name ics-OutlookPub  --value 'https://outlook.office365.com/.../calendar.ics'
```
(The job's managed identity already has **Key Vault Secrets User** via Bicep.)

### 3. Provision agent credentials (device-bound accounts)
Prefer an **Arc Managed Identity** with **Storage Blob Data Contributor** on
*only* the AvailCal container. Otherwise mint a **write-scoped SAS** for each
device, limited to its single blob path:
```bash
# Example: write-only SAS for the Windows agent's blob, ~100 days
az storage blob generate-sas --account-name <ACCT> \
  --container-name availcal --name raw/WorkX.json \
  --permissions cw --expiry 2026-09-30T00:00:00Z --https-only --full-uri
```
Put the resulting URL in `AVAILCAL_AGENT_SAS_URL` on that device.

### 4. Trigger the first run
```bash
az containerapp job start --resource-group availcal-rg --name availcal-merge
# Inspect:
az containerapp job execution list --resource-group availcal-rg --name availcal-merge -o table
```

### 5. Generate a read-only SAS for clients and subscribe
Create a read-only SAS for `merged/availability.ics` and follow
[SUBSCRIBE.md](SUBSCRIBE.md).

## Manual live-validation checklist (post-handoff)

The build was verified entirely against synthetic fixtures. Validate against
real accounts/devices once, in order:

- [ ] **Cloud feeds**: for each `ics-<rawname>` secret, confirm the job log shows
      `feed <rawname>` fetched (no error). Temporarily break one URL and confirm
      the run **continues** and only that feed is skipped.
- [ ] **CalDAV**: with `AVAILCAL_ENABLE_CALDAV=1` and `vdirsyncer/config` filled,
      confirm `vdirsyncer discover && sync` succeeds and `.ics` files appear in
      the vdir; confirm those events show up tagged with the `[caldav]` label.
- [ ] **Windows agent**: run `.\Export-Calendar.ps1 -DryRun` on a machine with
      Outlook. Confirm recurring meetings appear (the `Sort → IncludeRecurrences`
      ordering is working) and that **free** time is absent. Then run without
      `-DryRun` and confirm `/raw/<Label>.json` updates in blob.
- [ ] **macOS agent**: run `python3 export_calendar.py --dry-run`. Approve the
      Calendar (TCC) prompt. Confirm non-zero events and correct labels, then
      schedule via `install.sh`.
- [ ] **Merge correctness**: pick a time when two *different* sources are busy and
      confirm the merged feed shows **two** separately-tagged blocks (not one).
      Pick two overlapping blocks in the *same* source and confirm they collapse
      to one.
- [ ] **Time correctness**: spot-check a meeting across a DST boundary and an
      all-day event; confirm UTC times in the ICS are correct for your zone.
- [ ] **Client**: subscribe Apple Calendar/Thunderbird/Fantastical and confirm
      hourly refresh and per-source colors via `CATEGORIES`.

## Secret rotation

- **Agent SAS: rotate quarterly.** Mint a new write-scoped SAS (step 3), update
  `AVAILCAL_AGENT_SAS_URL` on the device, confirm an upload, then let the old SAS
  expire. Prefer migrating Arc-enrolled devices to Managed Identity to eliminate
  SAS entirely.
- **Feed URLs / CalDAV app passwords**: if a secret leaks, **regenerate at the
  provider** (Google: reset the secret iCal address; iCloud/Fastmail: revoke the
  app-specific password) and update the Key Vault secret. Key Vault soft-delete
  retains old versions for 7 days.
- **Client read SAS**: rotate if the merged-feed URL is ever exposed; use a
  stored access policy so you can revoke without re-issuing the account key.

## Gotchas (encoded as requirements, surfaced here for operators)

- **Google secret-iCal is cache-stale by hours.** Expected, not a bug. Use
  CalDAV/device for anything you need fresh. Don't "fix" it.
- **OAuth refresh-token 7-day expiry**: only relevant if you add personal-Gmail
  OAuth (the default design avoids OAuth). If you do, **publish the consent app
  to Production** or tokens die after 7 days.
- **TZ + all-day + floating** is the silent-corruption zone — handled by
  `timeutil` and tests; if you add a source, keep everything flowing through
  `to_utc()`/`ensure_aware()`.
- **macOS EventKit & Windows COM fail *silently*** on permission/profile issues
  (zero events, no error). Both agents detect this and **exit non-zero** rather
  than publishing a false "totally free" feed. Treat a non-zero agent exit as a
  real alert.

## Troubleshooting

### The merged feed is empty or missing sources
1. Check the job execution log:
   ```bash
   az containerapp job execution list -g availcal-rg --name availcal-merge -o table
   ```
   Look for `gathered N raw intervals` and `merged into M source-tagged blocks`.
2. `unmapped source (add to sources.toml)` warnings mean a raw input had no
   registry entry and was slugified — add it to `sources.toml`.
3. A feed showing `failed after N attempts` is down/stale — the run continues
   without it by design.

### A device agent uploaded nothing / a calendar looks empty
- This is the **silent-empty** failure mode. Re-run the agent's dry-run:
  - Windows: `\.Export-Calendar.ps1 -DryRun` — a non-zero exit or
    `no calendar folders found` means a profile/permission problem.
  - macOS: `python3 export_calendar.py --dry-run` — `full calendar access NOT
    granted` means re-grant in **System Settings → Privacy & Security →
    Calendars**.
- A genuine zero-event window logs a warning but is allowed; verify it's real.

### Recurring meetings are missing (Windows)
Almost always the COM ordering: `Items.Sort("[Start]")` **must** precede
`Items.IncludeRecurrences = $true`. The script does this correctly — don't
reorder it.

### Times are off by an hour / a day
- Check `AVAILCAL_DEFAULT_TZ` matches your home zone (affects all-day and
  floating-time events only).
- All times in the ICS are **UTC** (`…Z`); your client localizes them. Compare in
  UTC before assuming a bug.

### CI is red
- `ruff check` failures include the **DTZ** (naive-datetime) gate — fix the
  flagged comparison rather than suppressing it.
- `pytest` fixtures pin the six required cases (DST, all-day, floating, weekly
  RRULE+EXDATE, cross-source non-collapse, same-source collapse, dup-UID). A
  failure there means a regression in time or merge logic.
