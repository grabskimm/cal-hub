"""Tests for the pull layer + source registry (no network)."""

from __future__ import annotations

from pathlib import Path

import httpx
import pytest

from availcal.pull import (
    fetch_ics_feed,
    fetch_ics_feeds,
    load_raw_json,
    load_raw_json_dir,
)
from availcal.sources import load_sources, slugify_label

FIX = Path(__file__).parent / "fixtures"
REPO = Path(__file__).resolve().parents[2]


# --- source registry ---


def test_load_example_registry_valid():
    reg = load_sources(REPO / "sources.example.toml")
    assert reg.ics["GoogPersonal"] == "Perso"
    assert reg.caldav["icloud_calendar"] == "iCloud"
    assert "WorkX" in reg.all_labels


def test_duplicate_label_fails_fast(tmp_path):
    p = tmp_path / "sources.toml"
    p.write_text('[ics]\nA = "Dup"\n[device]\nB = "Dup"\n')
    with pytest.raises(ValueError, match="duplicate source label"):
        load_sources(p)


def test_whitespace_label_fails_fast(tmp_path):
    p = tmp_path / "sources.toml"
    p.write_text('[ics]\nA = "Two Words"\n')
    with pytest.raises(ValueError, match="single token"):
        load_sources(p)


def test_unmapped_source_is_slugified_and_logged(tmp_path):
    p = tmp_path / "sources.toml"
    p.write_text('[device]\nKnown = "Mac"\n')
    reg = load_sources(p)
    assert reg.resolve("device", "Outlook - Work") == "Outlook_Work"
    assert reg.unmapped()  # recorded as needing an entry


def test_slugify_label():
    assert slugify_label("Outlook - Work") == "Outlook_Work"
    assert slugify_label("  ") == "Unknown"


# --- ICS feed fetching ---


def _mock_client(handler) -> httpx.Client:
    return httpx.Client(transport=httpx.MockTransport(handler))


def test_fetch_ics_feed_success():
    ics = (FIX / "dst.ics").read_bytes()
    client = _mock_client(lambda req: httpx.Response(200, content=ics))
    cal = fetch_ics_feed("Work", "https://x/secret.ics", client=client)
    assert cal is not None
    assert any(c.name == "VEVENT" for c in cal.walk())


def test_one_feed_failing_does_not_abort_others():
    good = (FIX / "dst.ics").read_bytes()

    def handler(req: httpx.Request) -> httpx.Response:
        if "bad" in str(req.url):
            return httpx.Response(500)
        return httpx.Response(200, content=good)

    client = _mock_client(handler)
    feeds = {"BadFeed": "https://x/bad.ics", "GoodFeed": "https://x/ok.ics"}
    out = fetch_ics_feeds(feeds, client=client, sleep=lambda s: None)
    # Bad feed skipped, good feed kept.
    assert [f.rawname for f in out] == ["GoodFeed"]


def test_fetch_retries_then_gives_up():
    calls = {"n": 0}

    def handler(req: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        return httpx.Response(503)

    client = _mock_client(handler)
    cal = fetch_ics_feed(
        "Work", "https://x/down.ics", client=client, max_retries=3, sleep=lambda s: None
    )
    assert cal is None
    assert calls["n"] == 3


# --- raw JSON ---


def test_load_raw_json_fixture():
    ivs = load_raw_json((FIX / "raw_workx.json").read_text())
    assert len(ivs) == 2
    assert {iv.source for iv in ivs} == {"WorkX"}
    assert all(iv.start.utcoffset().total_seconds() == 0 for iv in ivs)


def test_load_raw_json_rejects_naive():
    bad = '[{"source":"X","start":"2026-06-24T09:00:00","end":"2026-06-24T10:00:00","status":"busy"}]'
    with pytest.raises(ValueError, match="aware"):
        load_raw_json(bad)


def test_load_raw_json_dir(tmp_path):
    (tmp_path / "a.json").write_text((FIX / "raw_workx.json").read_text())
    ivs = load_raw_json_dir(tmp_path)
    assert len(ivs) == 2
