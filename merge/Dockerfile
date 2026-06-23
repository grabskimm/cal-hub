# AvailCal merge job — runs as a scheduled Azure Container Apps Job (scale-to-zero).
# Slim Python 3.12 with the vdirsyncer CLI baked in for the CalDAV channel.
#
# BASE_IMAGE is overridable only to swap in a mirror when Docker Hub is
# unreachable (e.g. a restricted build network). Production/CI use the default.
ARG BASE_IMAGE=python:3.12-slim
FROM ${BASE_IMAGE} AS base

# vdirsyncer needs nothing beyond Python; keep the image minimal. CA certs are
# already present in the slim image for httpx TLS to the secret ICS feeds.
# PIP_CERT points pip at the system trust store so an optional extra CA (below)
# is honoured; in production this is just the stock real-CA bundle.
ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_CERT=/etc/ssl/certs/ca-certificates.crt

WORKDIR /app

# Optional: trust an extra CA on restricted build networks that re-terminate TLS
# (corporate / sandbox egress proxies). No-op in normal CI — the secret is
# `required=false`, so `docker build` works with or without it. Pass it with:
#   docker build --secret id=extra_ca,src=/path/to/ca-bundle.crt ...
RUN --mount=type=secret,id=extra_ca,required=false \
    sh -c 'if [ -s /run/secrets/extra_ca ]; then \
              cat /run/secrets/extra_ca >> /etc/ssl/certs/ca-certificates.crt; \
            fi'

# Install the vdirsyncer CLI (pinned) into the image.
RUN pip install --no-cache-dir "vdirsyncer==0.19.3"

# Install the package. Copy metadata first for layer caching, then sources.
COPY pyproject.toml ./
COPY src ./src
RUN pip install --no-cache-dir .

# A default source registry ships in the image; override AVAILCAL_SOURCES_TOML
# (e.g. with a config/Key Vault-mounted file) in production.
COPY sources.default.toml /app/sources.toml
ENV AVAILCAL_SOURCES_TOML=/app/sources.toml

# Non-root for least privilege; in cloud the job authenticates via Managed
# Identity (Azure) or an R2 token (Cloudflare).
RUN useradd --create-home --uid 10001 availcal
USER availcal

EXPOSE 8080

# Default command runs the HTTP server, which is how Cloudflare Containers drive
# the job (Worker cron -> POST /run). Override the command to `availcal` for a
# one-shot batch run (e.g. Azure Container Apps Job, or local `docker run … availcal`).
CMD ["availcal-server"]
