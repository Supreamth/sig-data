#!/usr/bin/env bash
#
# verify-energy-cockpit-v2.sh — repeatable one-command verification for the
# Sigen Energy Cockpit V2 revamp.
#
# What it proves (read-only):
#   * server.js, app.js, and app-v2.js are syntactically valid Node.
#   * The base "stack" compose profile still renders a non-empty config.
#   * The running dashboard answers health, /api/cockpit,
#     /api/weather-vs-actual, /api/history?range=24h, and serves /index-v2.html.
#   * The cockpit endpoint reports status "ok" and the V2 page contains its
#     "Energy Cockpit" title.
#
# Safety / boundaries:
#   * NEVER rebuilds, restarts, stops, or otherwise mutates any container.
#   * NEVER switches the V1 root or edits application files.
#   * NEVER prints .env contents and never enables `set -x`.
#   * Targets SIGEN_COCKPIT_BASE_URL (default http://localhost:3200) so an
#     isolated test container — e.g. http://localhost:3321 — can be verified
#     without touching production on :3200.
#
# Usage:
#   bash scripts/verify-energy-cockpit-v2.sh
#   SIGEN_COCKPIT_BASE_URL=http://localhost:3321 bash scripts/verify-energy-cockpit-v2.sh

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
BASE_URL="${SIGEN_COCKPIT_BASE_URL:-http://localhost:3200}"
BASE_URL="${BASE_URL%/}"  # strip any trailing slash for clean path joins

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

COMPOSE_CONFIG_OUT="/tmp/sig-compose-config.out"
HEALTH_OUT="/tmp/sigen-cockpit-v2-health.json"
COCKPIT_OUT="/tmp/sigen-cockpit-v2-cockpit.json"
WEATHER_OUT="/tmp/sigen-cockpit-v2-weather-vs-actual.json"
HISTORY_OUT="/tmp/sigen-cockpit-v2-history-24h.json"
INDEX_V2_OUT="/tmp/sigen-cockpit-v2-index-v2.html"

log() { echo "[verify] $*"; }

log "Repo root: $REPO_ROOT"
log "Target base URL: $BASE_URL"

# ---------------------------------------------------------------------------
# 1. Node syntax checks
# ---------------------------------------------------------------------------
log "Checking Node syntax: echarts-dashboard/server.js"
node --check echarts-dashboard/server.js
log "Checking Node syntax: echarts-dashboard/public/app.js"
node --check echarts-dashboard/public/app.js
log "Checking Node syntax: echarts-dashboard/public/app-v2.js"
node --check echarts-dashboard/public/app-v2.js
log "Node syntax OK for server.js, app.js, app-v2.js"

# ---------------------------------------------------------------------------
# 2. Compose config renders and is non-empty
# ---------------------------------------------------------------------------
log "Rendering compose config (--profile stack) to $COMPOSE_CONFIG_OUT"
docker compose --profile stack config >"$COMPOSE_CONFIG_OUT"
if [ ! -s "$COMPOSE_CONFIG_OUT" ]; then
  echo "[verify] ERROR: compose config output $COMPOSE_CONFIG_OUT is empty" >&2
  exit 1
fi
log "Compose config OK ($(wc -l <"$COMPOSE_CONFIG_OUT" | tr -d ' ') lines)"

# ---------------------------------------------------------------------------
# 3. HTTP probes against the running dashboard
# ---------------------------------------------------------------------------
log "Probing health: $BASE_URL/api/health"
curl -fsS "$BASE_URL/api/health" -o "$HEALTH_OUT"
python3 -m json.tool "$HEALTH_OUT" >/dev/null
log "Health endpoint responded with valid JSON"

log "Probing cockpit: $BASE_URL/api/cockpit"
curl -fsS "$BASE_URL/api/cockpit" -o "$COCKPIT_OUT"
python3 -m json.tool "$COCKPIT_OUT" >/dev/null
log "Cockpit endpoint responded with valid JSON"

log "Probing weather-vs-actual: $BASE_URL/api/weather-vs-actual"
curl -fsS "$BASE_URL/api/weather-vs-actual" -o "$WEATHER_OUT"
python3 -m json.tool "$WEATHER_OUT" >/dev/null
log "Weather-vs-actual endpoint responded with valid JSON"

log "Probing history (24h): $BASE_URL/api/history?range=24h"
curl -fsS "$BASE_URL/api/history?range=24h" -o "$HISTORY_OUT"
python3 -m json.tool "$HISTORY_OUT" >/dev/null
log "History (24h) endpoint responded with valid JSON"

log "Fetching V2 page: $BASE_URL/index-v2.html"
curl -fsS "$BASE_URL/index-v2.html" -o "$INDEX_V2_OUT"
log "V2 page fetched to $INDEX_V2_OUT"

# ---------------------------------------------------------------------------
# 4. Content assertions
# ---------------------------------------------------------------------------
log "Validating cockpit status is \"ok\""
COCKPIT_STATUS="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1])).get("status",""))' "$COCKPIT_OUT")"
if [ "$COCKPIT_STATUS" != "ok" ]; then
  echo "[verify] ERROR: cockpit status is \"$COCKPIT_STATUS\", expected \"ok\"" >&2
  exit 1
fi
log "Cockpit status is \"ok\""

log "Validating V2 page contains \"Energy Cockpit\""
if ! grep -q "Energy Cockpit" "$INDEX_V2_OUT"; then
  echo "[verify] ERROR: $INDEX_V2_OUT does not contain \"Energy Cockpit\"" >&2
  exit 1
fi
log "V2 page contains \"Energy Cockpit\""

echo "Energy Cockpit V2 verification OK"
