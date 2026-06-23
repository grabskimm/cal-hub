"""Pull layer: get raw calendar data from every channel into one place.

Three channels, all funneling into the same normalize path:
  * **ICS feeds** (Google secret-iCal, Outlook published ICS): HTTP GET each
    secret URL with timeout + backoff; a single feed failing logs and is skipped
    (never aborts the whole run).
  * **CalDAV** (iCloud/Fastmail): ``vdirsyncer`` syncs into a local vdir, then we
    read the ``.ics`` files off disk.
  * **Device JSON** (``/raw/*.json`` pushed by the local agents): parsed straight
    into ``BusyInterval[]``.
"""

from __future__ import annotations

import json
import logging
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path

import httpx
import icalendar

from .models import BusyInterval

log = logging.getLogger("availcal.pull")

DEFAULT_TIMEOUT = 30.0
MAX_RETRIES = 3
BACKOFF_BASE = 2.0


@dataclass
class FetchedFeed:
    """A successfully fetched ICS feed and the rawname it came from."""

    rawname: str
    calendar: icalendar.Calendar


def fetch_ics_feed(
    rawname: str,
    url: str,
    *,
    client: httpx.Client,
    max_retries: int = MAX_RETRIES,
    backoff_base: float = BACKOFF_BASE,
    sleep=time.sleep,
) -> icalendar.Calendar | None:
    """Fetch a single ICS feed with retry/backoff; return None on persistent failure.

    Tolerating one feed's failure is a hard requirement — a stale or down feed
    must not abort the run.
    """
    last_exc: Exception | None = None
    for attempt in range(1, max_retries + 1):
        try:
            resp = client.get(url, timeout=DEFAULT_TIMEOUT, follow_redirects=True)
            resp.raise_for_status()
            return icalendar.Calendar.from_ical(resp.content)
        except Exception as exc:  # noqa: BLE001 — log + retry/skip by design
            last_exc = exc
            if attempt < max_retries:
                delay = backoff_base ** attempt
                log.warning(
                    "feed %s attempt %d/%d failed: %s; retrying in %.0fs",
                    rawname, attempt, max_retries, exc, delay,
                )
                sleep(delay)
    log.error("feed %s failed after %d attempts: %s", rawname, max_retries, last_exc)
    return None


def fetch_ics_feeds(
    feeds: dict[str, str], *, client: httpx.Client | None = None, sleep=time.sleep
) -> list[FetchedFeed]:
    """Fetch all configured ICS feeds, skipping (not aborting on) failures."""
    owns_client = client is None
    client = client or httpx.Client()
    out: list[FetchedFeed] = []
    try:
        for rawname, url in feeds.items():
            cal = fetch_ics_feed(rawname, url, client=client, sleep=sleep)
            if cal is not None:
                out.append(FetchedFeed(rawname=rawname, calendar=cal))
    finally:
        if owns_client:
            client.close()
    return out


def run_vdirsyncer(config_path: str | Path, *, runner=subprocess.run) -> bool:
    """Invoke ``vdirsyncer discover && sync`` for CalDAV sources.

    Returns True on success. CalDAV failures are logged and treated as a skipped
    channel (consistent with feeds) rather than aborting the run.
    """
    env_arg = ["-c", str(config_path)]
    try:
        for sub in ("discover", "sync"):
            proc = runner(
                ["vdirsyncer", *env_arg, sub],
                capture_output=True,
                text=True,
                check=False,
            )
            if proc.returncode != 0:
                log.error("vdirsyncer %s failed: %s", sub, proc.stderr.strip())
                return False
    except FileNotFoundError:
        log.error("vdirsyncer not installed; skipping CalDAV channel")
        return False
    return True


def read_vdir(vdir_path: str | Path) -> list[tuple[str, icalendar.Calendar]]:
    """Read a vdirsyncer output tree into (collection_name, Calendar) pairs.

    A vdir is ``<vdir>/<collection>/<uid>.ics``; the collection directory name is
    the rawname we resolve through the registry's ``caldav`` section.
    """
    root = Path(vdir_path)
    out: list[tuple[str, icalendar.Calendar]] = []
    if not root.is_dir():
        return out
    for collection in sorted(p for p in root.iterdir() if p.is_dir()):
        for ics in sorted(collection.glob("*.ics")):
            try:
                cal = icalendar.Calendar.from_ical(ics.read_text())
            except Exception as exc:  # noqa: BLE001 — skip a bad file, keep going
                log.warning("skipping unreadable %s: %s", ics, exc)
                continue
            out.append((collection.name, cal))
    return out


def load_raw_json(text: str, *, fallback_source: str | None = None) -> list[BusyInterval]:
    """Parse one agent upload JSON document into BusyInterval[].

    The agent already produced UTC-aware ISO timestamps and dropped free events;
    we re-validate through the model (which rejects naive/non-UTC) so a buggy
    agent can't smuggle in bad data.
    """
    from datetime import datetime

    records = json.loads(text)
    out: list[BusyInterval] = []
    for rec in records:
        source = rec.get("source") or fallback_source
        if source is None:
            raise ValueError(f"raw record missing 'source': {rec!r}")
        # fromisoformat keeps the +00:00 offset; BusyInterval re-validates that
        # the result is genuinely aware and UTC (offset 0), rejecting bad agents.
        out.append(
            BusyInterval(
                start=datetime.fromisoformat(rec["start"]),
                end=datetime.fromisoformat(rec["end"]),
                source=source,
                status=rec.get("status", "busy"),
                uid=rec.get("uid"),
            )
        )
    return out


def load_raw_json_dir(dir_path: str | Path) -> list[BusyInterval]:
    """Load every ``*.json`` under a directory (the local-fixtures equivalent of
    listing ``/raw/*.json`` blobs)."""
    out: list[BusyInterval] = []
    for jf in sorted(Path(dir_path).glob("*.json")):
        out.extend(load_raw_json(jf.read_text()))
    return out
