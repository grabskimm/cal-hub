"""Orchestrator: pull -> normalize -> merge -> emit -> upload.

Driven entirely by environment variables (see ``.env.example``). Designed to run
as a scheduled Azure Container Apps Job (scale-to-zero) but also runs fully
locally against fixtures with no Azure dependency, which is how the container is
smoke-tested.

Output sink selection (first match wins):
  * ``AVAILCAL_OUTPUT_DIR`` set -> write files to that directory (local/CI/demo).
  * ``AZURE_STORAGE_CONNECTION_STRING`` set -> upload via that connection string.
  * ``AVAILCAL_STORAGE_ACCOUNT`` set -> upload via Managed Identity
    (``DefaultAzureCredential``) — the production path.

Secrets (feed URLs, CalDAV passwords) come from env, or from Key Vault when
``AVAILCAL_KEYVAULT_URI`` is set (resolved at runtime via ``azure-identity``).
"""

from __future__ import annotations

import logging
import os
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path

import icalendar

from .emit import emit_merged_ics, emit_per_source
from .merge import merge_intervals
from .models import BusyInterval
from .normalize import normalize_calendar
from .pull import (
    fetch_ics_feeds,
    load_raw_json,
    load_raw_json_dir,
    read_vdir,
    run_vdirsyncer,
)
from .sources import SourceRegistry, load_sources
from .storage import (
    MERGED_OBJECT,
    RAW_PREFIX,
    AzureBlobBackend,
    LocalStorageBackend,
    R2StorageBackend,
    StorageBackend,
)
from .timeutil import now_utc

log = logging.getLogger("availcal")


def _parse_feeds(spec: str) -> dict[str, str]:
    """Parse ``rawname=url,rawname=url`` into a dict. URLs may contain '='."""
    feeds: dict[str, str] = {}
    for part in filter(None, (p.strip() for p in spec.split(","))):
        rawname, _, url = part.partition("=")
        if rawname and url:
            feeds[rawname.strip()] = url.strip()
    return feeds


@dataclass
class Config:
    sources_toml: str
    ics_feeds: dict[str, str] = field(default_factory=dict)
    horizon_days: int = 90
    # Expansion window start. Defaults to "now" (the production semantic:
    # [now, now+horizon]). Settable for backfill/replay and deterministic tests.
    window_start: datetime | None = None
    include_tentative: bool = True
    default_tz: str = "America/New_York"
    emit_per_source: bool = True
    enable_caldav: bool = False
    vdirsyncer_config: str | None = None
    vdir_path: str | None = None
    # Local inputs (fixtures / CI). Treated as ICS feeds keyed by filename stem.
    local_ics_dir: str | None = None
    raw_json_dir: str | None = None
    # Output sink (first configured wins, in this order: local dir, R2, Azure).
    output_dir: str | None = None
    # Cloudflare R2 (S3-compatible).
    r2_bucket: str | None = None
    r2_account_id: str | None = None
    r2_access_key_id: str | None = None
    r2_secret_access_key: str | None = None
    r2_endpoint: str | None = None
    # Azure Blob.
    storage_account: str | None = None
    blob_container: str = "availcal"
    connection_string: str | None = None
    keyvault_uri: str | None = None

    @classmethod
    def from_env(cls, env: dict[str, str] | None = None) -> Config:
        env = env if env is not None else dict(os.environ)

        def flag(name: str, default: str) -> bool:
            return env.get(name, default).strip().lower() in {"1", "true", "yes", "on"}

        window_start_raw = env.get("AVAILCAL_WINDOW_START")
        window_start = None
        if window_start_raw:
            window_start = datetime.fromisoformat(window_start_raw)
            if window_start.tzinfo is None:
                raise ValueError(
                    "AVAILCAL_WINDOW_START must be timezone-aware "
                    "(include an offset, e.g. 2026-01-01T00:00:00+00:00)"
                )

        return cls(
            sources_toml=env.get("AVAILCAL_SOURCES_TOML", "./sources.toml"),
            ics_feeds=_parse_feeds(env.get("AVAILCAL_ICS_FEEDS", "")),
            horizon_days=int(env.get("AVAILCAL_HORIZON_DAYS", "90")),
            window_start=window_start,
            include_tentative=flag("AVAILCAL_INCLUDE_TENTATIVE", "true"),
            default_tz=env.get("AVAILCAL_DEFAULT_TZ", "America/New_York"),
            emit_per_source=flag("AVAILCAL_EMIT_PER_SOURCE", "true"),
            enable_caldav=flag("AVAILCAL_ENABLE_CALDAV", "0"),
            vdirsyncer_config=env.get("AVAILCAL_VDIRSYNCER_CONFIG"),
            vdir_path=env.get("AVAILCAL_VDIR_PATH"),
            local_ics_dir=env.get("AVAILCAL_LOCAL_ICS_DIR"),
            raw_json_dir=env.get("AVAILCAL_RAW_JSON_DIR"),
            output_dir=env.get("AVAILCAL_OUTPUT_DIR"),
            r2_bucket=env.get("AVAILCAL_R2_BUCKET"),
            r2_account_id=env.get("AVAILCAL_R2_ACCOUNT_ID"),
            r2_access_key_id=env.get("AVAILCAL_R2_ACCESS_KEY_ID"),
            r2_secret_access_key=env.get("AVAILCAL_R2_SECRET_ACCESS_KEY"),
            r2_endpoint=env.get("AVAILCAL_R2_ENDPOINT"),
            storage_account=env.get("AVAILCAL_STORAGE_ACCOUNT"),
            blob_container=env.get("AVAILCAL_BLOB_CONTAINER", "availcal"),
            connection_string=env.get("AZURE_STORAGE_CONNECTION_STRING"),
            keyvault_uri=env.get("AVAILCAL_KEYVAULT_URI"),
        )


def _resolve_secrets_from_keyvault(cfg: Config) -> None:
    """If a Key Vault is configured, pull feed URLs from it at runtime.

    Convention: each secret named ``ics-<rawname>`` holds that feed's URL. This
    keeps secrets out of env/git; the job's Managed Identity has Secrets User.
    """
    if not cfg.keyvault_uri:
        return
    from azure.identity import DefaultAzureCredential
    from azure.keyvault.secrets import SecretClient

    client = SecretClient(vault_url=cfg.keyvault_uri, credential=DefaultAzureCredential())
    for secret in client.list_properties_of_secrets():
        name = secret.name
        if name.startswith("ics-"):
            rawname = name[len("ics-"):]
            cfg.ics_feeds[rawname] = client.get_secret(name).value
    log.info("loaded %d feed secret(s) from Key Vault", len(cfg.ics_feeds))


def gather_intervals(cfg: Config, registry: SourceRegistry) -> list[BusyInterval]:
    """Pull every channel and normalize into one BusyInterval list."""
    window_start = cfg.window_start or now_utc()
    window_end = window_start + timedelta(days=cfg.horizon_days)
    norm_kw = dict(
        window_start=window_start,
        window_end=window_end,
        default_tz=cfg.default_tz,
        include_tentative=cfg.include_tentative,
    )
    intervals: list[BusyInterval] = []

    # 1. Remote ICS feeds.
    if cfg.ics_feeds:
        for feed in fetch_ics_feeds(cfg.ics_feeds):
            label = registry.resolve("ics", feed.rawname)
            intervals += normalize_calendar(feed.calendar, source=label, **norm_kw)

    # 2. Local ICS files (fixtures / CI demo) keyed by filename stem.
    if cfg.local_ics_dir:
        for ics in sorted(Path(cfg.local_ics_dir).glob("*.ics")):
            label = registry.resolve("ics", ics.stem)
            cal = icalendar.Calendar.from_ical(ics.read_text())
            intervals += normalize_calendar(cal, source=label, **norm_kw)

    # 3. CalDAV via vdirsyncer.
    if cfg.enable_caldav and cfg.vdirsyncer_config and cfg.vdir_path:
        if run_vdirsyncer(cfg.vdirsyncer_config):
            for collection, cal in read_vdir(cfg.vdir_path):
                label = registry.resolve("caldav", collection)
                intervals += normalize_calendar(cal, source=label, **norm_kw)

    # 4. Device JSON. The agent already stamps the final one-word label, so we
    #    re-validate (model rejects naive/non-UTC) and keep the source as-is.
    if cfg.raw_json_dir:
        intervals += load_raw_json_dir(cfg.raw_json_dir)
    backend = make_backend(cfg)
    if backend is not None:
        for name, data in backend.iter_raw_json():
            log.info("reading device upload %s", name)
            intervals += load_raw_json(data.decode("utf-8"))

    return intervals


# ----------------------- output sink selection -----------------------


def make_backend(cfg: Config) -> StorageBackend | None:
    """Pick the storage backend from config (first configured wins).

    Order: local directory (dev/CI) -> Cloudflare R2 -> Azure Blob. Returns None
    only when nothing is configured (a pure in-memory run with no output).
    """
    if cfg.output_dir:
        return LocalStorageBackend(cfg.output_dir)
    if cfg.r2_bucket:
        return R2StorageBackend(
            bucket=cfg.r2_bucket,
            account_id=cfg.r2_account_id,
            access_key_id=cfg.r2_access_key_id,
            secret_access_key=cfg.r2_secret_access_key,
            endpoint_url=cfg.r2_endpoint,
        )
    if cfg.connection_string or cfg.storage_account:
        return AzureBlobBackend(
            container=cfg.blob_container,
            connection_string=cfg.connection_string,
            storage_account=cfg.storage_account,
        )
    return None


def write_outputs(
    cfg: Config, merged_ics: bytes, per_source: dict[str, bytes]
) -> list[str]:
    """Write merged + optional per-source feeds to the configured backend.

    Returns the list of written locators (for logging/tests).
    """
    backend = make_backend(cfg)
    if backend is None:
        raise RuntimeError(
            "no output sink configured (set AVAILCAL_OUTPUT_DIR, R2, or Azure env)"
        )

    written = [backend.upload(MERGED_OBJECT, merged_ics)]
    for label, data in per_source.items():
        written.append(backend.upload(f"{RAW_PREFIX}{label}.ics", data))
    return written


def run(cfg: Config) -> list[str]:
    """Full pipeline. Returns written output paths/blob names."""
    registry = load_sources(cfg.sources_toml)
    _resolve_secrets_from_keyvault(cfg)

    intervals = gather_intervals(cfg, registry)
    log.info("gathered %d raw intervals", len(intervals))

    if registry.unmapped():
        for entry in registry.unmapped():
            log.warning("unmapped source (add to sources.toml): %s", entry)

    merged = merge_intervals(intervals)
    log.info("merged into %d source-tagged blocks", len(merged))

    merged_ics = emit_merged_ics(merged)
    per_source = emit_per_source(merged) if cfg.emit_per_source else {}

    written = write_outputs(cfg, merged_ics, per_source)
    log.info("wrote %d output(s): %s", len(written), ", ".join(written))
    return written


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(
        level=os.environ.get("AVAILCAL_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    cfg = Config.from_env()
    try:
        run(cfg)
    except Exception:  # noqa: BLE001 — top-level: log and exit non-zero
        log.exception("availcal run failed")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
