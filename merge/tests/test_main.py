"""End-to-end orchestrator test: local fixtures -> merged availability.ics."""

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path

import icalendar

import availcal.main as main_mod
from availcal.main import Config, run
from availcal.storage import MERGED_OBJECT, R2StorageBackend
from test_storage import FakeS3

FIX = Path(__file__).parent / "fixtures"


def _write_sources(tmp_path: Path) -> Path:
    p = tmp_path / "sources.toml"
    # Map each fixture .ics stem (used as the ICS rawname) to a label, plus the
    # device raw-json label.
    p.write_text(
        """
[ics]
dst = "Work"
allday = "Perso"
overlap_same_source = "Cal"
[device]
WorkX = "WorkX"
"""
    )
    return p


def test_run_local_emits_valid_merged_ics(tmp_path):
    sources = _write_sources(tmp_path)
    raw_dir = tmp_path / "raw"
    raw_dir.mkdir()
    (raw_dir / "workx.json").write_text((FIX / "raw_workx.json").read_text())
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    for name in ("dst.ics", "allday.ics", "overlap_same_source.ics"):
        (ics_dir / name).write_text((FIX / name).read_text())

    out_dir = tmp_path / "out"
    # Fixtures are dated in 2026, so the window start is pinned to ingest them
    # deterministically. The "new" block added further down is different: the
    # notification pruner discards any entry whose end has already passed, and it
    # uses the REAL wall clock (run() -> now_utc()), NOT cfg.window_start. So that
    # block has to sit in the future relative to now, and the horizon has to
    # stretch far enough to still ingest it — otherwise the test is a time bomb
    # that starts failing on a fixed calendar date.
    window_start = datetime(2026, 1, 1, tzinfo=UTC)
    new_start = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) + timedelta(days=30)
    new_end = new_start + timedelta(hours=1)
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        raw_json_dir=str(raw_dir),
        output_dir=str(out_dir),
        emit_per_source=True,
        window_start=window_start,
        horizon_days=max(365, (new_end - window_start).days + 2),
    )
    written = run(cfg)

    merged_path = out_dir / "merged" / "availability.ics"
    assert merged_path.exists()
    # Round-trips through icalendar -> valid ICS (DoD requirement).
    cal = icalendar.Calendar.from_ical(merged_path.read_bytes())
    vevents = [c for c in cal.walk() if c.name == "VEVENT"]
    assert vevents, "expected at least one busy block"

    # Self-describing: every SUMMARY is a known one-word source label.
    labels = {str(e.get("SUMMARY")) for e in vevents}
    assert labels <= {"Work", "Perso", "Cal", "WorkX"}
    assert "Work" in labels  # from dst.ics

    # Per-source overlays written too.
    assert any(p.endswith(".ics") and "/raw/" in p for p in written)

    # Notifications snapshot is written; first run establishes a baseline (no
    # additions), and a second run flags a genuinely new block.
    added_path = out_dir / "merged" / "added.json"
    assert added_path.exists()
    assert json.loads(added_path.read_text()) == []

    (ics_dir / "extra.ics").write_text(
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//t//EN\r\n"
        f"BEGIN:VEVENT\r\nUID:new@x\r\nDTSTART:{new_start.strftime('%Y%m%dT%H%M%SZ')}\r\n"
        f"DTEND:{new_end.strftime('%Y%m%dT%H%M%SZ')}\r\n"
        "SUMMARY:busy\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n"
    )
    run(cfg)
    added = json.loads(added_path.read_text())
    assert len(added) == 1
    assert added[0]["start"] == new_start.strftime("%Y-%m-%dT%H:%M:%SZ")
    assert "firstSeen" in added[0]


def test_run_collapses_same_source_only(tmp_path):
    sources = _write_sources(tmp_path)
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    (ics_dir / "overlap_same_source.ics").write_text(
        (FIX / "overlap_same_source.ics").read_text()
    )
    out_dir = tmp_path / "out"
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        output_dir=str(out_dir),
        emit_per_source=False,
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
    )
    run(cfg)
    cal = icalendar.Calendar.from_ical(
        (out_dir / "merged" / "availability.ics").read_bytes()
    )
    vevents = [c for c in cal.walk() if c.name == "VEVENT"]
    # Three overlapping same-source blocks collapse into exactly one.
    assert len(vevents) == 1


def test_run_routes_through_r2_backend(tmp_path, monkeypatch):
    """Device JSON is read from R2 raw/*.json and the merged feed is written
    back to R2 — proving the orchestrator is storage-backend agnostic."""
    sources = _write_sources(tmp_path)

    fake = FakeS3()
    fake.put_object(
        Bucket="availcal",
        Key="raw/WorkX.json",
        Body=(FIX / "raw_workx.json").read_bytes(),
    )
    backend = R2StorageBackend(bucket="availcal", client=fake)
    # Route make_backend to our fake-R2 backend regardless of cfg internals.
    monkeypatch.setattr(main_mod, "make_backend", lambda cfg: backend)

    cfg = Config(
        sources_toml=str(sources),
        r2_bucket="availcal",
        emit_per_source=True,
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
    )
    written = run(cfg)

    # Merged feed written to R2 and round-trips.
    assert f"r2://availcal/{MERGED_OBJECT}" in written
    merged = fake.store[("availcal", MERGED_OBJECT)]["Body"]
    cal = icalendar.Calendar.from_ical(merged)
    vevents = [c for c in cal.walk() if c.name == "VEVENT"]
    assert vevents, "device JSON from R2 should produce busy blocks"
    assert {str(e.get("SUMMARY")) for e in vevents} == {"WorkX"}


def test_run_emits_public_feed_without_labels(tmp_path):
    from availcal.storage import PUBLIC_OBJECT

    sources = _write_sources(tmp_path)
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    for name in ("dst.ics", "allday.ics", "overlap_same_source.ics"):
        (ics_dir / name).write_text((FIX / name).read_text())
    out_dir = tmp_path / "out"
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        output_dir=str(out_dir),
        emit_per_source=False,
        emit_public=True,
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
    )
    written = run(cfg)

    public_path = out_dir / PUBLIC_OBJECT
    assert public_path.exists()
    assert any(PUBLIC_OBJECT in w for w in written)

    text = public_path.read_text()
    cal = icalendar.Calendar.from_ical(text)
    evts = [c for c in cal.walk() if c.name == "VEVENT"]
    assert evts
    # Every summary is the generic word and NO source label leaks.
    assert {str(e.get("SUMMARY")) for e in evts} == {"Busy"}
    for leak in ("Work", "Perso", "Cal", "WorkX"):
        assert leak not in text


def test_public_feed_off_by_default(tmp_path):
    from availcal.storage import PUBLIC_OBJECT

    sources = _write_sources(tmp_path)
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    (ics_dir / "dst.ics").write_text((FIX / "dst.ics").read_text())
    out_dir = tmp_path / "out"
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        output_dir=str(out_dir),
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
    )
    run(cfg)
    assert not (out_dir / PUBLIC_OBJECT).exists()  # opt-in only


def test_parse_feeds_fails_fast_on_malformed():
    import pytest

    from availcal.main import _parse_feeds

    assert _parse_feeds("") == {}
    assert _parse_feeds("A=https://x/a.ics,B=https://y/b.ics") == {
        "A": "https://x/a.ics",
        "B": "https://y/b.ics",
    }
    # URL containing '=' is preserved (partition on first '=').
    assert _parse_feeds("A=https://x/a.ics?k=v") == {"A": "https://x/a.ics?k=v"}
    for bad in ("noequals", "=https://x", "A="):
        with pytest.raises(ValueError, match="malformed"):
            _parse_feeds(bad)


def test_run_emits_public_freebusy_json(tmp_path):
    import json as _json

    from availcal.storage import PUBLIC_FREEBUSY_OBJECT

    sources = _write_sources(tmp_path)
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    (ics_dir / "dst.ics").write_text((FIX / "dst.ics").read_text())
    out_dir = tmp_path / "out"
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        output_dir=str(out_dir),
        emit_per_source=False,
        emit_public=True,
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
    )
    written = run(cfg)
    assert any(PUBLIC_FREEBUSY_OBJECT in w for w in written)
    fb = out_dir / PUBLIC_FREEBUSY_OBJECT
    assert fb.exists()
    arr = _json.loads(fb.read_text())
    assert arr and all(set(o) == {"start", "end"} for o in arr)
    assert "Work" not in fb.read_text()
