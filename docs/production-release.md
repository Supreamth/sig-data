# Production Release (manual / tag-triggered / approval-gated)

This document describes the **production** release and rollback process for the
Sigen ECharts dashboard. Production **never auto-deploys**: there is no `push`
and no `pull_request` deploy path. Every production action is manual, requires
an exact confirmation phrase and a semantic version tag, and must be approved
through the GitHub `production` environment.

> **Status:** live and proven. The `production` environment and separate
> `sigen-production` self-hosted runner are configured. Release `v1.0.0` was
> first proven by dry-run run
> [`29158829022`](https://github.com/Supreamth/sig-data/actions/runs/29158829022),
> then deployed for real in run
> [`29159055177`](https://github.com/Supreamth/sig-data/actions/runs/29159055177).
> `/opt/sigen-production/current` now points to
> `/opt/sigen-production/releases/v1.0.0`.

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

## Prerequisites (configured for V1.0)

1. **Self-hosted runner** registered for `Supreamth/sig-data` with the labels:

   ```
   self-hosted, linux, sigen-production
   ```

   The V1.0 production runner is registered separately from staging as
   `sigen-production-srv1698440`; do not reuse the `sigen-staging` label.

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

Current V1.0 caveat: this was the first managed production deploy. There was no
previous managed production release symlink before `v1.0.0`, and the managed
release root currently contains only `/opt/sigen-production/releases/v1.0.0`.
Rollback to an older managed release becomes available after a future release
creates another release directory. Until then, emergency recovery means either
re-running the known-good `v1.0.0` deploy or manually restoring the pre-managed
legacy container/state from server backups or the preserved legacy runtime
configuration.

### Rollback readiness checklist

Use this checklist before any future production release and during incident
triage. It is read-only except where the final emergency action explicitly says
otherwise.

1. Confirm the active managed release:

   ```bash
   readlink -f /opt/sigen-production/current
   find /opt/sigen-production/releases -maxdepth 1 -mindepth 1 -type d -printf '%p\n' | sort
   ```

   Expected immediately after V1.0: `current` points to
   `/opt/sigen-production/releases/v1.0.0`, and `v1.0.0` is the only managed
   release directory.

2. Confirm production container identity and start time:

   ```bash
   docker inspect --format '{{.Id}} {{.Name}} {{.Config.Image}} {{.State.Status}} {{.State.StartedAt}}' echarts-dashboard
   ```

   Expected immediately after V1.0: a running `/echarts-dashboard` container using
   image `sig-data-echarts-dashboard-production:latest`.

3. Confirm production and staging health:

   ```bash
   curl -sS -o /tmp/sigen-production-health.json -w 'production=%{http_code}\n' https://sigen.sprees.net/api/health
   curl -sS -o /tmp/sigen-staging-health.json -w 'staging=%{http_code}\n' https://sigen-staging.sprees.net/api/health
   ```

   Both should return HTTP 200. Staging is checked because production release and
   rollback actions must not affect the staging container.

4. Confirm whether a managed rollback target exists:

   ```bash
   find /opt/sigen-production/releases -maxdepth 1 -mindepth 1 -type d ! -name v1.0.0 -printf '%p\n' | sort
   ```

   If this prints nothing, there is no older managed release to roll back to.
   Do not dispatch workflow rollback with an invented path.

5. If a future managed release exists, dry-run rollback first:

   ```bash
   ./scripts/deploy-production.sh --mode rollback \
     --rollback-release /opt/sigen-production/releases/<previous-release> \
     --confirm DEPLOY_PRODUCTION --dry-run true
   ```

6. If V1.0 remains the only managed release and production is unhealthy, the safe
   emergency choices are:

   - re-run the known-good `v1.0.0` deploy through the protected production
     workflow, starting with `dry_run: true`; or
   - manually restore the pre-managed legacy container/state from backups or
     preserved server runtime configuration.

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

## V1.0 execution record

1. Production scaffold merged via PR #6.
2. Workflow scheduling fix merged via PR #8.
3. Production environment + runner routing was proved by rollback dry-run run
   `29158346834`.
4. Release tag `v1.0.0` points to commit `2770f039`.
5. Tagged deploy dry-run succeeded in run `29158829022` and changed nothing.
6. First real production deploy succeeded in run `29159055177`:
   - checked out `refs/tags/v1.0.0`
   - created `/opt/sigen-production/releases/v1.0.0`
   - built only `echarts-dashboard`
   - replaced only the exact `/echarts-dashboard` container
   - passed local health at `http://127.0.0.1:3200/api/health`
   - repointed `/opt/sigen-production/current` to the `v1.0.0` release
7. Post-deploy checks confirmed production public health HTTP 200, staging public
   health HTTP 200, and the staging container unchanged.

## V1.0.1 lifecycle status

The v1.0.1 second-release lifecycle test is in progress and documented in
[`docs/v1.0.1-lifecycle-test-plan.md`](v1.0.1-lifecycle-test-plan.md).

Completed gates:

1. Gate 1 PR + CI: a tiny non-functional `v1.0.1 candidate` dashboard topbar
   marker was merged in PR #17.
2. Gate 2 staging-first validation: staging dry-run succeeded in run
   `29177098120`; real staging deploy succeeded in run `29177451424`.
3. Gate 3 tag: annotated tag `v1.0.1` was created from green `main` commit
   `0aecf17a5af594d29515efe29b4f52d2f5df2e47`.
4. Gate 4 production deploy dry-run: run `29178241782` succeeded with
   `dry_run=true`, checked out `refs/tags/v1.0.1`, ran on
   `sigen-production-srv1698440`, planned `/opt/sigen-production/releases/v1.0.1`,
   and completed without runtime mutation.

Current production state after the dry-run: `/opt/sigen-production/current` still
points to `/opt/sigen-production/releases/v1.0.0`, only `v1.0.0` exists under the
production managed release root, and production/staging public health remained
HTTP 200.

Next gate: real production deploy for `v1.0.1` with `dry_run=false`, only after
explicit approval. Rollback dry-run to `/opt/sigen-production/releases/v1.0.0`
comes only after `v1.0.1` is live and a second managed production release exists.

## Energy Cockpit V2 pre-release verification

The Energy Cockpit V2 revamp branch includes a read-only verification helper:

```bash
bash scripts/verify-energy-cockpit-v2.sh
```

By default it targets `http://localhost:3200`. To verify an isolated rebuilt test
container without touching production, override the base URL:

```bash
SIGEN_COCKPIT_BASE_URL=http://localhost:3321 \
  bash scripts/verify-energy-cockpit-v2.sh
```

The script performs only read-only checks. It does not rebuild, restart, stop, or
replace containers, and it does not switch the V1 root. It verifies:

- `node --check` for `echarts-dashboard/server.js`, `public/app.js`, and
  `public/app-v2.js`.
- `docker compose --profile stack config` renders a non-empty config.
- `/api/health`, `/api/cockpit`, `/api/weather-vs-actual`, and
  `/api/history?range=24h` respond with valid JSON.
- `/api/cockpit` reports `status: "ok"`.
- `/index-v2.html` is served and contains `Energy Cockpit`.

The successful final line is:

```text
Energy Cockpit V2 verification OK
```

Task 11 was proven against the isolated `http://localhost:3321` V2 test
container. Production `http://localhost:3200` was not rebuilt or restarted.
Before any root switch or production release, run this script against the actual
rebuilt staging/production-like service and browser-check `/index-v2.html` for
layout and console errors.
