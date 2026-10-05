# Agent instructions

## Before committing and pushing

Review all new and modified code for **correctness** and **security** before
every commit and push:

- **Correctness**: verify the change does what it claims — run the relevant
  code path (build, script, or service), not just a syntax check. For this
  repo that means `npm run check` and `npm test` pass, `npm run test:e2e`
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

- [SPEC.md](SPEC.md) — the source of truth for rules, permissions and the API;
- the tests (`src/**/*.spec.ts`, [tests/](tests/)) covering the changed rules;
- [README.md](README.md) when setup, configuration or usage changes.

## Project notes

- SvelteKit 3 app (config lives in [vite.config.ts](vite.config.ts); env vars
  are declared in [src/env.ts](src/env.ts) and must be prefixed `RBACR_`).
  Authorization rules live only in
  [src/lib/server/rbac.ts](src/lib/server/rbac.ts); routes stay thin.
- Two APIs (SPEC.md "Two APIs"): `/api` is the external API (personal API
  tokens, checked for every `/api` path in src/hooks.server.ts, then `api()`
  in src/lib/server/http.ts); `/vpi`, the VPI (view programming interface),
  is the frontend's only backend
  (session cookie via `vpi()`, guarded by src/lib/server/vpiguard.ts). Pages use
  universal `+page.ts` loads and `src/lib/vpi.ts`; don't add `+page.server.ts`
  loads or form actions, which would bypass that split.
- Deployed to AWS (Lambda + CloudFront, CloudFormation in [infra/](infra/))
  by [scripts/deploy.sh](scripts/deploy.sh), from the tag workflows in
  [.github/workflows/](.github/workflows/). Release with
  `scripts/release-rc.sh` / `scripts/release-ga.sh`; never push tags by hand.
- Infra changes: run `cfn-lint infra/*.yaml` and
  `aws cloudformation validate-template`; workflow and script changes:
  `actionlint` and `shellcheck` (both run fine via Docker).
- Local HTTPS: [floci/](floci/) plays CloudFront on ports 4567/8444
  (presence's Floci uses 4566/8443).
- Toolchain is managed by [devbox.json](devbox.json); enter it with
  `devbox shell` and keep [devbox.lock](devbox.lock) committed.
- `devbox services up` starts PostgreSQL as the `devbox-db` Docker container
  ([compose.yaml](compose.yaml)) plus the health monitor
  ([scripts/health-check.sh](scripts/health-check.sh)); stop with
  `devbox services stop`. In non-interactive contexts pass
  `--pcflags "--tui=false"`.
- The devcontainer build is documented in the [README](README.md).
