# rbacr-lib

A TypeScript client for [rbacr](../README.md): servers use it to ask the
rbacr service ([rbacr-sls](../rbacr-sls/README.md)) which roles their users
hold, keeping answers briefly so that not every check is a request, and,
with a root's token, to grant and revoke roles (a payment webhook granting
a subscriber role, say). It wraps the external API (`/api`), whose
[SPEC.md](../rbacr-sls/SPEC.md) defines every answer, and follows its
client rules (C1-C7).

No dependencies: the platform's `fetch` (Node 20+, Deno, Bun, workers).
Package `rbacr-lib`, ESM, with type declarations.

## Add it

It isn't on npm; each release is a packed tarball on this repository's
GitHub releases (tags `rbacr-lib-v<version>`), which npm installs by URL
and pins by integrity in your lockfile:

```sh
npm install https://github.com/prodbytes/rbacr/releases/download/rbacr-lib-v0.1.0/rbacr-lib-0.1.0.tgz
```

## Use it

```ts
import { RbacrClient } from 'rbacr-lib';

// RBACR_URL (default https://rbacr.nu01.com) and RBACR_TOKEN, unless given.
const rbacr = new RbacrClient({ token: process.env.MY_APP_RBACR_TOKEN });

// Fail closed: an error, or no answer, is "no" (C6).
if (await rbacr.allows(user.email, 'presence', 'premium')) { /* … */ }

// Effective roles in a system plus global ones (root); null when rbacr can't say.
const roles = await rbacr.rolesOf(user.email, 'presence');

// Roots only: a subscription paid until the end of its period.
await rbacr.grant({ systemId: 'presence', role: 'premium', grantee: user.email, endsAt: periodEnd });
await rbacr.revoke({ systemId: 'presence', role: 'premium', grantee: user.email });
const blocked = await rbacr.holders('presence', 'blocked'); // Set of addresses
```

## The client

`new RbacrClient(options)`:

| Option | Default | |
|---|---|---|
| `url` | `RBACR_URL`, else `https://rbacr.nu01.com` (C7) | `https`; plain `http` only for localhost. Also exported: `RBACR_PRODUCTION`, `RBACR_RELEASE_CANDIDATE`, `RBACR_LOCAL` (`http://localhost:8686`). |
| `token` | `RBACR_TOKEN` (C7) | a personal API token, or a function (sync or async) giving one. Asking about other people needs a root's token, kept server-side (C2). |
| `cacheMs` | 60 000 | how long answers are kept; 0: never. |
| `timeoutMs` | 5 000 | each request's limit. |
| `fetch`, `clock` | the platform's | for tests. |

Asking:

| Method | Calls | Kept | On failure |
|---|---|---|---|
| `me()` | `GET /api/me` | no | throws |
| `check(email, systemId, role)` | `POST /api/check` | no | throws |
| `allows(email, systemId, role, {fresh?})` | `POST /api/check` | `cacheMs`; a "yes" never past its `ttl` (C3a) | `false`, not kept |
| `roles(email, systemId)` | `POST /api/roles` | no | throws |
| `allRoles(email)` | `POST /api/roles` (no system) | no | throws |
| `rolesOf(email, systemId, {fresh?})` | `POST /api/roles` (no system) | `cacheMs`, per address | `null`, not kept |
| `systemStatus(systemId)` | `GET /api/systems/:id/status` (R12) | no | throws |

Granting (roots):

| Method | Calls | |
|---|---|---|
| `grants(systemId)` | `GET /api/systems/:id/grants` | the live direct grants |
| `holders(systemId, role, {fresh?})` | the same | the addresses holding `role` by an active direct grant (not implied, global or roots'), kept `cacheMs`; errors throw |
| `grant({systemId, role, grantee, startsAt?, endsAt?})` | `POST /api/systems/:id/grants` | the grant; again with another validity replaces it (G2) |
| `revoke({systemId, role, grantee})` | `DELETE /api/systems/:id/grants` | `false` when there was none |

`fresh` asks rbacr even when an answer is kept (right after a payment).
A grant or revoke drops what this client kept about the grantee (all of
it, for a domain), and that role's holders. `forget(email?)` drops kept
answers about one address, or all. Other instances' answers age out
within `cacheMs`; rbacr itself shows a change within about a second (D3).

Errors are `RbacrError`, with the HTTP `status` (0: unreachable, or a bad
`url`; 401 without a token) and rbacr's `{ "error" }` message. Addresses
are sent lower-cased (C5).

## Develop

From `rbacr-lib/`:

```sh
npm install
npm run check      # typecheck, unit tests (a fake rbacr), build to dist/
```

End to end, against a real rbacr (the `prodbytes/rbacr-local` image, or
`devbox services up` in rbacr-sls), with a root's token:

```sh
docker run -d --rm --name rbacr-lib-e2e -p 127.0.0.1:8686:8686 -e RBACR_TOKEN=rbacr_… prodbytes/rbacr-local
RBACR_E2E_URL=http://localhost:8686 RBACR_E2E_TOKEN=rbacr_… npm run test:e2e
```

It makes a throwaway system, grants with an end and through an
implication, lists holders, revokes, and deletes the system.

CI (`.github/workflows/rbacr-lib.yml`) runs `npm run check` on pull
requests and pushes to main that touch it.

## Release

```sh
scripts/release.sh   # from main: checks, packs rbacr-lib-<version>.tgz, publishes it as GitHub release rbacr-lib-v<version>
```

Bump `version` in `package.json` first (a released version is never
replaced).
