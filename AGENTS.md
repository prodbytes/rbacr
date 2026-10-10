# Agent instructions

## Repository layout

The repository holds components, each in its own folder; work from that
folder (paths below are relative to the repository root):

- [rbacr-sls/](rbacr-sls/) — the rbacr service (SvelteKit on AWS Lambda).
  Run its commands (`npm`, `devbox`, `scripts/…`) from `rbacr-sls/`.
- [rbacr-flutter/](rbacr-flutter/) — the Dart client (package `rbacr`) for
  Flutter apps. Before committing it: `dart analyze --fatal-infos`,
  `dart format --line-length 120 --set-exit-if-changed lib test example`,
  `dart test`, and its e2e tests (`dart test -t e2e`, see its README)
  against `devbox services up`. Keep it in step with rbacr-sls's `/api`.
- [rbacr-lib/](rbacr-lib/) — the client library that caches role grants;
  only a README until it is specified.

The GitHub workflows (`.github/`), the dev container (`.devcontainer/`,
`.dockerignore`) and this file stay at the root.

## Before committing and pushing

Review all new and modified code for **correctness** and **security** before
every commit and push:

- **Correctness**: verify the change does what it claims — run the relevant
  code path (build, script, or service), not just a syntax check. For
  rbacr-sls that means `npm run check` and `npm test` pass, `npm run test:e2e`
  passes against `devbox services up` (database, app, Floci and health check
  start cleanly), and the devcontainer image still builds when its inputs
  change.
- **Security**: check for hardcoded secrets or tokens, unsafe shell patterns
  (unquoted variables, `curl | bash` of unpinned sources, world-writable
  files), injection risks, and unnecessarily broad permissions or exposed
  ports. Never commit credentials, even placeholders that look real.

Do not commit or push code that has not passed both checks.

## Keep docs and tests in sync

Every behaviour change must update, in the same commit:

- [SPEC.md](rbacr-sls/SPEC.md) — the source of truth for rules, permissions and the API;
- the tests (`src/**/*.spec.ts`, [tests/](rbacr-sls/tests/)) covering the changed rules;
- [README.md](rbacr-sls/README.md) (and the root [README.md](README.md))
  when setup, configuration or usage changes.

## Project notes (rbacr-sls)

- SvelteKit 3 app (config lives in [vite.config.ts](rbacr-sls/vite.config.ts); env vars
  are declared in [src/env.ts](rbacr-sls/src/env.ts) and must be prefixed `RBACR_`).
  Authorization rules live only in
  [src/lib/server/rbac.ts](rbacr-sls/src/lib/server/rbac.ts); routes stay thin.
- Two APIs (SPEC.md "Two APIs"): `/api` is the external API (personal API
  tokens, checked for every `/api` path in src/hooks.server.ts, then `api()`
  in src/lib/server/http.ts); `/vpi`, the VPI (view programming interface),
  is the frontend's only backend
  (session cookie via `vpi()`, guarded by src/lib/server/vpiguard.ts). Pages use
  universal `+page.ts` loads and `src/lib/vpi.ts`; don't add `+page.server.ts`
  loads or form actions, which would bypass that split.
- Deployed to AWS (Lambda + CloudFront, CloudFormation in [infra/](rbacr-sls/infra/))
  by [scripts/deploy.sh](rbacr-sls/scripts/deploy.sh), from the tag workflows in
  [.github/workflows/](.github/workflows/). Release with
  `scripts/release-rc.sh` / `scripts/release-ga.sh`; never push tags by hand.
- Infra changes: run `cfn-lint infra/*.yaml` and
  `aws cloudformation validate-template`; workflow and script changes:
  `actionlint` and `shellcheck` (both run fine via Docker).
- Local HTTPS: [floci/](rbacr-sls/floci/) plays CloudFront on ports 4567/8444
  (presence's Floci uses 4566/8443).
- Toolchain is managed by [devbox.json](rbacr-sls/devbox.json); enter it with
  `devbox shell` and keep [devbox.lock](rbacr-sls/devbox.lock) committed.
- `devbox services up` starts DynamoDB Local as the `devbox-dynamodb` Docker container
  ([compose.yaml](rbacr-sls/compose.yaml)) plus the health monitor
  ([scripts/health-check.sh](rbacr-sls/scripts/health-check.sh)); stop with
  `devbox services stop`. In non-interactive contexts pass
  `--pcflags "--tui=false"`.
- The devcontainer build is documented in the root [README](README.md).
