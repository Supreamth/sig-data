# Production Release (manual / tag-triggered / approval-gated)

This document describes the **production** release and rollback process for the
Sigen ECharts dashboard. Production **never auto-deploys**: there is no `push`
and no `pull_request` deploy path. Every production action is manual, requires
an exact confirmation phrase and a semantic version tag, and must be approved
through the GitHub `production` environment.

> **Status:** scaffold only / next gated step. No production self-hosted runner
> and no `production` environment are registered yet, so the workflow will queue
> but not execute. Nothing here has been deployed. See the CI/CD tracker.

## What this covers

| Piece | Path | Purpose |
| --- | --- | --- |
| Workflow | `.github/workflows/release-production.yml` | Manual (`workflow_dispatch`) trigger, input guard, `production` environment, self-hosted production runner. |
| Compose overlay | `deploy/production/docker-compose.production.yml` | Single production service `echarts-dashboard` on `127.0.0.1:3200`. |
| Deploy script | `scripts/deploy-production.sh` | Safe bash helper; dry-run by default; deploy + rollback modes; production release dirs only. |

## Safety boundaries

- **Manual only.** The workflow uses `workflow_dispatch` exclusively for V1.0.
  No `push` to `main` and no `pull_request` trigger can deploy production.
- **Single service.** Production is scoped to `echarts-dashboard` only. No
  collectors, no InfluxDB/Grafana, no staging, and no Cloudflare/tunnel secrets
  are touched.
- **Confirmation required.** Both the workflow guard and the script require the
  literal phrase `DEPLOY_PRODUCTION`.
- **Semantic tag required for deploy.** `release_tag` must match
  `vMAJOR.MINOR.PATCH[-suffix]`. Branch names and raw SHAs are rejected, and the
  guard verifies the tag exists on `origin`.
- **Environment approval.** The deploy job binds to the GitHub `production`
  environment, so a required reviewer must approve every run.
- **Dry-run first.** The script and the workflow input default to `dry_run:
  true`, which prints planned actions and changes nothing.
- **Bounded blast radius.** A real deploy only writes under
  `PRODUCTION_RELEASES_DIR` (default `/opt/sigen-production/releases`) and
  repoints `PRODUCTION_CURRENT_LINK` (default `/opt/sigen-production/current`).
  It builds/ups only the single `echarts-dashboard` service and only ever
  stops/removes a container named exactly `/echarts-dashboard`.
- **No secrets.** Neither the workflow nor the script prints `.env` contents,
  and the script never uses `set -x`. The compose overlay references
  `/root/projects/sig-data/.env` via `env_file` only.

## Tag naming convention

Production deploys an **immutable tag**, not a branch. Use semantic versioning:

```
vMAJOR.MINOR.PATCH          e.g. v1.0.0
vMAJOR.MINOR.PATCH-suffix   e.g. v1.1.0-rc1
```

Create tags only from a protected `main` commit after CI has passed. The deploy
job checks out `refs/tags/<release_tag>`.

## Prerequisites (not yet configured)

1. **Self-hosted runner** registered for `Supreamth/sig-data` with the labels:

   ```
   self-hosted, linux, sigen-production
   ```

   Prefer a **separate** runner service from staging even on the same VPS. Do
   not reuse the `sigen-staging` label. No such runner is registered yet, so the
   deploy job will not start.

2. **GitHub environment** named `production` with a required reviewer
   (`Supreamth`). If Supreamth is the sole reviewer, keep
   `prevent_self_review = false` to avoid lockout.
3. **Docker + Docker Compose v2** available on the runner host.
4. The base stack network `sig-data_default` already exists (created by the root
   `docker-compose.yml`). The production overlay attaches to it as external.
5. Production release directories writable by the runner user:
   - `/opt/sigen-production/releases`
   - `/opt/sigen-production/current` (symlink, managed by the script)
6. A production `.env` present at `/root/projects/sig-data/.env` on the runner.

## Workflow inputs

| Input | Required | Default | Notes |
| --- | --- | --- | --- |
| `release_tag` | yes | `v1.0.0` | Semantic version tag. Used for `deploy`. |
| `confirm` | yes | — | Must be exactly `DEPLOY_PRODUCTION`. |
| `dry_run` | yes | `true` | Keep `true` until you are ready for a real change. |
| `mode` | yes | `deploy` | `deploy` or `rollback`. |
| `rollback_release` | no | — | Required for `rollback`. Absolute dir under `/opt/sigen-production/releases/`. |

## Deploy: dry-run first

1. In GitHub: **Actions → Release Production (manual) → Run workflow**.
2. Fill inputs:
   - `mode`: `deploy`
   - `release_tag`: e.g. `v1.0.0`
   - `confirm`: `DEPLOY_PRODUCTION`
   - `dry_run`: `true`
3. The `guard` job validates the confirmation, mode, tag format, and tag
   existence. The deploy job waits for `production` environment approval.

You can also run the script locally in dry-run:

```bash
./scripts/deploy-production.sh --mode deploy --tag v1.0.0 --confirm DEPLOY_PRODUCTION --dry-run true
```

The dry-run prints the planned actions (create release dir, copy workspace,
validate compose, build/replace/up the service, health check, repoint symlink)
and exits `0` without changing anything.

## Deploy: real deploy second

Only after a clean dry-run and explicit approval, re-run with `dry_run: false`.
The script then:

1. Creates a release dir `${PRODUCTION_RELEASES_DIR}/<release_tag>`.
2. Copies the workspace into it via `rsync`, excluding `.git`, `node_modules`,
   `dist`, and `.hermes`.
3. Validates the production compose config.
4. Builds **only** `echarts-dashboard`.
5. Replaces any pre-existing container named exactly `/echarts-dashboard` (see
   below), then starts the service from the new compose project.
6. Health-checks `http://127.0.0.1:3200/api/health` (retries a few times).
7. Repoints `${PRODUCTION_CURRENT_LINK}` to the new release **only after** the
   health check passes.

If the health check fails, the script exits non-zero and prints a rollback hint
with the previous release target.

> **Exact-name container replacement.** `docker compose up` will not create a
> container whose fixed name is already in use, so the deploy explicitly retires
> the existing production container first. This is bounded: it acts only on the
> single fixed name `echarts-dashboard` — never a pattern or glob — and refuses
> to stop/remove it unless `docker inspect --format '{{.Name}}'` reports its
> name is exactly `/echarts-dashboard`. Any other name aborts the deploy without
> touching the container.

## Rollback

Each deploy is a tag-named release directory, and `current` is a symlink to the
active release. Rolling back repoints the symlink to a previous release and
restarts only the production dashboard from that release's compose file.

Via the workflow:

- `mode`: `rollback`
- `rollback_release`: e.g. `/opt/sigen-production/releases/v0.9.0`
- `confirm`: `DEPLOY_PRODUCTION`
- `dry_run`: `true` first, then `false`

Equivalent local command:

```bash
./scripts/deploy-production.sh --mode rollback \
  --rollback-release /opt/sigen-production/releases/v0.9.0 \
  --confirm DEPLOY_PRODUCTION --dry-run false
```

Rollback validates that `--rollback-release` is an existing absolute child
directory under `/opt/sigen-production/releases/` (rejecting `..` and paths
outside the root), validates the compose config in that release, repoints
`current`, restarts only `echarts-dashboard`, and health-checks
`http://127.0.0.1:3200/api/health`.

## Health checks

- Local (runner): `http://127.0.0.1:3200/api/health`
- Public production: `https://sigen.sprees.net/api/health`
- Public staging (unchanged by production actions): `https://sigen-staging.sprees.net/api/health`

## Secret handling

The `.env` file at `/root/projects/sig-data/.env` is provided to the container
via `env_file` only. It is never printed by the workflow or the script, and the
script never enables `set -x`.

## Topology reference (production)

```
Cloudflare -> reverse proxy -> 127.0.0.1:3200 -> container echarts-dashboard
  image:     sig-data-echarts-dashboard-production:latest
  build:     ./echarts-dashboard
  network:   sig-data_default (external)
  runner:    self-hosted, linux, sigen-production
  env:       /root/projects/sig-data/.env (never printed)
```

## Activation sequence (post-merge, separately approved)

This scaffold does not deploy. Production activation is a distinct, separately
approved step:

1. Create/update the GitHub `production` environment and required reviewer.
2. Register the `sigen-production` self-hosted runner (separate from staging).
3. Trigger a **dry-run** deploy (`dry_run: true`) and confirm nothing changed.
4. Only after dry-run evidence and explicit approval, trigger a **real** deploy
   (`dry_run: false`) and approve the `production` environment gate.
5. Verify run success, local + public production health (HTTP 200), unchanged
   staging health, the container/image changed, and `current` points to the
   deployed release. Update the tracker.
