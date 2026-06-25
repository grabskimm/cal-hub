#!/usr/bin/env bash
# Install the AvailCal macOS launchd agent (hourly).
#
# Usage:
#   AVAILCAL_AGENT_SAS_URL="https://availcal.<domain>/raw/<Label>.json" \
#   AVAILCAL_AGENT_TOKEN="<worker AGENT_TOKEN>" \
#   ./install.sh /path/to/install/dir
#
# The install dir should contain export_calendar.py and sources.toml. Both the
# upload URL (AVAILCAL_AGENT_SAS_URL) and, for the Cloudflare Worker, the Bearer
# token (AVAILCAL_AGENT_TOKEN) are read from the environment at install time and
# baked into the launchd plist (launchd does not inherit your shell env).
# For the Cloudflare deployment the URL is the Worker endpoint
# https://availcal.<domain>/raw/<Label>.json; for Azure it's a write-scoped SAS
# URL and the token is left blank.
set -euo pipefail

INSTALL_DIR="${1:-$HOME/availcal}"
SRC_DIR="$(cd "$(dirname "$0")" && pwd)"
PLIST_SRC="$SRC_DIR/com.availcal.export.plist"
APP_INFO_SRC="$SRC_DIR/app/Info.plist"
APP_LAUNCHER_SRC="$SRC_DIR/app/launcher.c"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"
PLIST_DST="$LAUNCH_AGENTS/com.availcal.export.plist"
SAS_URL="${AVAILCAL_AGENT_SAS_URL:-}"
TOKEN="${AVAILCAL_AGENT_TOKEN:-}"
# Cloudflare Access service token (only needed if the Worker host is behind Access).
CF_ACCESS_ID="${AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID:-}"
CF_ACCESS_SECRET="${AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET:-}"
# Base interpreter used only to BUILD the venv. The system python3 is the right
# default on macOS; override with AVAILCAL_BASE_PYTHON if you must.
BASE_PYTHON="${AVAILCAL_BASE_PYTHON:-/usr/bin/python3}"
VENV_DIR="$INSTALL_DIR/venv"
PYTHON_BIN="$VENV_DIR/bin/python"
# Signed .app bundle that gives the launchd job a real macOS app identity, so the
# Calendar (TCC) prompt appears and the grant persists under "AvailCal".
APP_DIR="$INSTALL_DIR/AvailCal.app"
APP_EXEC="$APP_DIR/Contents/MacOS/availcal"

if [[ ! -f "$INSTALL_DIR/export_calendar.py" ]]; then
  echo "error: $INSTALL_DIR/export_calendar.py not found." >&2
  echo "Copy export_calendar.py and sources.toml into $INSTALL_DIR first." >&2
  exit 1
fi

if [[ ! -x "$BASE_PYTHON" ]]; then
  echo "error: base python '$BASE_PYTHON' not found or not executable." >&2
  echo "Set AVAILCAL_BASE_PYTHON to a python3 (3.9+) on this Mac." >&2
  exit 1
fi

for tool in cc codesign; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "error: '$tool' not found. Install the Xcode Command Line Tools:" >&2
    echo "  xcode-select --install" >&2
    exit 1
  fi
done

# Build a dedicated venv with PyObjC so the agent never depends on whatever
# python3 happens to be on PATH. Idempotent: re-running refreshes the deps.
echo "Creating venv at $VENV_DIR (base: $BASE_PYTHON)..."
"$BASE_PYTHON" -m venv "$VENV_DIR"
"$PYTHON_BIN" -m pip install --upgrade --quiet pip
echo "Installing pyobjc-framework-EventKit into the venv..."
"$PYTHON_BIN" -m pip install --quiet pyobjc-framework-EventKit

# Fail fast if EventKit still can't be imported by the venv interpreter.
if ! "$PYTHON_BIN" -c "import EventKit" 2>/dev/null; then
  echo "error: EventKit failed to import in the venv even after install." >&2
  echo "Check that $BASE_PYTHON is a real CPython (3.9+) and re-run." >&2
  exit 1
fi
echo "EventKit OK in venv."

# Build the signed AvailCal.app bundle. The launcher is a tiny native binary
# inside Contents/MacOS, so the process carries the bundle's TCC identity; it
# spawns the venv python as a child, which inherits AvailCal.app as its
# responsible process. No secrets are compiled in, so the signature stays stable
# when the upload URL/token change.
echo "Building $APP_DIR ..."
rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
cp "$APP_INFO_SRC" "$APP_DIR/Contents/Info.plist"
cc -O2 -o "$APP_EXEC" "$APP_LAUNCHER_SRC" \
  -DAVAILCAL_PY="\"$PYTHON_BIN\"" \
  -DAVAILCAL_SCRIPT="\"$INSTALL_DIR/export_calendar.py\"" \
  -DAVAILCAL_TOML="\"$INSTALL_DIR/sources.toml\""
# Ad-hoc signature gives TCC a stable identity to attribute the grant to.
codesign --force --sign - --identifier com.availcal.export "$APP_DIR"
echo "Signed app bundle -> $APP_DIR"

if [[ -z "$SAS_URL" ]]; then
  echo "warning: AVAILCAL_AGENT_SAS_URL is empty. The agent will fail to upload" >&2
  echo "until you set it (the Cloudflare Worker /raw/<Label>.json URL, an Azure" >&2
  echo "SAS URL, or switch to a Managed Identity)." >&2
fi

# For the Cloudflare Worker, the Bearer token is required.
if [[ "$SAS_URL" == *"/raw/"* && "$SAS_URL" != *"blob.core.windows.net"* && -z "$TOKEN" ]]; then
  echo "warning: the URL looks like the Cloudflare Worker endpoint but" >&2
  echo "AVAILCAL_AGENT_TOKEN is empty — uploads will 401. Set it to the Worker's" >&2
  echo "AGENT_TOKEN." >&2
fi

# If the Worker host is behind Cloudflare Access, uploads 403 at the edge unless
# a service token is supplied. Warn when only one half of the pair is set.
if [[ -n "$CF_ACCESS_ID" && -z "$CF_ACCESS_SECRET" ]] || [[ -z "$CF_ACCESS_ID" && -n "$CF_ACCESS_SECRET" ]]; then
  echo "warning: set BOTH AVAILCAL_AGENT_CF_ACCESS_CLIENT_ID and" >&2
  echo "AVAILCAL_AGENT_CF_ACCESS_CLIENT_SECRET (or neither). Access needs both." >&2
fi

mkdir -p "$LAUNCH_AGENTS"

# Render the plist template with concrete paths + upload URL + token (escaped).
# Escape backslash first, then the sed delimiter '/' and the replacement-special
# '&', so a value containing any of them can't corrupt the rendered plist.
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/[/&]/\\&/g'; }
sed -e "s/__INSTALL_DIR__/$(esc "$INSTALL_DIR")/g" \
    -e "s/__APP_EXEC__/$(esc "$APP_EXEC")/g" \
    -e "s/__SAS_URL__/$(esc "$SAS_URL")/g" \
    -e "s/__TOKEN__/$(esc "$TOKEN")/g" \
    -e "s/__CF_ACCESS_ID__/$(esc "$CF_ACCESS_ID")/g" \
    -e "s/__CF_ACCESS_SECRET__/$(esc "$CF_ACCESS_SECRET")/g" \
    "$PLIST_SRC" > "$PLIST_DST"
chmod 600 "$PLIST_DST"   # the plist now holds secrets (token + Access secret)

# Reload into the user's GUI session (never sudo — TCC + LaunchAgents are per-user).
launchctl bootout "gui/$(id -u)/com.availcal.export" 2>/dev/null || true
launchctl unload "$PLIST_DST" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "Installed launchd agent -> $PLIST_DST (hourly)."
echo "App bundle -> $APP_DIR (shows as \"AvailCal\" in Privacy > Calendars)."
echo
echo "IMPORTANT: trigger the FIRST run now, in your GUI session, so the macOS"
echo "Calendar (TCC) prompt appears as \"AvailCal\" — click Allow (Full Access):"
echo "  launchctl kickstart -k gui/$(id -u)/com.availcal.export"
echo
echo "Watch logs:"
echo "  tail -f $INSTALL_DIR/export.log $INSTALL_DIR/export.err.log"
echo
echo "Do NOT run any of this under sudo — it sends the job and the grant to the"
echo "wrong user. See TROUBLESHOOTING.md if the prompt does not appear."
