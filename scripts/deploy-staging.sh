#!/usr/bin/env bash
#
# deploy-staging.sh — manual/controlled STAGING-ONLY deploy helper.
#
# Design goals:
#   * Safe by default: dry-run is the default and prints planned actions only.
#   * Staging only: never references production hosts, containers, or ports.
#   * Blast-radius bounded: real deploys operate only under the staging
#     release directories and act only on the single staging service.
#   * No secrets: this script never prints .env contents.
#
# It is intended to be invoked by .github/workflows/deploy-staging.yml on a
# self-hosted runner labelled [self-hosted, linux, sigen-staging], or by an
# operator by hand. There are intentionally NO production code paths here.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (overridable via environment)
# ---------------------------------------------------------------------------
STAGING_RELEASES_DIR="${STAGING_RELEASES_DIR:-/opt/sigen-staging/releases}"
STAGING_CURRENT_LINK="${STAGING_CURRENT_LINK:-/opt/sigen-staging/current}"

# Staging compose file, resolved relative to the repository root.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAGING_COMPOSE="${STAGING_COMPOSE:-${REPO_ROOT}/deploy/staging/docker-compose.staging.yml}"
STAGING_SERVICE="echarts-dashboard-staging"
STAGING_HEALTH_URL="${STAGING_HEALTH_URL:-http://127.0.0.1:3400/api/health}"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CONFIRM=""
DRY_RUN="true"

usage() {
  cat <<'EOF'
Usage: deploy-staging.sh --confirm DEPLOY_STAGING [--dry-run true|false]

Options:
  --confirm <phrase>   Required. Must be exactly DEPLOY_STAGING.
  --dry-run <bool>     Optional. Default: true. When true, only planned
                       actions are printed and nothing is changed.

Environment overrides:
  STAGING_RELEASES_DIR   Default /opt/sigen-staging/releases
  STAGING_CURRENT_LINK   Default /opt/sigen-staging/current
  STAGING_COMPOSE        Default <repo>/deploy/staging/docker-compose.staging.yml
  STAGING_HEALTH_URL     Default http://127.0.0.1:3400/api/health
  GITHUB_SHA / GITHUB_WORKSPACE   Provided by GitHub Actions.

This script is STAGING ONLY. It contains no production commands.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --confirm)
      CONFIRM="${2:-}"
      shift 2
      ;;
    --dry-run)
      DRY_RUN="${2:-}"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------
if [ "${CONFIRM}" != "DEPLOY_STAGING" ]; then
  echo "ERROR: --confirm must be exactly 'DEPLOY_STAGING' to proceed." >&2
  exit 1
fi

case "${DRY_RUN}" in
  true|false) ;;
  *)
    echo "ERROR: --dry-run must be 'true' or 'false' (got '${DRY_RUN}')." >&2
    exit 1
    ;;
esac

# Resolve the release identifier and source workspace.
RELEASE_ID="${GITHUB_SHA:-manual-$(date -u +%Y%m%dT%H%M%SZ)}"
SOURCE_WORKSPACE="${GITHUB_WORKSPACE:-${REPO_ROOT}}"
RELEASE_DIR="${STAGING_RELEASES_DIR}/${RELEASE_ID}"

log() { printf '[deploy-staging] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Dry-run: print the plan and exit successfully without changing anything.
# ---------------------------------------------------------------------------
if [ "${DRY_RUN}" = "true" ]; then
  log "DRY-RUN — no changes will be made. Planned actions:"
  log "  1. Create release dir:      ${RELEASE_DIR}"
  log "  2. Copy workspace from:     ${SOURCE_WORKSPACE}"
  log "     (rsync, excluding .git node_modules dist .hermes)"
  log "  3. Validate compose config: ${STAGING_COMPOSE}"
  log "  4. Build+up service:        ${STAGING_SERVICE}"
  log "  5. Health check:            ${STAGING_HEALTH_URL}"
  log "  6. Repoint current symlink: ${STAGING_CURRENT_LINK} -> ${RELEASE_DIR}"
  log "     (previous target preserved for rollback)"
  log "DRY-RUN complete. Re-run with --dry-run false to apply."
  exit 0
fi

# ---------------------------------------------------------------------------
# Real deploy (staging only). Bounded to the staging release directories.
# ---------------------------------------------------------------------------
log "REAL DEPLOY — staging only. Release: ${RELEASE_ID}"

# ---------------------------------------------------------------------------
# Blast-radius guard.
#
# Every destructive action below (rsync --delete into RELEASE_DIR, and the
# cp-fallback `rm -rf` of build dirs) must operate ONLY on paths strictly
# under STAGING_RELEASES_DIR. Refuse to run if RELEASE_DIR is not a concrete,
# absolute child of that root, or if RELEASE_ID could escape it via slashes
# or dot segments. This makes it impossible to remove anything outside a
# freshly-scoped release directory.
# ---------------------------------------------------------------------------
case "${STAGING_RELEASES_DIR}" in
  /?*) ;;
  *)
    log "ERROR: STAGING_RELEASES_DIR must be an absolute path (got '${STAGING_RELEASES_DIR}')."
    exit 1
    ;;
esac
case "${RELEASE_ID}" in
  ""|.|..|*/*|*..*)
    log "ERROR: refusing to deploy: unsafe RELEASE_ID '${RELEASE_ID}'."
    exit 1
    ;;
esac
case "${RELEASE_DIR}" in
  "${STAGING_RELEASES_DIR}/"?*) ;;
  *)
    log "ERROR: refusing to deploy: RELEASE_DIR '${RELEASE_DIR}' is not under '${STAGING_RELEASES_DIR}/'."
    exit 1
    ;;
esac

# Capture the previous release target (if any) for the rollback hint.
PREVIOUS_TARGET=""
if [ -L "${STAGING_CURRENT_LINK}" ]; then
  PREVIOUS_TARGET="$(readlink -f "${STAGING_CURRENT_LINK}" || true)"
fi

# 1. Create the release directory under the staging releases root.
log "Creating release dir: ${RELEASE_DIR}"
mkdir -p "${RELEASE_DIR}"

# 2. Copy the current workspace into the release dir, excluding heavy/build dirs.
log "Copying workspace ${SOURCE_WORKSPACE} -> ${RELEASE_DIR}"
if command -v rsync >/dev/null 2>&1; then
  rsync -a --delete \
    --exclude='.git' \
    --exclude='node_modules' \
    --exclude='dist' \
    --exclude='.hermes' \
    "${SOURCE_WORKSPACE}/" "${RELEASE_DIR}/"
else
  log "rsync unavailable; falling back to cp + manual prune"
  cp -a "${SOURCE_WORKSPACE}/." "${RELEASE_DIR}/"
  # Only explicit, literal child paths under the guarded RELEASE_DIR are
  # removed here — no globs, no variable-only targets, nothing outside it.
  rm -rf "${RELEASE_DIR}/.git" \
         "${RELEASE_DIR}/node_modules" \
         "${RELEASE_DIR}/dist" \
         "${RELEASE_DIR}/.hermes"
fi

# Compose file inside the freshly copied release.
RELEASE_COMPOSE="${RELEASE_DIR}/deploy/staging/docker-compose.staging.yml"
if [ ! -f "${RELEASE_COMPOSE}" ]; then
  # Fall back to the repo copy if the release layout differs.
  RELEASE_COMPOSE="${STAGING_COMPOSE}"
fi

# 3. Validate the compose configuration before touching containers.
log "Validating compose config: ${RELEASE_COMPOSE}"
docker compose -f "${RELEASE_COMPOSE}" config >/dev/null

# 4. Build and (re)start ONLY the staging service.
log "Building staging service: ${STAGING_SERVICE}"
docker compose -f "${RELEASE_COMPOSE}" build "${STAGING_SERVICE}"

log "Starting staging service: ${STAGING_SERVICE}"
docker compose -f "${RELEASE_COMPOSE}" up -d "${STAGING_SERVICE}"

# 5. Health check the staging endpoint (loopback only).
log "Health check: ${STAGING_HEALTH_URL}"
health_ok="false"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl -fsS --max-time 5 "${STAGING_HEALTH_URL}" >/dev/null 2>&1; then
    health_ok="true"
    log "Health check passed on attempt ${attempt}."
    break
  fi
  log "Health check attempt ${attempt} failed; retrying in 3s..."
  sleep 3
done

if [ "${health_ok}" != "true" ]; then
  log "ERROR: staging health check did not pass at ${STAGING_HEALTH_URL}."
  if [ -n "${PREVIOUS_TARGET}" ]; then
    log "ROLLBACK HINT: previous release was ${PREVIOUS_TARGET}"
    log "  To roll back: ln -sfn '${PREVIOUS_TARGET}' '${STAGING_CURRENT_LINK}'"
    log "  then rebuild/up ${STAGING_SERVICE} from that release's compose file."
  else
    log "ROLLBACK HINT: no previous 'current' symlink found to roll back to."
  fi
  exit 1
fi

# 6. Repoint the 'current' symlink to this release (atomic-ish via -n).
log "Repointing ${STAGING_CURRENT_LINK} -> ${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${STAGING_CURRENT_LINK}"

log "Staging deploy complete: ${RELEASE_ID}"
if [ -n "${PREVIOUS_TARGET}" ]; then
  log "ROLLBACK HINT: previous release was ${PREVIOUS_TARGET}"
  log "  To roll back: ln -sfn '${PREVIOUS_TARGET}' '${STAGING_CURRENT_LINK}'"
  log "  then rebuild/up ${STAGING_SERVICE} from that release's compose file."
else
  log "No previous release symlink existed before this deploy."
fi
