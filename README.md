# rbacr

A role manager for your applications. Users sign in with Google. rbacr records
which roles each identity (e-mail address or whole domain) holds in each
system, and serves them both as web pages and as JSON. It runs as a SvelteKit
app on AWS Lambda.

[![Open in GitHub Codespaces](https://github.com/codespaces/badge.svg)](https://codespaces.new/prodbytes/rbacr)
[![Open in Dev Containers](https://img.shields.io/static/v1?label=Dev%20Containers&message=Open&color=007ACC&logo=visualstudiocode)](https://vscode.dev/redirect?url=vscode://ms-vscode-remote.remote-containers/cloneInVolume?url=https://github.com/prodbytes/rbacr)

## How it works

- **Roots** are listed in `RBACR_ROOT_LIST`, as addresses or domains
  (`@nu01.com` means everyone at nu01.com). They hold the single global
  `root` role and every role in every system. They create systems and roles, and can
  grant any role to an address or a whole domain.
- **Implied roles**: a role can imply other roles of its system, so holding
  `premium` can also give `free`, and `admin` can give both. Implication is
  transitive; only roots set it, and no role can imply `admin`.
- **Admins** hold a system's `admin` role. They can grant that system's other
  roles to individual addresses, and create vouchers for them. Only roots can
  hand out `admin`, whether directly or through an admin voucher.
- **Vouchers** are codes like `7JH2-UQF5-XA7B-VMQT` that grant a role when
  redeemed, either in one system or **globally**. A global voucher gives the
  role in every system that defines it, and only roots can create global
  vouchers. Each voucher has a **discount**: a 100% voucher grants the role
  immediately, while a lower discount will require payment (not built yet; it
  answers 402 Payment Required). The start date, end date and usage count
  are all optional.
- **Everyone** can sign in, see their own roles at `/me` and redeem vouchers.
- **API tokens** let scripts and other applications call rbacr as a person.
  Anyone creates their own on `/me`. A token can do what its owner can do;
  for example, a root's token can ask whether anyone holds a role.

[SPEC.md](SPEC.md) has the full rules, permission matrix and API reference.

## Local development

```bash
cp .env.example .env          # set RBACR_ROOT_LIST to your address
devbox run mkcert -install    # once: trust the local HTTPS certificate
devbox services up            # Postgres, app, Floci (HTTPS) and health monitor
```

Then open **https://local.rbacr.nu01.com:8444/**, or
https://rbacr.localhost:8444/ before the `local.rbacr.nu01.com` DNS record
exists. `devbox services up` starts these processes, defined in
[process-compose.yaml](process-compose.yaml):

| Process | What it does |
|---------|--------------|
| `1-postgresql` | PostgreSQL 18 in Docker as `devbox-db` ([compose.yaml](compose.yaml)), the same major version as the Aurora clusters in AWS |
| `2-app` | `npm install`, then `vite dev` on http://localhost:5173 once Postgres is healthy. `RBACR_DATABASE_URL` defaults to the local container. |
| `3-floci` | [Floci](floci/README.md), the local AWS emulator, as the CloudFront distribution in front of the app over HTTPS (mkcert certificate, ports 4567/8444) |
| `0-health-check` | Logs `🐘 database ✅ 🔐 app ✅ 🔒 https ✅` every 15 s (set `HEALTH_CHECK_INTERVAL` to change) |

Stop everything with `devbox services stop`. In non-interactive shells, add
`--pcflags "--tui=false"`.

Without Google credentials, set `RBACR_DEV_LOGIN=1` and use `/login/dev` to
sign in as any address. Production builds always disable it. For real
Google sign-in, put the OAuth web client's id and secret in `.env`. Add
`https://local.rbacr.nu01.com:8444/login/google/callback` to the client's
redirect URIs, and sign in through that HTTPS URL.

Devbox scripts: `devbox run dev | test | check | build | certs | release-rc | release-ga | deploy`.

## Configuration

| Variable | Required | Purpose |
|----------|----------|---------|
| `RBACR_DATABASE_URL` | yes | PostgreSQL URL (use `?sslmode=require` for managed databases). Locally it defaults to the container; in AWS the stack builds it from its Aurora cluster |
| `RBACR_ROOT_LIST` | no | Comma-separated root addresses and/or domains, e.g. `ana@example.com, example.org`. An invalid entry stops the app from starting. |
| `RBACR_GOOGLE_CLIENT_ID` / `RBACR_GOOGLE_CLIENT_SECRET` | for sign-in | Google OAuth web client |
| `RBACR_PUBLIC_ORIGIN` | no | The origin users browse, used for the Google redirect URI (default: the request's origin) |
| `RBACR_ORIGIN_SECRET` | no | When set, every request must carry it in `x-rbacr-origin-secret`. In AWS, CloudFront adds it, so the Lambda URL can't be called directly. |
| `RBACR_VERSION` | no | The release version, reported by `/health` (default `dev`) |
| `RBACR_DEV_LOGIN` | no | `1` enables `/login/dev` under `vite dev` |

Migrations run automatically on the first request.

## JSON APIs

rbacr has two interfaces:

| | `/api`: the API (external) | `/vpi`: the VPI (view programming interface, frontend only) |
|---|---|---|
| For | scripts and other applications | rbacr's own pages |
| Auth | personal API token, `Authorization: Bearer rbacr_…` | the browser session cookie |
| Contract | stable, documented in [SPEC.md](SPEC.md#api-the-external-api-personal-api-token-a1) | shaped for the pages, may change |

Every `/api` request, unknown paths included, needs a valid personal API
token (401 otherwise); `/api` ignores the session cookie. The only
unauthenticated JSON endpoint is `GET /health`, outside both: it checks the
database and the Google client and answers 503 when one is missing (SPEC
HC1-HC3). In AWS a Route 53 health check polls it and e-mails alerts. `/vpi` refuses anything that isn't a
same-origin request from rbacr's pages (403), so another site, a script, or
a caller holding only a token can't use it.

```bash
TOKEN=rbacr_…   # create one on /me → API tokens; it's shown once
curl -H "Authorization: Bearer $TOKEN" https://<host>/api/me
# {"email":"ana@example.com","root":false,"adminOf":["billing"],"globalRoles":[],
#  "roles":{"billing":["admin","viewer"],"crm":["sales"]}}

curl -H "Authorization: Bearer $TOKEN" -H "content-type: application/json" \
  -d '{"email":"bob@example.com","systemId":"billing","role":"viewer"}' \
  https://<host>/api/check
# {"email":"bob@example.com","systemId":"billing","role":"viewer","allowed":true}
```

Role questions about other people follow the caller's permissions: roots can
ask about anyone, admins about their own systems, and everyone about
themselves. For an application that checks roles, create the token under an
account with the right reach (for example a root), give it an expiry, and
revoke it on `/me` when it's no longer needed.

## Tests

```bash
npm test                 # unit/domain tests (PGlite) + Lambda smoke test of the production build
npm run test:e2e         # API + pages against a running dev server (devbox services up)
npm run check            # svelte-check / TypeScript
bash scripts/package-lambda.sh   # the deployable zip, smoke-tested with production dependencies only
```

The end-to-end suite signs in through `/login/dev`, so it needs
`RBACR_DEV_LOGIN=1`. Its root (`RBACR_E2E_ROOT`, default `root@e2e.test`)
must be on `RBACR_ROOT_LIST`. With `RBACR_ROOT_LIST=@nu01.com`, run it as
`RBACR_E2E_ROOT=e2e-root@nu01.com npm run test:e2e`. Keep
[SPEC.md](SPEC.md), the tests and this README in sync with every change.

## Releases and deployment

https://rbacr.nu01.com (production) and https://rc.rbacr.nu01.com (release
candidate) run on AWS. One Lambda serves the SvelteKit app through
[lambda.js](lambda.js), behind CloudFront, with the certificate and DNS in
the `rbacr.nu01.com` Route 53 zone. All of it is defined as CloudFormation in
[infra/](infra/README.md).

```bash
bash scripts/release-rc.sh   # tag X.Y.Z-RC → release (prerelease) + deploy to rc.rbacr.nu01.com
bash scripts/release-ga.sh   # tag X.Y.Z-GA (main only) → release + deploy to rbacr.nu01.com
```

The tags trigger the [Release](.github/workflows/release.yml),
[Deploy RC](.github/workflows/deploy-rc.yml) and
[Deploy](.github/workflows/deploy.yml) workflows. They deploy through
GitHub's OIDC with no stored AWS keys, and each finishes by checking that
the live site serves the tagged version. X.Y come from
[version.X.txt](version.X.txt) and [version.Y.txt](version.Y.txt). The
one-time AWS, GitHub and Google setup is in
[infra/README.md](infra/README.md#one-time-setup).

## Project layout

```
src/env.ts                      RBACR_* variable definitions
src/hooks.server.ts             /api token or session cookie -> locals.email, security headers
src/lib/server/rbac.ts          all role and voucher rules (the domain model)
src/lib/server/tokens.ts        personal API tokens (/api auth)
src/lib/server/vpiguard.ts      the "frontend only" check for /vpi
src/lib/vpi.ts                  the pages' /vpi client
src/lib/server/identity.ts      e-mail/domain parsing, root allow list
src/lib/server/{db,schema}.ts   Postgres access and migrations
src/lib/server/{session,google,auth}.ts  sign-in and sessions
src/routes/api/**               external API (tokens)
src/routes/vpi/**               VPI (session, frontend only)
src/routes/{me,systems,global}/**  UI pages (load and change data through /vpi)
lambda.js                       Lambda entrypoint (serverless-http + adapter-node)
infra/                          CloudFormation: zone, deploy roles, artifacts, app
floci/                          local CloudFront (HTTPS) on Floci
scripts/                        release, deploy, packaging, local certs, health check
.github/workflows/              Release, Deploy RC, Deploy
tests/                          Lambda smoke test and end-to-end suite
```

## Dev container

The toolchain is pinned by [devbox.json](devbox.json) and locked in
[devbox.lock](devbox.lock): Node.js, PostgreSQL client, AWS CLI, mkcert, plus Python,
Go and GraalVM CE (musl, Linux only). The container also ships the
[docker-in-docker feature](https://github.com/devcontainers/features/tree/main/src/docker-in-docker),
so `docker ps` works out of the box.

The [Containerfile](.devcontainer/Containerfile) keeps the Microsoft
`ubuntu-24.04` devcontainer base image and layers Devbox on top:

1. Devbox is installed as root. Everything else runs as the `vscode` user, so
   the Nix store ownership matches the container's `remoteUser`.
2. Nix is installed in single-user mode (`--no-daemon`). Containers have no
   systemd, so the multi-user Nix daemon can't run.
3. At build time, the locked store paths are fetched straight from
   `cache.nixos.org` to warm `/nix/store`. This avoids GitHub API calls, so
   builds don't hit unauthenticated rate limits.
4. On container start, `postCreateCommand` runs `devbox install`, which finds
   the heavy downloads already cached. The first install still evaluates
   nixpkgs, which takes a few minutes; after that the environment is instant.
5. Then [scripts/local-env.sh](scripts/local-env.sh) writes `.env` from the
   `RBACR_LOCAL_*` Codespaces secrets (`RBACR_LOCAL_<NAME>` becomes
   `RBACR_<NAME>`), unless `.env` already exists. The GA and RC tenants
   have their own `RBACR_GA_*` and `RBACR_RC_*` repository settings, used by
   the deploy workflows ([infra/README.md](infra/README.md#one-time-setup)).
