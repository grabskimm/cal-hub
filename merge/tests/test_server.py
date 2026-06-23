"""Tests for the container HTTP server (health, auth, run)."""

from __future__ import annotations

import json
import threading
import urllib.error
import urllib.request
from pathlib import Path

import availcal.server as server_mod
from availcal.server import build_server

FIX = Path(__file__).parent / "fixtures"


def _serve():
    httpd = build_server(port=0)  # ephemeral port
    t = threading.Thread(target=httpd.serve_forever, daemon=True)
    t.start()
    host, port = httpd.server_address[:2]
    return httpd, f"http://127.0.0.1:{port}"


def _req(url: str, method: str = "GET", headers: dict | None = None):
    req = urllib.request.Request(url, method=method, headers=headers or {})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read())


def test_health_ok():
    httpd, base = _serve()
    try:
        code, body = _req(f"{base}/health")
        assert code == 200 and body == {"status": "ok"}
    finally:
        httpd.shutdown()


def test_run_executes_pipeline(tmp_path, monkeypatch):
    # Point the server's Config.from_env at a local-dir backend via env, with a
    # fixture ICS source, so POST /run does a real cycle and writes output.
    sources = tmp_path / "sources.toml"
    sources.write_text('[ics]\ndst = "Work"\n')
    ics_dir = tmp_path / "ics"
    ics_dir.mkdir()
    (ics_dir / "dst.ics").write_text((FIX / "dst.ics").read_text())
    out_dir = tmp_path / "out"

    monkeypatch.setenv("AVAILCAL_SOURCES_TOML", str(sources))
    monkeypatch.setenv("AVAILCAL_LOCAL_ICS_DIR", str(ics_dir))
    monkeypatch.setenv("AVAILCAL_OUTPUT_DIR", str(out_dir))
    monkeypatch.setenv("AVAILCAL_WINDOW_START", "2026-01-01T00:00:00+00:00")
    monkeypatch.setenv("AVAILCAL_HORIZON_DAYS", "365")
    monkeypatch.delenv("AVAILCAL_RUN_TOKEN", raising=False)

    httpd, base = _serve()
    try:
        code, body = _req(f"{base}/run", method="POST")
        assert code == 200, body
        assert body["status"] == "ok"
        assert any("availability.ics" in w for w in body["written"])
        assert (out_dir / "merged" / "availability.ics").exists()
    finally:
        httpd.shutdown()


def test_run_requires_token_when_set(monkeypatch):
    monkeypatch.setenv("AVAILCAL_RUN_TOKEN", "s3cret")
    httpd, base = _serve()
    try:
        code, body = _req(f"{base}/run", method="POST")
        assert code == 401
        code2, _ = _req(
            f"{base}/run", method="POST", headers={"Authorization": "Bearer wrong"}
        )
        assert code2 == 401
    finally:
        httpd.shutdown()


def test_unknown_path_404():
    httpd, base = _serve()
    try:
        code, _ = _req(f"{base}/nope")
        assert code == 404
    finally:
        httpd.shutdown()


def test_authorized_helper():
    assert server_mod._authorized({}, None) is True
    assert server_mod._authorized({"Authorization": "Bearer x"}, "x") is True
    assert server_mod._authorized({"Authorization": "Bearer y"}, "x") is False
    assert server_mod._authorized({}, "x") is False
