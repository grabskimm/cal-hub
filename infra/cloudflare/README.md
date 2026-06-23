# Running AvailCal on Cloudflare R2

AvailCal's storage layer is backend-agnostic. To use **Cloudflare R2** (instead
of Azure Blob) you only configure R2 env vars — the same `merge/` image runs
unchanged. R2 is S3-compatible and has **no egress fees**, which is ideal for a
feed polled hourly by several clients.

This directory documents the R2 setup. (The merge job itself can run anywhere
that can run the container on a schedule — an Azure Container Apps Job as in
`infra/main.bicep`, a cron box, or — natively — a Cloudflare Worker Cron Trigger
that boots a Cloudflare Container. Only storage is R2-specific here.)

## 1. Create the bucket

```bash
# Dashboard: R2 > Create bucket > "availcal"  (keep it PRIVATE)
# or with wrangler:
wrangler r2 bucket create availcal
```

## 2. Create a scoped API token (least privilege)

Cloudflare dashboard → **R2 → Manage R2 API Tokens → Create API token**:

- Permissions: **Object Read & Write**
- Scope: **only the `availcal` bucket**

You receive an **Access Key ID**, a **Secret Access Key**, and your
**Account ID**. The S3 endpoint is `https://<ACCOUNT_ID>.r2.cloudflarestorage.com`.

## 3. Point the job at R2

Set these on the merge job (env / container secrets):

```bash
AVAILCAL_R2_BUCKET=availcal
AVAILCAL_R2_ACCOUNT_ID=<account_id>
AVAILCAL_R2_ACCESS_KEY_ID=<access_key_id>
AVAILCAL_R2_SECRET_ACCESS_KEY=<secret_access_key>
# AVAILCAL_R2_ENDPOINT=  # optional override; derived from account id otherwise
```

Run a cycle (e.g. locally against the image):

```bash
docker run --rm \
  -e AVAILCAL_R2_BUCKET -e AVAILCAL_R2_ACCOUNT_ID \
  -e AVAILCAL_R2_ACCESS_KEY_ID -e AVAILCAL_R2_SECRET_ACCESS_KEY \
  -e AVAILCAL_ICS_FEEDS='GoogPersonal=https://…/basic.ics' \
  -v "$PWD/sources.toml:/app/sources.toml:ro" \
  <your-registry>/availcal:latest
```

It writes `merged/availability.ics` and `raw/<Label>.ics` to the bucket, and
reads device uploads from `raw/*.json`.

## 4. Device agents → R2

Give each device a **presigned PUT URL** for its own object only, e.g.:

```bash
aws s3 presign s3://availcal/raw/WorkX.json \
  --endpoint-url https://<account_id>.r2.cloudflarestorage.com \
  --expires-in 7776000        # ~90 days
```

Set it as `AVAILCAL_AGENT_SAS_URL` on the device. The agents auto-detect R2 vs
Azure by URL host and send the right headers. (A small authenticated Worker
upload endpoint is a nicer long-term alternative to presigned URLs — see below.)

## 5. Serving the feed to calendar clients

Subscribe clients to a **non-public** URL of `merged/availability.ics`. Two
common options:

- **Presigned GET URL** (simple): generate a long-lived read-only presigned URL
  and give it to your clients.
- **Worker route** (recommended): a tiny Worker that checks a secret token and
  streams the object from R2 with `Content-Type: text/calendar`. This also gives
  you the authenticated `/raw/<src>.json` PUT endpoint for the device agents, so
  you can drop presigned URLs entirely. (Worker scaffold is out of scope here;
  the storage layer is the R2-specific part.)

## Rotation

R2 API tokens and presigned URLs rotate on the same quarterly cadence as the
Azure SAS — see [`docs/RUNBOOK.md`](../../docs/RUNBOOK.md).
