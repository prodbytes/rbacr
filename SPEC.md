# rbacr specification

rbacr is a role manager. It records which **roles** each **identity** holds in
each **system** (application), and serves that information as HTML pages and as
JSON. This document is the source of truth for behaviour. Keep it, the tests
and the README in sync with the code.

## Concepts

| Term | Meaning |
|------|---------|
| Identity | A Google account's verified e-mail address, lower-cased. |
| Domain | The part of an address after `@`. Matching is exact: `example.com` does not cover `sub.example.com`. |
| Grantee | Who a grant applies to: one address (`ana@example.com`) or a whole domain (stored as `@example.com`; input `example.com` is accepted too). |
| System | An application whose roles rbacr manages. Its id is a slug: 1-63 characters from `a-z 0-9 _ . : -`, starting with a letter or digit. |
| Role | A name in a system's role catalog, with the same slug rules. Every system has the reserved `admin` role. A role may **imply** other roles of the same system (R6). |
| Grant | Gives (system, role) to a grantee. A **global grant** gives a role in every system whose catalog has a role of that name, now or later. |
| Voucher | A code that grants a role to whoever redeems it: in one system, or globally (a global grant). |
| API token | A person's secret token for the external API (`/api`). It acts as that person, with their current roles. |

## Identity and sign-in

- **S1** Users sign in with Google (OAuth 2.0 authorization code flow with PKCE
  and a `state` check). Only Google accounts with a verified e-mail can sign in.
- **S2** Anyone with a Google account can sign in. Signing in grants no roles.
- **S3** A successful sign-in creates a server-side session that lasts 30 days.
  The browser holds a random token in the `rbacr_session` cookie (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside dev). The database stores only the token's
  SHA-256 hash. Signing out (`POST /logout`) deletes the session.
- **S4** For local development only, `/login/dev` signs in as any address
  without Google when `RBACR_DEV_LOGIN=1`. Production builds always return 404
  for it.

## Roles

- **R1 Roots.** `RBACR_ROOT_LIST` lists addresses and/or domains (`@nu01.com`
  or `nu01.com`), separated by commas or whitespace. An identity matching an
  address or its domain is a **root**. An invalid entry makes the app refuse
  to start. In AWS it is the stack's `RootList` parameter, default
  `@nu01.com`; `scripts/deploy.sh` passes it on every deploy, and an unset
  or empty value means that default.
- **R1a** The list is the **only** way to be a root or hold the `root` role.
  Root status is never stored. `root` can't be granted, globally or in a
  system, nor be a voucher's role or a catalog role (400). A `root` grant
  found in storage anyway is ignored.
- **R2** Roots hold every role of every system. Their effective roles are the
  full catalog of every system. They also hold the single **global role**
  `root`, which belongs to no system. It is reported apart from system roles
  (`globalRoles`), and nobody else can hold it. `root` is therefore reserved
  and can't be a role name in any system's catalog.
- **R3** Everyone else's effective roles combine the grants to their own
  address and to their domain. A global grant of role R adds R in every system
  whose catalog has R, including systems created later. Their `globalRoles`
  are the roles of those global grants.
- **R4 Admins.** An identity holding the `admin` role of a system is an
  **admin** of that system. Admin is per system.
- **R5** Roles are granted per system per grantee. Granting a role that is not
  in the system's catalog fails (404).
- **R6 Implied roles.** A role may imply other roles of its system: whoever
  holds it also holds them, with all they can do. Implication is transitive.
  Built in: **`root` holds every role of every system** (R2), and **`admin`
  implies every other role of its system**, including roles added later
  (only in that system). Roots configure the rest: for example `premium →
  free`, with `free` implying nothing, so holding `premium` gives `free`, and
  holding `admin` gives both. Effective roles (R3, `/api/me`, `/api/check`,
  `/api/roles`) include implied roles, also for roles that come from global
  grants. Grants themselves stay as given (revoking an implied role that
  wasn't granted gives 404), but every grant the API returns carries the
  roles it implies (R8).
- **R7** Only roots set implications, per role, replacing that role's previous
  list. A role cannot imply itself, implications can't form a cycle,
  `admin`'s implications are fixed (it already implies everything), and
  **nothing can imply `admin`** (otherwise an admin could hand out admin by
  granting a role that implies it, against P1); these give 400. Implied roles
  must be in the catalog (404). Removing a role removes its implications in
  both directions. A system's `implies` lists every role's direct
  implications, `admin`'s included.
- **R8** Every grant in an API response (granting, listing grants, redeeming
  a voucher, global grants) includes `impliedRoles`: the roles its role
  implies in its system, sorted, without the role itself. A global grant
  gives its role in every system that defines it, so it has
  `impliedRoles: []` and `impliedRolesBySystem: { systemId: [role] }`.

## Permissions

| Action | Root | Admin of the system | Anyone signed in |
|--------|:----:|:-------------------:|:----------------:|
| See own roles, redeem a voucher | ✓ | ✓ | ✓ |
| List or see a system, its grants and vouchers | all systems | own systems | — |
| Create or delete systems; add or remove catalog roles; set implied roles | ✓ | — | — |
| Grant or revoke non-admin roles to an **address** | ✓ | ✓ | — |
| Grant or revoke non-admin roles to a **domain** | ✓ | — | — |
| Grant or revoke the `admin` role (address or domain) | ✓ | — | — |
| Create, list or disable non-admin vouchers | ✓ | ✓ | — |
| Create, list or disable `admin` vouchers | ✓ | — | — |
| Grant, list or revoke **global** roles; create, list or disable **global** vouchers | ✓ | — | — |
| Create, list or revoke **own API tokens** | ✓ | ✓ | ✓ |
| Ask about **another** identity's roles (`/api/check`, `/api/roles`) | anyone, incl. global roles | in own systems | — (only themselves) |

- **P1** Only roots propagate the admin role, directly or through vouchers.
  Admins never see admin vouchers, and cannot disable them (they get 404).
- **P2** The `admin` role cannot be removed from a catalog. Removing any other
  role also removes its grants and vouchers. Deleting a system removes
  everything in it.
- **P3** Grants and vouchers created by an admin stay valid if that admin later
  loses the role.

## Vouchers

- **V1** A voucher has a code and a scope: one system, or **global**
  (`systemId: null`, roots only). It also has a role, a **discount**
  (`discountPercent`, a whole number from 0 to 100, default 100), an
  optional start date (`startsAt`), an optional end date (`endsAt`,
  exclusive) and an optional usage count (`maxUses` ≥ 1). It records its
  creator and its uses. If both dates are set, the start must come before
  the end. A system voucher's role must be in that system's catalog. A
  global voucher's role only has to be a valid name other than `root`.
- **V2** Codes are 16 random characters from a 32-symbol alphabet with no
  `0/O/1/I` (80 bits), shown as `XXXX-XXXX-XXXX-XXXX`. Input is
  case-insensitive and ignores separators.
- **V3** A voucher is `active` unless it is `disabled`, `not-started` (now <
  startsAt), `expired` (now ≥ endsAt) or `exhausted` (uses ≥ maxUses), checked
  in that order.
- **V4** Redeeming an active voucher with a **100% discount** grants its role
  to the redeemer's address and increments `uses`. A system voucher creates a
  grant in its system; a global voucher creates a global grant. Redemption
  runs in one transaction with a row lock, so concurrent redemptions cannot
  exceed `maxUses`.
- **V4a** A voucher with a discount **below 100%** requires payment, which is
  *not implemented yet*. Redeeming it answers 402 with
  `{ error, payment: { code, systemId, role, discountPercent } }`, and
  records nothing: no use, redemption or grant. Inactive vouchers report their
  status (V3/V5) before payment comes into it. When payment is implemented,
  a confirmed payment completes the redemption as in V4.
- **V5** Each identity can redeem a given voucher only once (409). Redeeming
  an inactive voucher fails with 409 and the reason. An unknown code gives 404.
- **V6** Disabling is permanent. Disabled vouchers stay listed for auditing.

## Two APIs

- **A1** `/api` is the **external API** (API), for scripts and other
  applications. It authenticates only with a personal API token (T3). Every
  request under `/api`, unknown paths included, is refused with 401 before
  routing unless it carries a valid token, so no `/api` endpoint is public.
  The session cookie is ignored there, even when the browser sends it.
  `/api` responses are `Cache-Control: no-store`.
- **A2** `/vpi` is the **view programming interface** (VPI), the frontend's
  own interface: every page loads its data from it
  and makes its changes through it. Pages have no server load functions or
  form actions, so the frontend has no other API. It authenticates only with
  the session cookie (S3).
- **A3** `/vpi` accepts only requests from rbacr's own pages; anything else
  gets 403 before authentication:
  - SvelteKit's in-process fetch while rendering a page (a sub-request), or
  - a browser request carrying `x-rbacr-vpi: 1` and `Sec-Fetch-Site:
    same-origin`. A write must also carry an `Origin` that is the app's own
    (or `RBACR_PUBLIC_ORIGIN`); a read may omit `Origin`, but if it sends one
    it must match.

  The custom header forces a CORS preflight from any other origin, and rbacr
  never answers preflights. Browser scripts can't forge `Sec-Fetch-Site`, and
  the session cookie is `HttpOnly`. `/vpi` responses are `Cache-Control:
  no-store`.
- **A4** Limit: a non-browser client that copies a user's session cookie and
  fakes these headers can't be told apart from the browser. A1 is what keeps
  the two APIs separate: credentials for `/api` never work on `/vpi`, and
  the reverse.
- **A5** Before the app has loaded, the browser ignores submissions of the
  JavaScript-handled forms, so their values never end up in a URL. Explicit
  `method="post"` forms (sign-in, sign-out) still submit natively.

## API tokens

- **T1** Any signed-in person can create tokens for themselves on `/me`.
  Each token has a name (1-100 characters) and an optional expiry in whole
  days (1-3650; empty means it never expires). A person can have at most 25
  active tokens (409).
- **T2** A token is `rbacr_` followed by 32 random bytes in base64url (256
  bits). It is shown only in the creation response. The database stores its
  SHA-256 hash and its first 12 characters (`prefix`, used in listings).
- **T3** Callers send `Authorization: Bearer <token>` to `/api`. A missing,
  unknown, revoked or expired token gets 401 with `WWW-Authenticate: Bearer`.
  Each use records `lastUsedAt`.
- **T4** A token acts as its owner, with the owner's roles at the time of the
  request (root status included). Changing someone's roles changes what their
  tokens can do.
- **T5** People list and revoke only their own tokens (anyone else's gives
  404). Revoking is permanent; revoked tokens stay listed. Tokens are managed
  only through `/vpi`, so a token can't mint more tokens.
- **T6** Role queries: `/api/check` and `/api/roles` answer with R1-R3. Anyone
  may ask about themselves. Roots may ask about anyone, global roles
  included. Admins may ask about anyone within the systems they administer,
  but not about global roles. Anything else gives 403. An unknown system, or
  a role missing from its catalog, gives 404. Without a `systemId`,
  `/api/check` asks about a global role (such as `root`).

## Client integration

How applications use rbacr. The README has a walkthrough with examples.

- **C1** rbacr does not authenticate an application's users. The application
  signs them in itself and asks rbacr about the verified e-mail address,
  server-side, with a personal API token (T1-T5). rbacr trusts the address
  it is given.
- **C2** A token sees what its owner may see (T6): a system's admin, anyone
  in that system; a root, anyone everywhere plus global roles; anyone else,
  only themselves. Applications should use a token owned by an admin of
  their own system.
- **C3** `POST /api/check` answers `allowed: true` exactly when the identity
  holds the role in the system as an effective role (R3, R6): through a
  grant to its address or domain, a global grant, an implication, or root
  status (R2). A role the identity doesn't hold gives `allowed: false`. A
  system or role that doesn't exist gives 404, after the reach check (403).
- **C4** `POST /api/roles` with a `systemId` returns the same effective
  roles as a sorted list; without one, every system's and the global roles.
  `GET /api/me` returns the token owner's own roles.
- **C5** E-mail addresses and role names are matched case-insensitively and
  returned lower-cased.
- **C6** A change to grants, implications or vouchers shows in these
  answers within about a second (D3). A revoked or expired token is refused
  at once (T3). Clients that cache answers should cache them briefly and
  never cache errors, and should deny access when rbacr can't answer.

## HTTP interface

### `/api`: the external API (personal API token, A1)

Errors are returned as
`{ "error": "message" }` with status 400 (invalid input), 401 (no valid token),
403 (forbidden), 404 (not found) or 409 (conflict, inactive or already
redeemed voucher), or 402 (the voucher needs payment, V4a). Dates are
ISO-8601 strings in UTC.

| Method & path | Body | Response |
|---------------|------|----------|
| `GET /api/me` | — | `{ email, root, adminOf: [systemId], globalRoles: ["root"] or [], roles: { systemId: [role] } }` |
| `POST /api/vouchers/redeem` | `{ code }` | the resulting grant with `impliedRoles` (`systemId: null` and `impliedRolesBySystem` when global), or 402 (V4a) |
| `GET /api/vouchers` | — | `{ vouchers: [...] }`, the global vouchers (roots) |
| `POST /api/vouchers` | `{ role, discountPercent?, startsAt?, endsAt?, maxUses? }` | 201, a global voucher (roots) |
| `GET /api/global-grants` | — | `{ grants: [{ systemId: null, role, grantee, grantedBy, grantedAt, voucherCode, impliedRoles: [], impliedRolesBySystem }] }` (roots, R8) |
| `POST /api/global-grants` | `{ role, grantee }` | 201, the global grant, with `impliedRolesBySystem` (roots) |
| `DELETE /api/global-grants` | `{ role, grantee }` | 204 (roots) |
| `DELETE /api/vouchers/:code` | — | the disabled voucher |
| `GET /api/systems` | — | `{ systems: [{ id, name, roles, implies: { role: [role] } }] }` (only manageable systems; `implies` lists direct implications) |
| `POST /api/systems` | `{ id, name?, roles?: [string] }` | 201, the system (`admin` is always added) |
| `GET /api/systems/:id` | — | `{ id, name, roles }` |
| `DELETE /api/systems/:id` | — | 204 |
| `POST /api/systems/:id/roles` | `{ role }` | the system |
| `DELETE /api/systems/:id/roles/:role` | — | 204 |
| `PUT /api/systems/:id/roles/:role` | `{ implies: [role] }` | the system, with the role's implied roles replaced (roots, R7) |
| `GET /api/systems/:id/grants` | — | `{ grants: [{ systemId, role, grantee, grantedBy, grantedAt, voucherCode, impliedRoles }] }` (R8) |
| `POST /api/systems/:id/grants` | `{ role, grantee }` | 201, the grant with `impliedRoles` (re-granting is idempotent) |
| `DELETE /api/systems/:id/grants` | `{ role, grantee }` | 204 |
| `GET /api/systems/:id/vouchers` | — | `{ vouchers: [{ code, systemId, role, discountPercent, startsAt, endsAt, maxUses, uses, status, createdBy, createdAt, disabledAt }] }` |
| `POST /api/systems/:id/vouchers` | `{ role, discountPercent?, startsAt?, endsAt?, maxUses? }` | 201, the voucher |
| `POST /api/check` | `{ email, systemId?, role }` | `{ email, systemId, role, allowed }` (T6) |
| `POST /api/roles` | `{ email, systemId? }` | `{ email, systemId, roles: [role] }`, or without `systemId`, `{ email, globalRoles, roles: { systemId: [role] } }` (T6) |

`/api/check` and `/api/roles` are `POST` with a JSON body, so e-mail
addresses stay out of URLs and access logs.

### Outside both APIs

- **HC1** `GET /health` reports whether rbacr can serve, with no
  authentication. It is the only JSON endpoint outside `/api` and `/vpi`. It
  answers `{ ok, version, checks: { google } }`, with
  `Cache-Control: no-store`. `google` is `ok` when the Google OAuth client is
  configured, else `missing`.
- **HC2** The status is 200 when every required check is `ok`, else 503.
  `google` is required, except under `vite dev`, which has the dev login
  (S4). DynamoDB is deliberately not checked: it is a managed regional
  service, and probing it on every poll would only add cost. The deploy
  smoke test exercises it instead (an unknown API token gets 401, not
  500).
- **HC3** In AWS, a Route 53 health check polls `https://<domain>/health`
  through CloudFront every 30 seconds from three regions. When it fails, a
  CloudWatch alarm e-mails the stack's `HealthNotificationEmails` (default
  `julio+health@nu01.com`), and e-mails again on recovery.

### `/vpi`: the view programming interface (session cookie, A2/A3)

Its endpoints are shaped for the pages and are not a public contract; the
frontend (`src/lib/vpi.ts`) is its only client. The routes are
`GET /vpi/session` (who is signed in; works anonymously), `GET /vpi/settings`
(version, API address, account), `GET /vpi/me`,
`POST /vpi/me/redeem` (402 with `payment` per V4a), `GET|POST /vpi/tokens`,
`DELETE /vpi/tokens/:id`, `GET|POST /vpi/systems`,
`GET|DELETE /vpi/systems/:id`, `POST /vpi/systems/:id/roles`,
`PUT|DELETE /vpi/systems/:id/roles/:role`, `POST|DELETE /vpi/systems/:id/grants`,
`POST /vpi/systems/:id/vouchers`, `DELETE /vpi/vouchers/:code`,
`GET /vpi/global`, `POST|DELETE /vpi/global/grants` and
`POST /vpi/global/vouchers`. They return the same errors as `/api`; a
missing session gives 401.

### Pages

`/` (sign in), `/me` (own roles, redeem a voucher, API tokens), `/settings`
(the running version, the API's address, the signed-in account), `/systems`
(manageable systems, create a system), `/systems/:id` (catalog, grants,
vouchers) and `/global` (roots: global grants and vouchers). Pages load
through `/vpi`; a page whose data needs a session sends anonymous visitors
to `/`. The pages need JavaScript.

## Request hardening

- **H1** When `RBACR_ORIGIN_SECRET` is set, any request without that exact
  value in `x-rbacr-origin-secret` gets 403 before anything else runs (a
  constant-time comparison). In AWS, CloudFront adds the header, so calling
  the Lambda function URL directly is refused.
- **H2** In production builds, form submissions (`POST`/`PUT`/`PATCH`/`DELETE`
  with a form or plain-text body, or with no content type) whose `Origin` is
  not the app's own get 403 (SvelteKit's CSRF check).

## Configuration

All settings come from environment variables prefixed `RBACR_`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `RBACR_DYNAMODB_TABLE` | yes | The DynamoDB table holding all data (`rbacr`, `rbacr-rc`; `infra/tables.yaml`) |
| `RBACR_DYNAMODB_ENDPOINT` | no | DynamoDB Local's URL for development (e.g. `http://127.0.0.1:8642`); the app creates its table there. Unset in AWS. |
| `RBACR_ROOT_LIST` | no (no roots if empty; in AWS the default is `@nu01.com`) | Root addresses and domains (R1, R1a) |
| `RBACR_GOOGLE_CLIENT_ID`, `RBACR_GOOGLE_CLIENT_SECRET` | for Google sign-in | OAuth web client. Without them `/login/google` returns 503. |
| `RBACR_PUBLIC_ORIGIN` | no | Origin for the Google redirect URI (`<origin>/login/google/callback`); default: the request's origin |
| `RBACR_ORIGIN_SECRET` | no | Required value of the `x-rbacr-origin-secret` header (H1) |
| `RBACR_VERSION` | no | Version reported by `/health` (default `dev`) |
| `RBACR_DEV_LOGIN` | no | `1` enables `/login/dev` under `vite dev` only (S4) |

## Runtime and storage

- SvelteKit with `@sveltejs/adapter-node`. `lambda.js` wraps the built handler
  with `serverless-http` for AWS Lambda. Lambda runs behind a function URL
  fronted by CloudFront ([infra/app.yaml](infra/app.yaml)). The request's
  host comes from the `x-rbacr-host` header (adapter-node's `HOST_HEADER`),
  which CloudFront sets, and the protocol is assumed to be `https`.
- DynamoDB: one on-demand table per stage ([infra/tables.yaml](infra/tables.yaml)),
  DynamoDB Local in development ([compose.yaml](compose.yaml)) and in the
  unit tests. The item layout is documented in
  [src/lib/server/rbac.ts](src/lib/server/rbac.ts); it needs no migrations.
- **D1** Writes that must not race are single DynamoDB transactions with
  conditions: a grant, voucher or implication checks that its role still
  exists; redeeming counts the use (within `maxUses`), records the
  redemption (once per identity) and grants, all or nothing; concurrent
  implication edits are serialized by a version on the system.
- **D2** Deleting a role or a system removes its dependent items (grants,
  implications, vouchers and redemptions) in batches after the role or
  system's own record, so nothing new can attach meanwhile. It is not
  atomic: a failed deletion can be retried.
- **D3** Lookups across partitions (an identity's roles, a person's tokens,
  a system's vouchers) use a secondary index, which is eventually
  consistent: a change can take up to about a second to show there.

## Tests

| Suite | Command | Covers |
|-------|---------|--------|
| Unit and domain | `npx vitest --run` | Identity parsing, the R*, P*, V*, T* and D* rules against DynamoDB Local (a Docker container started by the test setup, or `RBACR_TEST_DYNAMODB_ENDPOINT`), the A3 guard, sessions, Google OAuth exchange |
| Lambda smoke | `npm run test:lambda` | The production build invoked through `lambda.js` with function URL (v2) events: H1, H2, A1 and A3, the version, redirects, 401s, static assets. `scripts/package-lambda.sh` reruns it against the deployable bundle. |
| End-to-end | `npm run test:e2e` | `/api` with personal tokens, `/vpi` as the frontend, the A1/A3 separation, and the pages, against a running dev server with DynamoDB Local, directly or through Floci over HTTPS |
| Live | `scripts/deploy.sh` (last step) | The deployed site: version, sign-in page, 401 (also for an unknown token, which reads DynamoDB), 404 for `/login/dev`, 403 for the bare function URL |

`npm test` runs the first two.
