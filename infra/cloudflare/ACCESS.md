# SSO on the private calendar — Cloudflare Access scoped to `/calendar*`

The private calendar view (`https://availcal.<your-domain>/calendar`) can be put
behind **Cloudflare Access (Zero Trust)** so you log in with SSO (Google,
GitHub, one-time email code, …) instead of relying only on the URL token.

**Why this is the right fit here**

- **No Worker refactor.** Access is an *edge* policy that sits in front of the
  Worker. Requests to `/calendar*` are challenged before they ever reach your
  code. The token-based machine endpoints — `/availability.ics?token=`,
  `/raw/*.ics`, `PUT /raw/*.json`, `POST /run` — are **untouched**.
- **Right tool for each caller.** SSO is for *you* in a browser; a calendar app
  subscribing to a feed can't do SSO. So: **Access for the human page, token for
  the machine feeds.**
- Scope it to the path `/calendar*` (and optionally `/busy.json`, the data the
  page fetches) so nothing else is affected.

> The page still passes `?token=` to load `/busy.json`, so it keeps working with
> or without Access. Adding Access simply adds an SSO gate in front. If you later
> want to drop the token from the URL entirely, gate `/busy.json` with Access too
> (below) and have the Worker accept a verified Access JWT — tracked as a future
> enhancement; not required for SSO to work.

## Option A — Dashboard (5 minutes)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `availcal.<your-domain>`  **Path:** `calendar`
   (this scopes the app to `/calendar*`). Add a second application for path
   `busy.json` if you want the data gated too.
3. **Session duration:** e.g. 24h.
4. **Add a policy:** Action **Allow**, rule **Emails** → `you@example.com`
   (or **Emails ending in** `@your-domain`).
5. Pick an identity provider under **Settings → Authentication** (Google,
   GitHub, or the built-in **One-time PIN** email — no IdP setup needed).
6. Save. Visiting `/calendar` now shows the Access login first.

## Option B — Terraform (`access.tf`)

```hcl
terraform {
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4" }
  }
}

variable "cloudflare_account_id" { type = string }
variable "calendar_hostname"     { type = string } # e.g. availcal.mendelg.tech
variable "allowed_emails"        { type = list(string) }

# The Access application, scoped to the /calendar path only.
resource "cloudflare_access_application" "calendar" {
  account_id                = var.cloudflare_account_id
  name                      = "AvailCal private calendar"
  domain                    = "${var.calendar_hostname}/calendar"
  type                      = "self_hosted"
  session_duration          = "24h"
  app_launcher_visible      = false
  auto_redirect_to_identity = true
}

# Allow only the listed people.
resource "cloudflare_access_policy" "calendar_allow" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_access_application.calendar.id
  name           = "Owner only"
  precedence     = 1
  decision       = "allow"

  include {
    email = var.allowed_emails
  }
}

# Optional: gate the data the page fetches, so the token can eventually be dropped.
resource "cloudflare_access_application" "busy_json" {
  account_id           = var.cloudflare_account_id
  name                 = "AvailCal busy.json"
  domain               = "${var.calendar_hostname}/busy.json"
  type                 = "self_hosted"
  session_duration     = "24h"
  app_launcher_visible = false
}

resource "cloudflare_access_policy" "busy_json_allow" {
  account_id     = var.cloudflare_account_id
  application_id = cloudflare_access_application.busy_json.id
  name           = "Owner only"
  precedence     = 1
  decision       = "allow"
  include { email = var.allowed_emails }
}
```

```bash
terraform apply \
  -var cloudflare_account_id=<account_id> \
  -var calendar_hostname=availcal.mendelg.tech \
  -var 'allowed_emails=["mendelgrabski@gmail.com"]'
```

## What stays the same

- The Worker code is unchanged; **no other endpoint is affected.**
- Keep using the URL token for `/availability.ics` (your calendar app) — Access
  is not involved there.
- Rotate the feed token on the usual cadence — see
  [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md).
