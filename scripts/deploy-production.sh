#!/usr/bin/env bash
#
# deploy-production.sh — manual/controlled PRODUCTION deploy + rollback helper.
#
# Design goals:
#   * Safe by default: dry-run is the default and prints planned actions only.
#   * Production only, single service: only ever touches the fixed container
#     name `echarts-dashboard` after an exact-name guard. Never a pattern,
#     glob, prefix, or `docker ps` filter.
#   * Blast-radius bounded: real deploys operate only under the production
#     release directories and act only on the single production service.
#   * No secrets: this script never prints .env contents and never uses set -x.
#
# It is intended to be invoked by .github/workflows/release-production.yml on a
# self-hosted runner labelled [self-hosted, linux, sigen-production], or by an
# operator by hand. It supports two modes:
#   * deploy   — build/replace the production dashboard from a checked-out tag.
#   * rollback — repoint `current` to a known previous release and restart.

set -euo pipefail

# ---------------------------------------------------------------------------
# Configuration (overridable via environment)
# ---------------------------------------------------------------------------
PRODUCTION_RELEASES_DIR="${PRODUCTION_RELEASES_DIR:-/opt/sigen-production/releases}"
PRODUCTION_CURRENT_LINK="${PRODUCTION_CURRENT_LINK:-/opt/sigen-production/current}"

# Production compose file, resolved relative to the repository root.
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRODUCTION_COMPOSE="${PRODUCTION_COMPOSE:-${REPO_ROOT}/deploy/production/docker-compose.production.yml}"
PRODUCTION_SERVICE="echarts-dashboard"
PRODUCTION_HEALTH_URL="${PRODUCTION_HEALTH_URL:-http://127.0.0.1:3200/api/health}"

# Relative path of the compose file inside a copied release.
RELEASE_COMPOSE_RELPATH="deploy/production/docker-compose.production.yml"

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
CONFIRM=""
DRY_RUN="true"
MODE="deploy"
TAG=""
ROLLBACK_RELEASE=""

usage() {
  cat <<'EOF'
Usage:
  deploy-production.sh --mode deploy   --tag vX.Y.Z --confirm DEPLOY_PRODUCTION [--dry-run true|false]
  deploy-production.sh --mode rollback --rollback-release /opt/sigen-production/releases/<id> \
                       --confirm DEPLOY_PRODUCTION [--dry-run true|false]

Options:
  --mode <deploy|rollback>   Required. Default: deploy.
  --tag <vX.Y.Z>             Required for deploy. Semantic version tag.
  --rollback-release <path>  Required for rollback. Existing absolute child
                             directory under the production releases root.
  --confirm <phrase>         Required. Must be exactly DEPLOY_PRODUCTION.
  --dry-run <bool>           Optional. Default: true. When true, only planned
                             actions are printed and nothing is changed.

Environment overrides:
  PRODUCTION_RELEASES_DIR   Default /opt/sigen-production/releases
  PRODUCTION_CURRENT_LINK   Default /opt/sigen-production/current
  PRODUCTION_COMPOSE        Default <repo>/deploy/production/docker-compose.production.yml
  PRODUCTION_HEALTH_URL     Default http://127.0.0.1:3200/api/health
  GITHUB_SHA / GITHUB_WORKSPACE   Provided by GitHub Actions.

This script is PRODUCTION scoped to the single service `echarts-dashboard`.
EOF
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --mode)
      MODE="${2:-}"
      shift 2
      ;;
    --tag)
      TAG="${2:-}"
      shift 2
      ;;
    --rollback-release)
      ROLLBACK_RELEASE="${2:-}"
      shift 2
      ;;
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

log() { printf '[deploy-production] %s\n' "$*"; }

# ---------------------------------------------------------------------------
# Common guards
# ---------------------------------------------------------------------------
if [ "${CONFIRM}" != "DEPLOY_PRODUCTION" ]; then
  echo "ERROR: --confirm must be exactly 'DEPLOY_PRODUCTION' to proceed." >&2
  exit 1
fi

case "${DRY_RUN}" in
  true|false) ;;
  *)
    echo "ERROR: --dry-run must be 'true' or 'false' (got '${DRY_RUN}')." >&2
    exit 1
    ;;
esac

case "${MODE}" in
  deploy|rollback) ;;
  *)
    echo "ERROR: --mode must be 'deploy' or 'rollback' (got '${MODE}')." >&2
    exit 1
    ;;
esac

# The production releases root must be an absolute path for every mode; all
# bounded path checks below depend on it.
case "${PRODUCTION_RELEASES_DIR}" in
  /?*) ;;
  *)
    echo "ERROR: PRODUCTION_RELEASES_DIR must be an absolute path (got '${PRODUCTION_RELEASES_DIR}')." >&2
    exit 1
    ;;
esac

# Semantic version tag pattern shared by the workflow guard.
TAG_REGEX='^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$'

# ---------------------------------------------------------------------------
# Exact-name container replacement (production, single service only).
#
# `docker compose up` refuses to create a container whose fixed name is already
# in use (e.g. the current live production container). We retire exactly that
# one container first. This is bounded and safe:
#   * It only ever targets the single, fixed name ${PRODUCTION_SERVICE} — never
#     a pattern, glob, prefix, or `docker ps` filter that could match siblings.
#   * It refuses to act unless `docker inspect` reports the container's name is
#     EXACTLY /${PRODUCTION_SERVICE}. Any mismatch aborts untouched.
# ---------------------------------------------------------------------------
replace_existing_container() {
  if docker inspect "${PRODUCTION_SERVICE}" >/dev/null 2>&1; then
    local existing_name
    existing_name="$(docker inspect --format '{{.Name}}' "${PRODUCTION_SERVICE}")"
    if [ "${existing_name}" = "/${PRODUCTION_SERVICE}" ]; then
      log "Existing production container '${PRODUCTION_SERVICE}' found (name '${existing_name}'); replacing it."
      log "Stopping production container: ${PRODUCTION_SERVICE}"
      docker stop "${PRODUCTION_SERVICE}" >/dev/null
      log "Removing production container: ${PRODUCTION_SERVICE}"
      docker rm "${PRODUCTION_SERVICE}" >/dev/null
    else
      log "ERROR: container '${PRODUCTION_SERVICE}' exists but its name is '${existing_name}',"
      log "       not the expected '/${PRODUCTION_SERVICE}'. Refusing to stop/remove it."
      exit 1
    fi
  else
    log "No pre-existing '${PRODUCTION_SERVICE}' container; nothing to replace."
  fi
}

# ---------------------------------------------------------------------------
# Health check the production endpoint (loopback only). Returns 0/1.
# ---------------------------------------------------------------------------
health_check() {
  log "Health check: ${PRODUCTION_HEALTH_URL}"
  local attempt
  for attempt in 1 2 3 4 5 6 7 8 9 10; do
    if curl -fsS --max-time 5 "${PRODUCTION_HEALTH_URL}" >/dev/null 2>&1; then
      log "Health check passed on attempt ${attempt}."
      return 0
    fi
    log "Health check attempt ${attempt} failed; retrying in 3s..."
    sleep 3
  done
  return 1
}

# ===========================================================================
# ROLLBACK MODE
# ===========================================================================
if [ "${MODE}" = "rollback" ]; then
  # Validate the rollback release identifier before touching anything.
  if [ -z "${ROLLBACK_RELEASE}" ]; then
    echo "ERROR: --rollback-release is required for --mode rollback." >&2
    exit 1
  fi
  case "${ROLLBACK_RELEASE}" in
    *..*)
      echo "ERROR: refusing rollback: unsafe path (contains '..'): '${ROLLBACK_RELEASE}'." >&2
      exit 1
      ;;
  esac
  # Must be an absolute child directory strictly under the releases root, and
  # must be more than the root itself (a non-empty final path segment).
  case "${ROLLBACK_RELEASE}" in
    "${PRODUCTION_RELEASES_DIR}/"?*) ;;
    *)
      echo "ERROR: refusing rollback: --rollback-release '${ROLLBACK_RELEASE}' is not a child of '${PRODUCTION_RELEASES_DIR}/'." >&2
      exit 1
      ;;
  esac

  ROLLBACK_COMPOSE="${ROLLBACK_RELEASE}/${RELEASE_COMPOSE_RELPATH}"

  if [ "${DRY_RUN}" = "true" ]; then
    log "DRY-RUN (rollback) — no changes will be made. Planned actions:"
    log "  1. Validate rollback release dir exists: ${ROLLBACK_RELEASE}"
    log "  2. Validate compose config: ${ROLLBACK_COMPOSE}"
    log "  3. Repoint current symlink: ${PRODUCTION_CURRENT_LINK} -> ${ROLLBACK_RELEASE}"
    log "  4. Replace + up only service: ${PRODUCTION_SERVICE}"
    log "  5. Health check: ${PRODUCTION_HEALTH_URL}"
    log "DRY-RUN complete. Re-run with --dry-run false to apply."
    exit 0
  fi

  log "REAL ROLLBACK — production. Target release: ${ROLLBACK_RELEASE}"

  if [ ! -d "${ROLLBACK_RELEASE}" ]; then
    log "ERROR: rollback release directory does not exist: ${ROLLBACK_RELEASE}"
    exit 1
  fi
  if [ ! -f "${ROLLBACK_COMPOSE}" ]; then
    log "ERROR: rollback compose file not found: ${ROLLBACK_COMPOSE}"
    exit 1
  fi

  # Capture the current target for reference before repointing.
  PREVIOUS_TARGET=""
  if [ -L "${PRODUCTION_CURRENT_LINK}" ]; then
    PREVIOUS_TARGET="$(readlink -f "${PRODUCTION_CURRENT_LINK}" || true)"
  fi

  log "Validating compose config: ${ROLLBACK_COMPOSE}"
  docker compose -f "${ROLLBACK_COMPOSE}" config >/dev/null

  log "Repointing ${PRODUCTION_CURRENT_LINK} -> ${ROLLBACK_RELEASE}"
  ln -sfn "${ROLLBACK_RELEASE}" "${PRODUCTION_CURRENT_LINK}"

  replace_existing_container

  log "Starting production service from rollback release: ${PRODUCTION_SERVICE}"
  docker compose -f "${ROLLBACK_COMPOSE}" up -d "${PRODUCTION_SERVICE}"

  if ! health_check; then
    log "ERROR: production health check did not pass after rollback at ${PRODUCTION_HEALTH_URL}."
    if [ -n "${PREVIOUS_TARGET}" ]; then
      log "Previous 'current' target before this rollback was: ${PREVIOUS_TARGET}"
    fi
    exit 1
  fi

  log "Production rollback complete. Active target: ${ROLLBACK_RELEASE}"
  if [ -n "${PREVIOUS_TARGET}" ]; then
    log "Previous 'current' target before this rollback was: ${PREVIOUS_TARGET}"
  fi
  exit 0
fi

# ===========================================================================
# DEPLOY MODE
# ===========================================================================

# Validate the tag: production deploys require a semantic version tag. Branch
# names and raw SHAs are rejected.
if [ -z "${TAG}" ]; then
  echo "ERROR: --tag vX.Y.Z is required for --mode deploy." >&2
  exit 1
fi
if ! printf '%s' "${TAG}" | grep -Eq "${TAG_REGEX}"; then
  echo "ERROR: --tag '${TAG}' is not a semantic version tag (expected vMAJOR.MINOR.PATCH[-suffix])." >&2
  exit 1
fi

# The release is identified by the tag. Refuse anything that could escape the
# releases root.
RELEASE_ID="${TAG}"
case "${RELEASE_ID}" in
  ""|.|..|*/*|*..*)
    echo "ERROR: refusing to deploy: unsafe RELEASE_ID '${RELEASE_ID}'." >&2
    exit 1
    ;;
esac

SOURCE_WORKSPACE="${GITHUB_WORKSPACE:-${REPO_ROOT}}"
RELEASE_DIR="${PRODUCTION_RELEASES_DIR}/${RELEASE_ID}"

case "${RELEASE_DIR}" in
  "${PRODUCTION_RELEASES_DIR}/"?*) ;;
  *)
    echo "ERROR: refusing to deploy: RELEASE_DIR '${RELEASE_DIR}' is not under '${PRODUCTION_RELEASES_DIR}/'." >&2
    exit 1
    ;;
esac

if [ "${DRY_RUN}" = "true" ]; then
  log "DRY-RUN (deploy) — no changes will be made. Planned actions:"
  log "  0. Deploy tag:              ${TAG}"
  log "  1. Create release dir:      ${RELEASE_DIR}"
  log "  2. Copy workspace from:     ${SOURCE_WORKSPACE}"
  log "     (rsync, excluding .git node_modules dist .hermes)"
  log "  3. Validate compose config: ${PRODUCTION_COMPOSE}"
  log "  4. Build only service:      ${PRODUCTION_SERVICE}"
  log "  5. Replace exact container: ${PRODUCTION_SERVICE} (guarded by /${PRODUCTION_SERVICE})"
  log "  6. Up only service:         ${PRODUCTION_SERVICE}"
  log "  7. Health check:            ${PRODUCTION_HEALTH_URL}"
  log "  8. Repoint current symlink: ${PRODUCTION_CURRENT_LINK} -> ${RELEASE_DIR}"
  log "     (previous target preserved for rollback)"
  log "DRY-RUN complete. Re-run with --dry-run false to apply."
  exit 0
fi

# ---------------------------------------------------------------------------
# Real deploy (production). Bounded to the production release directories.
# ---------------------------------------------------------------------------
log "REAL DEPLOY — production. Release: ${RELEASE_ID} (tag ${TAG})"

# Capture the previous release target (if any) for the rollback hint.
PREVIOUS_TARGET=""
if [ -L "${PRODUCTION_CURRENT_LINK}" ]; then
  PREVIOUS_TARGET="$(readlink -f "${PRODUCTION_CURRENT_LINK}" || true)"
fi

# 1. Create the release directory under the production releases root.
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
RELEASE_COMPOSE="${RELEASE_DIR}/${RELEASE_COMPOSE_RELPATH}"
if [ ! -f "${RELEASE_COMPOSE}" ]; then
  # Fall back to the repo copy if the release layout differs.
  RELEASE_COMPOSE="${PRODUCTION_COMPOSE}"
fi

# 3. Validate the compose configuration before touching containers.
log "Validating compose config: ${RELEASE_COMPOSE}"
docker compose -f "${RELEASE_COMPOSE}" config >/dev/null

# 4. Build ONLY the production service.
log "Building production service: ${PRODUCTION_SERVICE}"
docker compose -f "${RELEASE_COMPOSE}" build "${PRODUCTION_SERVICE}"

# 5. Retire exactly the existing production container (exact-name guarded).
replace_existing_container

# 6. Start ONLY the production service from the new compose project.
log "Starting production service: ${PRODUCTION_SERVICE}"
docker compose -f "${RELEASE_COMPOSE}" up -d "${PRODUCTION_SERVICE}"

# 7. Health check.
if ! health_check; then
  log "ERROR: production health check did not pass at ${PRODUCTION_HEALTH_URL}."
  if [ -n "${PREVIOUS_TARGET}" ]; then
    log "ROLLBACK HINT: previous release was ${PREVIOUS_TARGET}"
    log "  To roll back: ./scripts/deploy-production.sh --mode rollback \\"
    log "    --rollback-release '${PREVIOUS_TARGET}' --confirm DEPLOY_PRODUCTION --dry-run false"
  else
    log "ROLLBACK HINT: no previous 'current' symlink found to roll back to."
  fi
  exit 1
fi

# 8. Repoint the 'current' symlink to this release only after health passes.
log "Repointing ${PRODUCTION_CURRENT_LINK} -> ${RELEASE_DIR}"
ln -sfn "${RELEASE_DIR}" "${PRODUCTION_CURRENT_LINK}"

log "Production deploy complete: ${RELEASE_ID} (tag ${TAG})"
if [ -n "${PREVIOUS_TARGET}" ]; then
  log "ROLLBACK HINT: previous release was ${PREVIOUS_TARGET}"
  log "  To roll back: ./scripts/deploy-production.sh --mode rollback \\"
  log "    --rollback-release '${PREVIOUS_TARGET}' --confirm DEPLOY_PRODUCTION --dry-run false"
else
  log "No previous release symlink existed before this deploy."
fi
