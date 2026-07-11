# Staging Deployment (manual / controlled)

This document describes the **staging-only**, manually triggered deployment for
the Sigen ECharts dashboard. There is intentionally **no production path** in
this scaffold and **nothing auto-deploys**.

> **Status:** scaffold only. No self-hosted runner is registered yet, so the
> GitHub workflow will queue but not execute. Nothing here has been deployed.

## What this covers

| Piece | Path | Purpose |
| --- | --- | --- |
| Workflow | `.github/workflows/deploy-staging.yml` | Manual (`workflow_dispatch`) trigger, confirmation guard, staging environment. |
| Compose overlay | `deploy/staging/docker-compose.staging.yml` | Single staging service `echarts-dashboard-staging` on `127.0.0.1:3400`. |
| Deploy script | `scripts/deploy-staging.sh` | Safe bash helper; dry-run by default; staging release dirs only. |

## Safety boundaries

- **Manual only.** The workflow uses `workflow_dispatch` exclusively. No `push`
  or `pull_request` trigger can deploy.
- **Staging only.** No production hostname, no production container names, and
  no production deploy job exist anywhere in this scaffold.
- **Confirmation required.** Both the workflow guard and the script require the
  literal phrase `DEPLOY_STAGING`.
- **Dry-run first.** The script and the workflow input default to `dry_run:
  true`, which prints planned actions and changes nothing.
- **Bounded blast radius.** A real deploy only writes under
  `STAGING_RELEASES_DIR` (default `/opt/sigen-staging/releases`) and repoints
  `STAGING_CURRENT_LINK` (default `/opt/sigen-staging/current`). It builds/ups
  only the single `echarts-dashboard-staging` service.
- **No secrets.** Neither the workflow nor the script prints `.env` contents.
  The compose overlay references `/root/projects/sig-data/.env` via `env_file`
  only.

## Prerequisites

1. **Self-hosted runner** registered for `Supreamth/sig-data` with the labels:

   ```
   self-hosted, linux, sigen-staging
   ```

   > No runner with these labels is currently registered, so the deploy job
   > will not start until one is installed.

2. **GitHub environment** named `staging` (add reviewers/protection as desired).
3. **Docker + Docker Compose v2** available on the runner host.
4. The base stack network `sig-data_default` already exists (created by the
   root `docker-compose.yml`). The staging overlay attaches to it as external.
5. Staging release directories writable by the runner user:
   - `/opt/sigen-staging/releases`
   - `/opt/sigen-staging/current` (symlink, managed by the script)
6. A staging `.env` present at `/root/projects/sig-data/.env` on the runner host.

## Manual trigger steps

1. In GitHub: **Actions → Deploy Staging (manual) → Run workflow**.
2. Fill inputs:
   - `confirm`: must be exactly `DEPLOY_STAGING`.
   - `dry_run`: leave `true` for the first run.
   - `ref`: commit / branch / tag to deploy (defaults to the current branch, or `main`).
3. The `guard` job validates the confirmation phrase. If it is not exactly
   `DEPLOY_STAGING`, the run fails before any deploy job starts.

### Dry-run first

Run once with `dry_run: true`. The deploy script prints the planned actions
(create release dir, copy workspace, validate compose, build/up the staging
service, health check, repoint symlink) and exits `0` without changing anything.

You can also run the script locally in dry-run:

```bash
./scripts/deploy-staging.sh --confirm DEPLOY_STAGING --dry-run true
```

### Real deploy second

Only after a clean dry-run, re-run with `dry_run: false`. The script then:

1. Creates a release dir `${STAGING_RELEASES_DIR}/${GITHUB_SHA}`.
2. Copies the workspace into it via `rsync`, excluding `.git`, `node_modules`,
   `dist`, and `.hermes`.
3. Validates the staging compose config.
4. Builds and starts **only** `echarts-dashboard-staging`.
5. Health-checks `http://127.0.0.1:3400/api/health` (retries a few times).
6. Repoints `${STAGING_CURRENT_LINK}` to the new release.

If the health check fails, the script exits non-zero and prints a rollback hint.

## Rollback concept

Each deploy is a timestamped/SHA release directory, and `current` is a symlink
to the active release. Rolling back means repointing the symlink to the previous
release and rebuilding/upping the staging service from that release's compose
file:

```bash
ln -sfn "<previous-release-dir>" /opt/sigen-staging/current
docker compose -f /opt/sigen-staging/current/deploy/staging/docker-compose.staging.yml \
  up -d echarts-dashboard-staging
```

The deploy script prints the exact previous target as a rollback hint on both
success and health-check failure.

## Topology reference (staging)

```
Cloudflare -> reverse proxy -> 127.0.0.1:3400 -> container echarts-dashboard-staging
  image:     sig-data-echarts-dashboard-staging:latest
  build:     ./echarts-dashboard
  network:   sig-data_default (external)
  telegram:  disabled on staging
```
