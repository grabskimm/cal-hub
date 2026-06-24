#!/usr/bin/env python3
"""AvailCal macOS agent: read the local calendar store via EventKit and emit
privacy-safe busy JSON, optionally uploading it to a write-scoped blob.

Only ``{source, start, end, status}`` leaves the machine. Free events are dropped
at the source; titles, notes, attendees and locations are never read.

FAIL-LOUD CONTRACT: an un-granted EventKit returns **zero events silently**,
which would publish a falsely-empty "totally free" feed. So we assert the
authorization state is full access and that calendars exist, and exit non-zero
otherwise. See agents/macos/README.md for the TCC grant step.

Requires macOS 14+ and PyObjC (``pip install pyobjc-framework-EventKit``).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path

try:
    import tomllib
except ModuleNotFoundError:  # pragma: no cover - py<3.11
    tomllib = None  # type: ignore

try:
    from EventKit import EKEntityTypeEvent, EKEventStore
    from Foundation import NSDate
except ImportError:  # pragma: no cover - non-mac / missing PyObjC
    EKEventStore = None  # type: ignore


# EKEventAvailability -> AvailCal status. Free is dropped at the source.
# EKEventAvailabilityNotSupported = -1, Busy = 0, Free = 1, Tentative = 2,
# Unavailable = 3.
_AVAILABILITY_TO_STATUS = {
    -1: "busy",   # NotSupported: calendar can't express availability -> assume busy
    0: "busy",    # Busy
    1: None,      # Free -> drop
    2: "tentative",
    3: "oof",     # Unavailable ~ out of office
}

# EKAuthorizationStatus.fullAccess (macOS 14+) == 3.
_AUTH_FULL_ACCESS = 3


def die(msg: str) -> None:
    print(f"AvailCal macOS agent FAILED: {msg}", file=sys.stderr)
    sys.exit(1)


def slugify(raw: str) -> str:
    s = re.sub(r"\W+", "_", raw.strip()).strip("_")
    return s or "Unknown"


def _parse_device_section(text: str) -> dict[str, str]:
    """Minimal [device] reader for Python < 3.11 (no tomllib): `"Title" = "Label"`."""
    out: dict[str, str] = {}
    section = ""
    for line in text.splitlines():
        t = line.strip()
        if not t or t.startswith("#"):
            continue
        m = re.match(r"^\[(.+)\]$", t)
        if m:
            section = m.group(1).strip()
            continue
        if section == "device":
            m = re.match(r'^"?([^"=]+?)"?\s*=\s*"([^"]+)"\s*$', t)
            if m:
                out[m.group(1).strip()] = m.group(2).strip()
    return out


def load_device_labels(path: str) -> dict[str, str]:
    """Read the [device] section of sources.toml: calendar title -> label.

    Uses tomllib when available (Python 3.11+), else a minimal built-in parser so
    older Python still picks up the labels.
    """
    p = Path(path)
    if not p.exists():
        print(f"warning: sources.toml not found ({path}); labels will be slugified.",
              file=sys.stderr)
        return {}
    text = p.read_text()
    if tomllib is not None:
        return dict(tomllib.loads(text).get("device", {}))
    return _parse_device_section(text)


def resolve_label(labels: dict[str, str], title: str) -> str:
    if title in labels:
        return labels[title]
    slug = slugify(title)
    print(f"warning: unmapped calendar {title!r} -> {slug!r}; add it to [device] "
          f"in sources.toml.", file=sys.stderr)
    return slug


def request_full_access(store) -> int:
    """Request full calendar access (macOS 14+) and return the auth status.

    The completion handler fires on a background queue; we block on an event.
    """
    done = threading.Event()
    box: dict[str, object] = {}

    def handler(granted, error):  # noqa: ANN001
        box["granted"] = bool(granted)
        box["error"] = error
        done.set()

    store.requestFullAccessToEventsWithCompletion_(handler)
    if not done.wait(timeout=60):
        die("timed out waiting for calendar access prompt.")
    # Whatever the user clicked, read the authoritative status afterwards.
    return EKEventStore.authorizationStatusForEntityType_(EKEntityTypeEvent)


def nsdate_to_utc_iso(nsdate) -> str:
    """Convert an EventKit NSDate to a UTC ISO-8601 string with offset."""
    ts = nsdate.timeIntervalSince1970()
    return datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")


def collect_busy(store, labels: dict[str, str], horizon_days: int) -> list[dict]:
    now = NSDate.date()
    end = NSDate.dateWithTimeIntervalSinceNow_(horizon_days * 24 * 3600)

    calendars = store.calendarsForEntityType_(EKEntityTypeEvent)
    if not calendars or len(calendars) == 0:
        die("EventKit returned zero calendars. Access likely not granted "
            "(System Settings > Privacy & Security > Calendars).")

    predicate = store.predicateForEventsWithStartDate_endDate_calendars_(
        now, end, calendars
    )
    events = store.eventsMatchingPredicate_(predicate)

    out: list[dict] = []
    for ev in events:
        status = _AVAILABILITY_TO_STATUS.get(int(ev.availability()), "busy")
        if status is None:
            continue  # free
        cal_title = ev.calendar().title()
        out.append({
            "source": resolve_label(labels, str(cal_title)),
            "start": nsdate_to_utc_iso(ev.startDate()),
            "end": nsdate_to_utc_iso(ev.endDate()),
            "status": status,
        })
    return out


def upload(sas_url: str, payload: bytes, token: str | None = None,
           cf_access_client_id: str | None = None,
           cf_access_client_secret: str | None = None) -> None:
    # The upload is sent via the system `curl`, NOT Python's urllib. Cloudflare
    # Bot Fight Mode / Bot Management fingerprints the TLS/HTTP client and blocks
    # stdlib urllib with a 403 at the edge — before Access or the Worker, so
    # neither logs it — while curl's fingerprint is allowed. (Changing the
    # User-Agent does not help; the block is on the connection fingerprint.)
    headers = {"Content-Type": "application/json",
               "User-Agent": "AvailCal-macos-agent/1.0"}
    # Azure Blob needs x-ms-blob-type; an R2/S3 presigned PUT must NOT receive an
    # unsigned header that could break its signature, so add it only for Azure.
    if "blob.core.windows.net" in sas_url:
        headers["x-ms-blob-type"] = "BlockBlob"
    # When uploading via the Cloudflare Worker endpoint (PUT /raw/<src>.json),
    # authenticate with a Bearer token instead of a signed URL.
    if token:
        headers["Authorization"] = f"Bearer {token}"
    # Optional Cloudflare Access service token, only if the Worker host is fronted
    # by Access (Zero Trust); harmless when it isn't.
    if cf_access_client_id and cf_access_client_secret:
        headers["CF-Access-Client-Id"] = cf_access_client_id
        headers["CF-Access-Client-Secret"] = cf_access_client_secret

    print(
        f"upload: PUT {sas_url} via curl "
        f"[bearer={'yes' if token else 'no'}, "
        f"cf-access={'yes' if (cf_access_client_id and cf_access_client_secret) else 'no'}]",
        file=sys.stderr,
    )

    curl = shutil.which("curl") or "/usr/bin/curl"
    cmd = [curl, "-sS", "--max-time", "30", "-X", "PUT"]
    for key, value in headers.items():
        cmd += ["-H", f"{key}: {value}"]
    # Read the body from stdin (--data-binary @-) so size/bytes are never a
    # concern; capture the HTTP status via -w and the response body via -o.
    cmd += ["--data-binary", "@-", "-w", "%{http_code}"]
    with tempfile.NamedTemporaryFile() as body_file:
        cmd += ["-o", body_file.name, sas_url]
        try:
            proc = subprocess.run(cmd, input=payload, capture_output=True, timeout=45)
        except FileNotFoundError:
            die("curl not found (expected /usr/bin/curl on macOS).")
        except subprocess.TimeoutExpired:
            die("upload timed out after 45s (curl).")
        status = proc.stdout.decode("utf-8", "replace").strip()
        body = body_file.read().decode("utf-8", "replace")[:1000]

    if proc.returncode != 0 and status in ("", "000"):
        # Transport-level failure (DNS/TLS/connection), not an HTTP status.
        die(f"upload failed to connect via curl: {proc.stderr.decode('utf-8', 'replace').strip()}")
    if status not in ("200", "201"):
        sent = ", ".join(sorted(headers))  # names only, never values
        die(f"upload failed: HTTP {status}\n"
            f"  request headers sent: {sent}\n"
            f"  response body: {body!r}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="AvailCal macOS calendar exporter")
    ap.add_argument("--dry-run", action="store_true",
                    help="print JSON, upload nothing")
    ap.add_argument("--sas-url", default=os.environ.get("AVAILCAL_AGENT_SAS_URL", ""),
                    help="write-scoped upload URL: Azure SAS, R2 presigned PUT, or "
                         "Cloudflare Worker /raw/<src>.json (or AVAILCAL_AGENT_SAS_URL)")
    ap.add_argument("--token", default=os.environ.get("AVAILCAL_AGENT_TOKEN", ""),
                    help="Bearer token for the Cloudflare Worker upload endpoint "
                         "(or AVAILCAL_AGENT_TOKEN)")
    ap.add_argument("--cf-access-client-id",
                    default=os.environ.get("AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID", ""),
                    help="Cloudflare Access service-token Client ID, if the Worker "
                         "host is behind Access (or AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID)")
    ap.add_argument("--cf-access-client-secret",
                    default=os.environ.get("AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET", ""),
                    help="Cloudflare Access service-token Client Secret "
                         "(or AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET)")
    ap.add_argument("--sources-toml", default="./sources.toml")
    ap.add_argument("--horizon-days", type=int, default=90)
    ap.add_argument("--out", default="",
                    help="write the busy JSON to this file and skip upload "
                         "(handy for a manual `curl --data-binary @file` upload)")
    args = ap.parse_args(argv)

    if EKEventStore is None:
        die("EventKit/PyObjC not available. Run: "
            "pip install pyobjc-framework-EventKit (macOS 14+).")

    if not args.dry_run and not args.out and not args.sas_url:
        die("no --sas-url and AVAILCAL_AGENT_SAS_URL is empty (required unless --dry-run/--out).")

    labels = load_device_labels(args.sources_toml)

    store = EKEventStore.alloc().init()
    status = request_full_access(store)
    if status != _AUTH_FULL_ACCESS:
        die(f"full calendar access NOT granted (authorization status={status}). "
            "Grant it in System Settings > Privacy & Security > Calendars, then retry. "
            "Refusing to publish a possibly-empty feed.")

    busy = collect_busy(store, labels, args.horizon_days)
    payload = json.dumps(busy, indent=2).encode("utf-8")

    if not busy:
        print(f"warning: 0 busy events in the next {args.horizon_days} days. "
              "Verify this is correct.", file=sys.stderr)

    if args.out:
        Path(args.out).write_bytes(payload)
        print(f"Wrote {len(busy)} busy interval(s) to {args.out}. Nothing uploaded.",
              file=sys.stderr)
        return 0

    if args.dry_run:
        print(payload.decode("utf-8"))
        print(f"\n# DRY RUN: parsed {len(busy)} busy interval(s). Nothing uploaded.")
        return 0

    upload(args.sas_url, payload, token=args.token or None,
           cf_access_client_id=args.cf_access_client_id or None,
           cf_access_client_secret=args.cf_access_client_secret or None)
    print(f"Uploaded {len(busy)} busy interval(s).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
