"""End-to-end orchestrator test: local fixtures -> merged availability.ics."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import icalendar

from availcal.main import Config, run

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
    cfg = Config(
        sources_toml=str(sources),
        local_ics_dir=str(ics_dir),
        raw_json_dir=str(raw_dir),
        output_dir=str(out_dir),
        emit_per_source=True,
        # Fixtures are dated in 2026; pin the window to cover them deterministically.
        window_start=datetime(2026, 1, 1, tzinfo=UTC),
        horizon_days=365,
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
