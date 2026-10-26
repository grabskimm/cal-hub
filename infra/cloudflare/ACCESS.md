# SSO on the private calendar — Cloudflare Access scoped to `/calendar*`

The private calendar view (`https://availcal.<your-domain>/calendar`) can be put
behind **Cloudflare Access (Zero Trust)** so you log in with SSO (Google,
GitHub, one-time email code, …) instead of relying only on the URL token.

**Why this is the right fit here**

- **Minimal Worker change.** Access is an *edge* policy that sits in front of the
  Worker. Requests to `/calendar*` are challenged before they ever reach your
  code. The token-based machine endpoints — `/availability.ics?token=`,
  `/raw/*.ics`, `PUT /raw/*.json` — are **untouched**. `POST /run` is the one
  exception: it still takes `RUN_TOKEN`, and *additionally* accepts an Access
  identity so the button below can work. Read the next section before you
  write the policy.
- **Right tool for each caller.** SSO is for *you* in a browser; a calendar app
  subscribing to a feed can't do SSO. So: **Access for the human page, token for
  the machine feeds.**
- Scope it to the path `/calendar*` (and optionally `/busy.json`, the data the
  page fetches) so nothing else is affected.

### Drop the URL token — SSO only (implemented)

Access also unlocks the **⟳ Refresh now** button on `/calendar`, which forces a
merge (`POST /run`) without `RUN_TOKEN` — it rides the same `CF_Authorization`
cookie. Anyone your Access policy admits can press it, so scope the policy to
the people you'd hand the token to. The POST additionally requires a custom
header and a same-origin `Origin`, which is what stops another site forging it
with your cookie; it is rate-limited per IP (`RUN_RATE_LIMIT`), and every run
logs the email that triggered it.

The Worker can authorize `/calendar` (and the `/busy.json` it fetches) from a
**verified Access identity** instead of the URL token. Set two non-secret vars
so the Worker knows which Access tokens to trust:

```bash
# wrangler.jsonc vars (or `wrangler secret put` if you prefer):
ACCESS_TEAM_DOMAIN = "https://<your-team>.cloudflareaccess.com"
ACCESS_AUD         = "<Application Audience (AUD) tag from the Access app>"
```

Find the **AUD tag** on the Access application's **Overview** page. With both
set, visiting `https://availcal.<domain>/calendar` after SSO works with **no
`?token=`** — the Worker validates the Access JWT (signature against your team's
keys, plus `aud`/`iss`/`exp`). The browser sends the `CF_Authorization` cookie on
the page's same-origin `/busy.json` fetch, so gating just `/calendar` is enough.
Leave the two vars empty to keep token-only auth (unchanged).

> The page still accepts `?token=` too, so both methods work side by side.

## Option A — Dashboard (5 minutes)

1. **Zero Trust → Access → Applications → Add an application → Self-hosted.**
2. **Application domain:** `availcal.<your-domain>`  **Path:** `calendar`
   (this scopes the app to `/calendar*`). Add a second application for path
   `busy.json` if you want the data gated too.
3. **Session duration:** e.g. 24h. Note this is also how long a *revoked*
   person keeps the merge trigger: removing them from the policy blocks
   `/calendar` at the edge immediately, but the `CF_Authorization` JWT they
   already hold stays cryptographically valid until it expires, and the Worker
   verifies that JWT itself. Shorten the session if that matters; `RUN_TOKEN`
   has no such lag, since rotating the secret is instant.
4. **Add a policy:** Action **Allow**, rule **Emails** → `you@example.com`.
   Prefer naming individuals over **Emails ending in** `@your-domain`: this
   policy now also decides who can force a merge.
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

- Every feed and upload endpoint keeps its token auth; the only endpoint Access
  newly reaches is `POST /run` (above).
- Keep using the URL token for `/availability.ics` (your calendar app) — Access
  is not involved there.
- Rotate the feed token on the usual cadence — see
  [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md).

## Identity providers

The built-in **One-time PIN** (email code) needs no IdP setup. To use SSO:

### Microsoft Entra ID (Azure AD)

If the Cloudflare test fails with **`AADSTS500113: No reply address is
registered for the application`**, the Entra app registration is missing the
redirect (reply) URL that Access calls back to:

1. Copy the callback URL from **Zero Trust → Settings → Authentication →** your
   Azure AD login method. It is
   `https://<your-team-name>.cloudflareaccess.com/cdn-cgi/access/callback`.
2. In the **Azure portal → Microsoft Entra ID → App registrations →** your app
   → **Authentication → Platform configurations → Add a platform → Web**, paste
   that URL under **Redirect URIs** and **Save**.
3. Make sure the app's **Supported account types** matches who signs in, and
   that the **Application (client) ID**, **client secret**, and **Directory
   (tenant) ID** in Cloudflare match the registration.
4. Re-run the test (propagates within ~a minute).

