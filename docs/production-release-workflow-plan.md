# Production Release Workflow Implementation Plan

> Public planning artifact for the Sigen CI/CD tracker. Implementation still requires a separate approval before any production deploy.

**Goal:** Add a production release workflow for `Supreamth/sig-data` that is manual/tag-triggered only, protected by GitHub production environment approval, deploys with health checks, and supports rollback.

**Architecture:** Keep production release separate from CI and staging. A release tag such as `v1.0.0` identifies the immutable source to deploy; GitHub Actions validates the tag and confirmation phrase, then a self-hosted production runner executes a bounded deploy script for the production ECharts dashboard service. Rollback is a separate manual workflow path that repoints `/opt/sigen-production/current` to a known previous release and restarts only the production dashboard service.

**Tech Stack:** GitHub Actions, GitHub Environments, self-hosted GitHub runner, Docker Compose v2, Bash, Docker, existing `echarts-dashboard` service on `127.0.0.1:3200`, health endpoint `/api/health`.

---

## Current verified baseline

Verified on 2026-07-11T14:58:06+00:00:

- Canonical repo: `Supreamth/sig-data`.
- Local branch: `main`, clean except intentionally untracked `ev-solar-flow/`.
- Latest relevant commits:
  - `c20241c docs: record successful staging deployment (#4)`
  - `5f1afaf fix: replace legacy staging container during deploy (#3)`
  - `6a5fe0c ci: add manual staging deployment workflow (#2)`
  - `bb5d77e chore: make Supreamth repo canonical for Sigen CI/CD (#1)`
- Main CI latest run succeeded: `https://github.com/Supreamth/sig-data/actions/runs/29156891259`.
- Staging dry-run succeeded: `https://github.com/Supreamth/sig-data/actions/runs/29156271497`.
- First real staging deploy succeeded: `https://github.com/Supreamth/sig-data/actions/runs/29156791754`.
- Public tracker is live and already records staging deployed: `https://cicd.sprees.net/ci-cd-tracker.html`.
- Health checks:
  - production: `https://sigen.sprees.net/api/health` => HTTP 200
  - staging: `https://sigen-staging.sprees.net/api/health` => HTTP 200
- Existing production dashboard topology in `docker-compose.yml`:
  - service: `echarts-dashboard`
  - container: `echarts-dashboard`
  - port: `127.0.0.1:3200:3200`
  - env file: `.env`
  - network: base compose default network
- Existing staging deployment files to mirror structurally:
  - `.github/workflows/deploy-staging.yml`
  - `scripts/deploy-staging.sh`
  - `deploy/staging/docker-compose.staging.yml`
  - `docs/staging-deployment.md`

## Non-negotiable safety constraints

- No production deploy on `push` to `main`.
- No production deploy from pull requests.
- Production deploy must require:
  - explicit release tag input or tag event,
  - exact confirmation phrase,
  - GitHub `production` environment approval,
  - self-hosted runner with a production-specific label,
  - health check after deploy.
- Production rollback must be manual, approval-gated, and explicit.
- Do not print secrets or `.env` contents.
- Do not touch collectors, InfluxDB, Grafana, or staging in the first production release workflow. Scope the first workflow to `echarts-dashboard` only.
- Keep implementation as a PR. Do not run a real production deploy until the user separately approves it after dry-run evidence.

## Proposed files

- Create: `.github/workflows/release-production.yml`
- Create: `deploy/production/docker-compose.production.yml`
- Create: `scripts/deploy-production.sh`
- Create: `docs/production-release.md`
- Modify: `docs/ci-cd-tracker.html`

## Production environment / runner design

- GitHub Environment: `production`
  - Required reviewer: `Supreamth`
  - `prevent_self_review: false` only if Supreamth is the sole admin/reviewer, to avoid lockout.
  - Deployment branches/tags: restrict through workflow guard, because GitHub environment branch policy is branch-oriented.
- Runner label: `[self-hosted, linux, sigen-production]`
  - Prefer a separate runner service from staging even if installed on the same VPS.
  - Name example: `sigen-production-srv1698440`.
  - Do not reuse the `sigen-staging` label for production.

## Workflow design

Use `workflow_dispatch` as the primary trigger:

Inputs:

- `release_tag` required, example `v1.0.0`
- `confirm` required, exact phrase `DEPLOY_PRODUCTION`
- `dry_run` required, default `true`, options `true|false`
- `mode` required, default `deploy`, options `deploy|rollback`
- `rollback_release` optional, required only when `mode=rollback`

Optional later extension:

- Add `on.push.tags: ['v*']` only after manual dispatch is proven. Even then, the job must still wait for `production` environment approval and should default to dry-run or require a separate manual dispatch for real deploy. For V1.0, prefer manual `workflow_dispatch` with a tag input.

Workflow jobs:

1. `guard`
   - runs on `ubuntu-latest`
   - permissions: `contents: read`
   - checks `confirm == DEPLOY_PRODUCTION`
   - checks `release_tag` matches `^v[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9._-]+)?$`
   - verifies tag exists via `git ls-remote --tags origin refs/tags/${release_tag}`
   - rejects branch names and raw SHAs for production deploy.

2. `deploy-production`
   - needs `guard`
   - runs on `[self-hosted, linux, sigen-production]`
   - environment: `production`
   - concurrency group: `deploy-production`
   - checkout ref: `refs/tags/${release_tag}` for deploy mode
   - invokes:
     - `./scripts/deploy-production.sh --mode deploy --tag "$release_tag" --confirm DEPLOY_PRODUCTION --dry-run "$dry_run"`
     - or rollback mode with `--mode rollback --rollback-release "$rollback_release"`

## Production compose design

Create `deploy/production/docker-compose.production.yml` with only one service for the first production release workflow:

- service: `echarts-dashboard`
- image: `sig-data-echarts-dashboard-production:latest`
- container_name: `echarts-dashboard`
- build context: `../../echarts-dashboard`
- env_file: `/root/projects/sig-data/.env`
- environment:
  - `INFLUXDB_URL: http://influxdb:8086`
  - preserve dashboard/Telegram env defaults from root `docker-compose.yml`
- ports:
  - `127.0.0.1:3200:3200`
- networks:
  - external `sig-data_default`

Do not include:

- InfluxDB
- Grafana
- collectors
- staging services
- Cloudflare/tunnel secrets

## Deploy script design

Create `scripts/deploy-production.sh` modeled after staging but with stricter production guards.

Defaults:

- `PRODUCTION_RELEASES_DIR=/opt/sigen-production/releases`
- `PRODUCTION_CURRENT_LINK=/opt/sigen-production/current`
- `PRODUCTION_COMPOSE=<repo>/deploy/production/docker-compose.production.yml`
- `PRODUCTION_SERVICE=echarts-dashboard`
- `PRODUCTION_HEALTH_URL=http://127.0.0.1:3200/api/health`

Required args:

- `--confirm DEPLOY_PRODUCTION`
- `--dry-run true|false`
- `--mode deploy|rollback`
- `--tag vX.Y.Z` for deploy
- `--rollback-release /opt/sigen-production/releases/<sha-or-tag>` for rollback

Deploy mode real actions:

1. Validate args and paths.
2. Refuse unsafe release IDs containing `/`, `..`, empty string, or non-tag deploys.
3. Capture previous symlink target if present.
4. Create release dir under `/opt/sigen-production/releases/<tag-or-sha>`.
5. Copy workspace to release dir excluding `.git`, `node_modules`, `dist`, `.hermes`.
6. Validate production compose config.
7. Build only `echarts-dashboard`.
8. Adopt/replace exactly the production container name `echarts-dashboard` only after exact-name guard:
   - `docker inspect --format '{{.Name}}' echarts-dashboard` must equal `/echarts-dashboard`.
   - Stop/remove only this literal name.
   - No patterns or broad filters.
9. `docker compose -f <release-compose> up -d echarts-dashboard`.
10. Health-check `http://127.0.0.1:3200/api/health` with retries.
11. Repoint `/opt/sigen-production/current` to release dir only after health passes.
12. Print rollback hint with previous target.

Rollback mode real actions:

1. Validate `--rollback-release` is an existing absolute child directory under `/opt/sigen-production/releases/`.
2. Validate compose config inside rollback release.
3. Repoint `/opt/sigen-production/current` to rollback release.
4. Rebuild/up only `echarts-dashboard` from rollback release compose.
5. Health-check `http://127.0.0.1:3200/api/health`.
6. Print previous target and active target.

Dry-run mode:

- Print all planned paths/actions.
- Do not create release dirs.
- Do not stop/remove containers.
- Do not run `docker compose up`.
- Do not repoint symlinks.

## Task-by-task implementation plan

### Task 1: Create production branch

**Objective:** Start an isolated PR branch.

**Files:** none yet.

**Commands:**

```bash
cd /root/projects/sig-data
git fetch origin --prune
git switch main
git reset --hard origin/main
git switch -c cd/production-manual-release
```

**Verify:**

```bash
git status --short --branch
```

Expected: branch `cd/production-manual-release`, only existing untracked `ev-solar-flow/`.

### Task 2: Add production compose overlay

**Objective:** Create a production-only compose file for the ECharts dashboard.

**Files:**

- Create: `deploy/production/docker-compose.production.yml`

**Implementation notes:**

- Mirror root `docker-compose.yml` service `echarts-dashboard` only.
- Use external network `sig-data_default`.
- Use loopback port `127.0.0.1:3200:3200`.
- Use `/root/projects/sig-data/.env` as env file.
- Do not include staging or collectors.

**Verify:**

```bash
docker compose -f deploy/production/docker-compose.production.yml config >/tmp/production-compose-config.out
test -s /tmp/production-compose-config.out
```

Expected: exit 0, no secrets printed.

### Task 3: Add production deploy script with dry-run first

**Objective:** Add a guarded script that can dry-run, deploy, and rollback production.

**Files:**

- Create: `scripts/deploy-production.sh`

**Implementation notes:**

- Copy the proven structure from `scripts/deploy-staging.sh`.
- Replace confirmation phrase with `DEPLOY_PRODUCTION`.
- Replace paths with `/opt/sigen-production/...`.
- Replace service with `echarts-dashboard`.
- Replace health URL with `http://127.0.0.1:3200/api/health`.
- Add `--mode deploy|rollback`.
- Add strict rollback release validation.
- Keep exact-name container adoption guard for `/echarts-dashboard`.

**Verify:**

```bash
bash -n scripts/deploy-production.sh
./scripts/deploy-production.sh --mode deploy --tag v1.0.0 --confirm DEPLOY_PRODUCTION --dry-run true
! ./scripts/deploy-production.sh --mode deploy --tag v1.0.0 --confirm WRONG --dry-run true
! ./scripts/deploy-production.sh --mode deploy --tag main --confirm DEPLOY_PRODUCTION --dry-run true
```

Expected: syntax OK, dry-run OK, bad confirmation rejected, non-tag rejected.

### Task 4: Add production GitHub Actions workflow

**Objective:** Add a manual/tag-gated production release workflow that never runs on PR/main push.

**Files:**

- Create: `.github/workflows/release-production.yml`

**Implementation notes:**

- Use `workflow_dispatch` only for V1.0.
- Inputs: `release_tag`, `confirm`, `dry_run`, `mode`, `rollback_release`.
- Permissions: `contents: read`.
- Concurrency: `deploy-production`, `cancel-in-progress: false`.
- Guard job validates confirmation and tag format/existence.
- Deploy job uses `environment: production` and runner labels `[self-hosted, linux, sigen-production]`.

**Verify locally:**

```bash
git diff --check
```

Expected: exit 0.

### Task 5: Add production release runbook

**Objective:** Document dry-run, real deploy, environment approval, and rollback.

**Files:**

- Create: `docs/production-release.md`

**Must include:**

- No production auto-deploy from main or PRs.
- Tag naming convention: `vMAJOR.MINOR.PATCH`.
- Manual workflow inputs.
- Required GitHub `production` approval.
- Dry-run first.
- Real deploy after explicit approval.
- Rollback workflow mode and command equivalent.
- Health checks.
- Secret handling.
- Runner labels and service expectations.

### Task 6: Update tracker for planned production workflow

**Objective:** Keep the public tracker current.

**Files:**

- Modify: `docs/ci-cd-tracker.html`

**Update:**

- Confirm staging is deployed.
- Add production release workflow status: `planned / next PR`.
- Link to `docs/production-release.md` once created.
- State clearly: manual/tag-triggered, GitHub `production` environment approval, rollback, no push-to-main deploy.

### Task 7: Validate full PR safely

**Objective:** Prove the PR is safe and non-deploying.

**Commands:**

```bash
bash -n scripts/deploy-production.sh
./scripts/deploy-production.sh --mode deploy --tag v1.0.0 --confirm DEPLOY_PRODUCTION --dry-run true
./scripts/deploy-production.sh --mode rollback --rollback-release /opt/sigen-production/releases/example --confirm DEPLOY_PRODUCTION --dry-run true || true
docker compose -f deploy/production/docker-compose.production.yml config >/tmp/production-compose-config.out
node --check echarts-dashboard/server.js
node --check echarts-dashboard/public/app.js
python3 -m py_compile *.py
git diff --check
```

Expected:

- Syntax checks pass.
- Compose config passes.
- Dry-run does not create `/opt/sigen-production`.
- No container restart.
- Production/staging health remain HTTP 200.

### Task 8: Open PR, wait for CI, merge only after review

**Objective:** Land production workflow scaffold without deploying production.

**Commands:**

```bash
git add .github/workflows/release-production.yml deploy/production/docker-compose.production.yml scripts/deploy-production.sh docs/production-release.md docs/ci-cd-tracker.html
git commit -m "ci: add manual production release workflow"
git push -u origin cd/production-manual-release
gh pr create --repo Supreamth/sig-data --base main --head cd/production-manual-release --title "ci: add manual production release workflow" --body-file /tmp/production-release-pr.md
gh pr checks <PR_NUMBER> --repo Supreamth/sig-data --watch
```

Expected:

- CI passes.
- PR contains no production deployment run.
- Merge only after user approval.

### Task 9: Post-merge activation as a separate approval gate

**Objective:** Configure runtime pieces only after the scaffold is merged.

Separate approval phrase should be required, for example:

`Approve production environment and runner setup only`

Actions after approval:

1. Create/update GitHub `production` environment.
2. Add required reviewer `Supreamth`.
3. Register runner with label `sigen-production`.
4. Trigger dry-run only:
   - mode: `deploy`
   - release_tag: selected tag, e.g. `v1.0.0`
   - confirm: `DEPLOY_PRODUCTION`
   - dry_run: `true`
5. Verify dry-run changed nothing.

### Task 10: Real production deployment as final explicit approval gate

**Objective:** Deploy production only after dry-run evidence and user approval.

Separate approval phrase should be required, for example:

`Approve real production deploy <tag> dry_run false`

Actions after approval:

1. Trigger workflow with:
   - mode: `deploy`
   - release_tag: `<tag>`
   - confirm: `DEPLOY_PRODUCTION`
   - dry_run: `false`
2. Approve GitHub `production` environment deployment.
3. Watch run to completion.
4. Verify:
   - run success URL
   - production local health HTTP 200
   - production public health HTTP 200
   - staging public health HTTP 200
   - container ID/image changed as expected
   - `/opt/sigen-production/current` points to the deployed release
5. Update tracker.

## Risk register

| Risk | Mitigation |
| --- | --- |
| Accidental production deploy from normal development | No `push`/`pull_request` deploy trigger; manual `workflow_dispatch` only for V1.0. |
| Wrong ref deployed | Require semantic version tag input and verify tag exists. Reject branches/raw SHAs. |
| Production secrets printed | Never print `.env`; pass via env_file only. Avoid `set -x`. |
| Broad container removal | Stop/remove only literal `echarts-dashboard` after exact `docker inspect` name guard. |
| Production environment lockout | If Supreamth is sole reviewer, use `prevent_self_review=false` initially; tighten later if more reviewers exist. |
| Bad release causes outage | Health check after deploy; previous release symlink captured; rollback mode available. |
| Same runner can touch staging and production | Use a separate production runner label and preferably separate runner service. |
| Tag exists on unreviewed commit | Require branch protection/CI before tagging; document tag creation only from protected `main` after CI success. |

## Acceptance criteria

The production workflow plan is implemented successfully when:

- PR adds production workflow/docs/scripts only; no real deploy occurs during PR.
- Workflow has no `push` to `main` deploy path and no PR deploy path.
- Workflow requires `DEPLOY_PRODUCTION` and a semantic release tag.
- Workflow uses GitHub `production` environment.
- Workflow targets `[self-hosted, linux, sigen-production]`.
- Dry-run proves no runtime mutation.
- Real deploy remains blocked pending a distinct user approval phrase.
- Rollback mode is documented and dry-run-testable.
- Tracker is updated with production workflow status.
