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
  `root` role and every role in every system. The list is the only way to
  become a root: `root` can't be granted or redeemed. Roots create systems
  and roles, and can grant any role to an address or a whole domain.
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
devbox services up            # DynamoDB Local, app, Floci (HTTPS) and health monitor
```

Then open **https://local.rbacr.nu01.com:8444/**, or
https://rbacr.localhost:8444/ before the `local.rbacr.nu01.com` DNS record
exists. `devbox services up` starts these processes, defined in
[process-compose.yaml](process-compose.yaml):

| Process | What it does |
|---------|--------------|
| `1-dynamodb` | DynamoDB Local in Docker as `devbox-dynamodb` on port 8642 (`RBACR_DYNAMODB_PORT`) ([compose.yaml](compose.yaml)), data kept in a volume |
| `2-app` | `npm install`, then `vite dev` on http://localhost:5173 once DynamoDB Local is up. It uses the `rbacr` table there (`RBACR_DYNAMODB_TABLE`, `RBACR_DYNAMODB_ENDPOINT`) and creates it on first use. |
| `3-floci` | [Floci](floci/README.md), the local AWS emulator, as the CloudFront distribution in front of the app over HTTPS (mkcert certificate, ports 4567/8444) |
| `0-health-check` | Logs `🗄️ dynamodb ✅ 🔐 app ✅ 🔒 https ✅` every 15 s (set `HEALTH_CHECK_INTERVAL` to change) |

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
| `RBACR_DYNAMODB_TABLE` | yes | The DynamoDB table holding all data. Locally `rbacr` on DynamoDB Local; in AWS the stage's table (`rbacr`, `rbacr-rc`) |
| `RBACR_DYNAMODB_ENDPOINT` | no | DynamoDB Local's URL in development (process-compose sets `http://127.0.0.1:8642`); the app creates the table there |
| `RBACR_ROOT_LIST` | no | Comma-separated root addresses and/or domains, e.g. `ana@example.com, @example.org`: the only way to be a root. An invalid entry stops the app from starting. In AWS it defaults to `@nu01.com`. |
| `RBACR_GOOGLE_CLIENT_ID` / `RBACR_GOOGLE_CLIENT_SECRET` | for sign-in | Google OAuth web client |
| `RBACR_PUBLIC_ORIGIN` | no | The origin users browse, used for the Google redirect URI (default: the request's origin) |
| `RBACR_ORIGIN_SECRET` | no | When set, every request must carry it in `x-rbacr-origin-secret`. In AWS, CloudFront adds it, so the Lambda URL can't be called directly. |
| `RBACR_VERSION` | no | The release version, reported by `/health` (default `dev`) |
| `RBACR_DEV_LOGIN` | no | `1` enables `/login/dev` under `vite dev` |

## Using rbacr from your application

rbacr answers one question for your applications: **which roles does this
person hold in my system?** It doesn't sign your users in. Your application
authenticates its users itself (typically with Google), then asks rbacr
about the verified e-mail address, server-side, with an API token.

### 1. Set up your system (once, in the UI)

1. A root creates the system on `/systems` (its id is what your code sends
   as `systemId`, e.g. `presence`) and its roles (e.g. `free`, `premium`).
   Every system also has `admin`.
2. Optionally, a root sets **implied roles** (`premium` implies `free`), so
   your code can ask for the role a feature needs and anyone with a
   higher role passes too.
3. Roots or the system's admins grant roles to addresses (roots also to
   whole domains or globally), or hand out vouchers that people redeem on
   `/me`.

### 2. Create a token for your application

Sign in as an account that may see the roles your application asks about,
open `/me` → **API tokens**, create one with an expiry, and store it as a
server-side secret (it's shown once). A token acts as the person who
created it, with their roles at the time of each request:

| Token owner | Can ask about |
|---|---|
| An **admin of your system** (recommended) | anyone's roles in that system |
| A **root** | anyone's roles in every system, and global roles |
| Anyone | only themselves (`/api/me`, or their own address) |

Use an admin of your system unless you need more: if the token leaks, it
reveals only that system's roles. Revoke tokens on `/me`; a revoked or
expired token gets 401 at once.

### 3. Ask about roles

All calls go to `https://rbacr.nu01.com/api/…` (RC:
`https://rc.rbacr.nu01.com`) with `Authorization: Bearer rbacr_…`. Role
queries are `POST` with a JSON body, so e-mail addresses stay out of URLs
and access logs.

**Check one permission** when a request needs it:

```bash
curl -H "Authorization: Bearer $RBACR_TOKEN" -H "content-type: application/json" \
  -d '{"email":"ana@example.com","systemId":"presence","role":"premium"}' \
  https://rbacr.nu01.com/api/check
# {"email":"ana@example.com","systemId":"presence","role":"premium","allowed":true}
```

**Fetch all of a person's roles** in your system, for example at sign-in,
and decide locally:

```bash
curl -H "Authorization: Bearer $RBACR_TOKEN" -H "content-type: application/json" \
  -d '{"email":"ana@example.com","systemId":"presence"}' \
  https://rbacr.nu01.com/api/roles
# {"email":"ana@example.com","systemId":"presence","roles":["free","premium"]}
```

Without `systemId`, `/api/roles` returns every system's roles and the
person's global roles (root tokens only, except about yourself). A script
acting as its owner can call `GET /api/me` for its own roles.

In TypeScript (server-side only; never ship the token to a browser):

```ts
const RBACR = 'https://rbacr.nu01.com';

export async function hasRole(email: string, systemId: string, role: string): Promise<boolean> {
	const res = await fetch(`${RBACR}/api/check`, {
		method: 'POST',
		headers: { authorization: `Bearer ${process.env.RBACR_TOKEN}`, 'content-type': 'application/json' },
		body: JSON.stringify({ email, systemId, role })
	});
	if (!res.ok) throw new Error(`rbacr ${res.status}: ${(await res.json()).error}`);
	return (await res.json()).allowed; // treat any failure as "not allowed"
}
```

### What the answers mean

- **Roles are effective roles**: grants to the address, grants to its
  domain, global grants of a role your system defines, and everything those
  imply. Roots (`RBACR_ROOT_LIST`) hold every role of every system.
- **E-mail addresses** are matched case-insensitively. Send the address
  your sign-in verified; rbacr trusts what you send.
- **`allowed: false`** means the person doesn't hold the role. A role or
  system that doesn't exist is a 404, not `false`, so typos surface (a
  token that can't see the system gets 403 first).
- **Fresh within about a second.** A grant or revocation can take up to a
  second to show (SPEC D3). If you cache answers, keep it short (a minute
  or less) and never cache errors.
- **Errors** are JSON `{ "error": "…" }`: 400 bad input, 401 missing,
  revoked or expired token (with `WWW-Authenticate: Bearer`), 403 asking
  beyond the token owner's reach, 404 unknown system or role. Fail closed:
  deny access when rbacr can't answer.

### The two interfaces

| | `/api`: the API (external) | `/vpi`: the VPI (view programming interface, frontend only) |
|---|---|---|
| For | scripts and other applications | rbacr's own pages |
| Auth | personal API token, `Authorization: Bearer rbacr_…` | the browser session cookie |
| Contract | stable, documented in [SPEC.md](SPEC.md#api-the-external-api-personal-api-token-a1) | shaped for the pages, may change |

Every `/api` request, unknown paths included, needs a valid personal API
token (401 otherwise), and `/api` ignores the session cookie. Besides role
queries, it can manage systems, grants and vouchers within the token
owner's permissions ([SPEC.md](SPEC.md#permissions)). `/vpi` refuses
anything that isn't a same-origin request from rbacr's pages (403). The only
unauthenticated JSON endpoint is `GET /health` (SPEC HC1-HC3), which a
Route 53 health check polls in AWS.

## Tests

```bash
npm test                 # unit/domain tests (DynamoDB Local in Docker) + Lambda smoke test of the production build
                         # (safe while `devbox services up` runs: vitest uses its own .svelte-kit-vitest/)
npm run test:e2e         # API + pages against a running dev server (devbox services up); through local HTTPS:
                         # NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem" RBACR_E2E_URL=https://local.rbacr.nu01.com:8444 npm run test:e2e
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
src/lib/server/dynamo.ts        the DynamoDB table: definition, client, query helpers
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
[devbox.lock](devbox.lock): Node.js, AWS CLI, mkcert, plus Python,
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
