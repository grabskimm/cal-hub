"""Tiny HTTP server so the merge job can run as a Cloudflare Container.

Cloudflare Containers are request-oriented: a Worker boots the container and
proxies HTTP to a port. So instead of a one-shot CLI, the container runs this
server and the Worker's hourly Cron Trigger calls ``POST /run`` to execute one
pull→normalize→merge→emit→upload cycle (writing to R2). The container then idles
and Cloudflare scales it to zero via ``sleepAfter``.

Endpoints:
  * ``GET  /health`` -> ``{"status":"ok"}`` (liveness).
  * ``POST /run``    -> executes a merge cycle; returns the written object list.

Auth: ``/run`` requires ``Authorization: Bearer <AVAILCAL_RUN_TOKEN>`` when that
env var is set (the Worker sets and sends it). The endpoint is not exposed to the
public internet — only the Worker's container binding can reach it — but the
token is defence in depth.

Pure stdlib: no extra dependency, and runnable/testable locally.
"""

from __future__ import annotations

import hmac
import json
import logging
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from .main import Config, run

log = logging.getLogger("availcal.server")

DEFAULT_PORT = 8080


def _authorized(headers, token: str | None) -> bool:
    """Constant-time bearer check. Open when no token is configured."""
    if not token:
        return True
    auth = headers.get("Authorization", "")
    prefix = "Bearer "
    if not auth.startswith(prefix):
        return False
    return hmac.compare_digest(auth[len(prefix):], token)


class Handler(BaseHTTPRequestHandler):
    server_version = "availcal/1"

    # Quieter logs routed through the logger rather than stderr noise.
    def log_message(self, fmt: str, *args) -> None:  # noqa: A003
        log.info("%s - %s", self.address_string(), fmt % args)

    def _send(self, code: int, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] == "/health":
            self._send(200, {"status": "ok"})
        else:
            self._send(404, {"error": "not found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path.split("?", 1)[0] != "/run":
            self._send(404, {"error": "not found"})
            return
        token = os.environ.get("AVAILCAL_RUN_TOKEN")
        if not _authorized(self.headers, token):
            self._send(401, {"error": "unauthorized"})
            return
        # Drain any request body so the connection stays clean.
        length = int(self.headers.get("Content-Length", "0") or "0")
        if length:
            self.rfile.read(length)
        try:
            written = run(Config.from_env())
            self._send(200, {"status": "ok", "written": written})
        except Exception as exc:  # noqa: BLE001 - report failure to caller + logs
            log.exception("merge run failed")
            self._send(500, {"status": "error", "error": str(exc)})


def build_server(port: int | None = None) -> ThreadingHTTPServer:
    port = port if port is not None else int(os.environ.get("PORT", DEFAULT_PORT))
    return ThreadingHTTPServer(("0.0.0.0", port), Handler)  # noqa: S104 - container


def main() -> int:
    logging.basicConfig(
        level=os.environ.get("AVAILCAL_LOG_LEVEL", "INFO"),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )
    httpd = build_server()
    host, port = httpd.server_address[:2]
    log.info("availcal server listening on %s:%s", host, port)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
