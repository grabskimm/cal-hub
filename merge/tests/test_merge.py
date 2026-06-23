"""Tests for dedup + per-source overlap collapse."""

from __future__ import annotations

from datetime import UTC, datetime
from pathlib import Path

import icalendar

from availcal.merge import merge_intervals
from availcal.models import BusyInterval
from availcal.normalize import normalize_calendar

FIX = Path(__file__).parent / "fixtures"
WS = datetime(2026, 1, 1, tzinfo=UTC)
WE = datetime(2026, 12, 31, tzinfo=UTC)


def _utc(y, mo, d, h, mi=0):
    return datetime(y, mo, d, h, mi, tzinfo=UTC)


def _norm(name: str, source: str):
    cal = icalendar.Calendar.from_ical((FIX / name).read_text())
    return normalize_calendar(
        cal, source=source, window_start=WS, window_end=WE, default_tz="America/New_York"
    )


def test_same_source_overlaps_collapse():
    ivs = _norm("overlap_same_source.ics", "Work")
    merged = merge_intervals(ivs)
    # A 09:00-10:30, B 10:00-11:30, C 11:30-12:00 (EDT) collapse to one block.
    assert len(merged) == 1
    m = merged[0]
    assert m.start == _utc(2026, 6, 20, 13, 0)   # 09:00 EDT
    assert m.end == _utc(2026, 6, 20, 16, 0)     # 12:00 EDT
    assert m.source == "Work"


def test_different_sources_stay_separate():
    a = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Work")
    b = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Perso")
    merged = merge_intervals([a, b])
    # Same time, two sources -> two distinct, separately-tagged events.
    assert len(merged) == 2
    assert {m.source for m in merged} == {"Work", "Perso"}
    # Distinct UIDs so clients show two blocks.
    assert merged[0].stable_uid() != merged[1].stable_uid()


def test_dedup_same_uid_across_two_feeds():
    a = _norm("dup_uid_a.ics", "Work")
    b = _norm("dup_uid_b.ics", "Work")
    merged = merge_intervals(a + b)
    # Same UID + same label seen twice -> collapses to one.
    assert len(merged) == 1


def test_fuzzy_dedup_within_one_minute():
    a = BusyInterval(_utc(2026, 6, 24, 9, 0), _utc(2026, 6, 24, 10, 0), "Work", uid="a")
    b = BusyInterval(_utc(2026, 6, 24, 9, 0), _utc(2026, 6, 24, 10, 0), "Work", uid="b")
    merged = merge_intervals([a, b])
    # Different UID but identical times within +-1 min -> deduped to one block.
    assert len(merged) == 1


def test_cross_source_overlap_not_collapsed_even_when_overlapping():
    a = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 11), "Work")
    b = BusyInterval(_utc(2026, 6, 24, 10), _utc(2026, 6, 24, 12), "iCloud")
    merged = merge_intervals([a, b])
    assert len(merged) == 2
    assert {m.source for m in merged} == {"Work", "iCloud"}


def test_adjacent_same_source_merges_but_disjoint_does_not():
    adj_a = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Work")
    adj_b = BusyInterval(_utc(2026, 6, 24, 10), _utc(2026, 6, 24, 11), "Work")
    disjoint = BusyInterval(_utc(2026, 6, 24, 13), _utc(2026, 6, 24, 14), "Work")
    merged = sorted(merge_intervals([adj_a, adj_b, disjoint]), key=lambda i: i.start)
    assert len(merged) == 2
    assert merged[0].start == _utc(2026, 6, 24, 9)
    assert merged[0].end == _utc(2026, 6, 24, 11)
    assert merged[1].start == _utc(2026, 6, 24, 13)


def test_oof_outranks_tentative_when_collapsed():
    t = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 11), "Work", status="tentative")
    o = BusyInterval(_utc(2026, 6, 24, 10), _utc(2026, 6, 24, 12), "Work", status="oof")
    [m] = merge_intervals([t, o])
    # Merged block keeps the strongest status present.
    assert m.status == "oof"


def test_flatten_across_sources_unions_everything():
    from availcal.merge import flatten_across_sources

    a = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 11), "Work")
    b = BusyInterval(_utc(2026, 6, 24, 10), _utc(2026, 6, 24, 12), "iCloud")
    c = BusyInterval(_utc(2026, 6, 24, 13), _utc(2026, 6, 24, 14), "Perso")
    flat = sorted(flatten_across_sources([a, b, c]), key=lambda i: i.start)
    # a∪b overlap -> 9-12 ; c disjoint -> 13-14. Source erased to sentinel.
    assert len(flat) == 2
    assert flat[0].start == _utc(2026, 6, 24, 9)
    assert flat[0].end == _utc(2026, 6, 24, 12)
    assert {i.source for i in flat} == {"Busy"}


def test_fuzzy_dedup_indexed_per_source_keeps_distinct_sources():
    # Same times in two sources must NOT fuzzy-dedup across sources.
    a = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Work", uid="a")
    b = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Perso", uid="b")
    c = BusyInterval(_utc(2026, 6, 24, 9), _utc(2026, 6, 24, 10), "Work", uid="c")
    merged = merge_intervals([a, b, c])
    # Work's a & c fuzzy-collapse to one; Perso stays -> two events total.
    assert len(merged) == 2
    assert {m.source for m in merged} == {"Work", "Perso"}
