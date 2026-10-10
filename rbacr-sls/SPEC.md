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
| Grantee | Who a grant applies to: one address (`ana@example.com`) or a whole domain (stored as `@example.com`; input `example.com` is accepted too). Internally also `*`, everyone, for roles marked so (R9); the grants API never accepts it. |
| System | An application whose roles rbacr manages. Its id is a slug: 1-63 characters from `a-z 0-9 _ . : -`, starting with a letter or digit. Its configuration names the role paying subscribers hold there (`subscriberRole`, Q2). |
| Role | A name a root registers in a system's catalog, with the same slug rules (any name but `root`). A role may **imply** other roles of the same system (R6). Both are data; `root` is the only built-in role (R2). |
| Grant | Gives (system, role) to a grantee, during its validity (G1). A **global grant** gives a role in every system whose catalog has a role of that name, now or later. |
| Voucher | A code that grants a role to whoever redeems it: in one system, or globally (a global grant). |
| Subscriber | A paying subscriber of the newsletter (Substack) whose payments run on the publisher's Stripe account. |
| API token | A person's secret token for the external API (`/api`). It acts as that person, with their current roles. |

## Identity and sign-in

- **S1** Users sign in with Google (OAuth 2.0 authorization code flow with PKCE
  and a `state` check). Only Google accounts with a verified e-mail can sign in.
- **S2** Anyone with a Google account can sign in. Signing in grants no roles.
- **S3** A successful sign-in creates a server-side session that lasts 30 days.
  The browser holds a random token in the `rbacr_session` cookie (`HttpOnly`,
  `SameSite=Lax`, `Secure` outside dev). The database stores only the token's
  SHA-256 hash. Signing out (`POST /logout`) revokes the session (L1).
  Sessions are kept in a table of their own, which DynamoDB's TTL purges
  `RBACR_SESSION_RETENTION_DAYS` days (default 365) after each session
  expires. This retention is the only physical deletion in rbacr (L1).
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
- **R2** `root` is the **only built-in role**. Roots hold every role of every
  system: their effective roles are the full catalog of every system
  (except systems in maintenance, R11). They
  also hold the single **global role** `root`, which belongs to no system.
  It is reported apart from system roles (`globalRoles`), and nobody else
  can hold it. `root` is therefore reserved and can't be a role name in any
  system's catalog. Roots alone manage rbacr (P1).
- **R3** Everyone else's effective roles combine the grants to their own
  address, to their domain and to everyone (R9) that are valid now (G1),
  in systems that aren't in maintenance (R11). A global grant of role R adds R in every system
  whose catalog has R, including systems created later. Their `globalRoles`
  are the roles of those global grants.
- **R4 Roles are registered data.** A system has exactly the roles a root
  registers for it, when creating it or later; none are built in. No role
  name but `root` means anything to rbacr: a role called `admin` is an
  ordinary role with no powers.
- **R5** Roles are granted per system per grantee. Granting a role that is not
  in the system's catalog fails (404).
- **R6 Implied roles are registered data.** A role may imply other roles of
  its system: whoever holds it also holds them. Implication is transitive.
  None are built in, and a new system or role implies nothing until a root
  registers it. For example, a root registers `admin → premium, free` and
  `premium → free`, and leaves `free` implying nothing: holding `premium`
  gives `free`, and holding `admin` gives both. Effective roles (R3,
  `/api/me`, `/api/check`, `/api/roles`) include implied roles, also for
  roles that come from global grants. Grants themselves stay as given
  (revoking an implied role that wasn't granted gives 404), but every grant
  the API returns carries the roles it implies (R8).
- **R7** Only roots register implications, per role, replacing that role's
  previous list. A role cannot imply itself and implications can't form a
  cycle (400). Implied roles must be in the catalog (404). Removing a role
  removes its implications in both directions (L3). Replacing a role's list
  marks the implications it drops as removed (L1). A system's `implies` lists
  each role's registered direct implications.
- **R8** Every grant in an API response (granting, listing grants, redeeming
  a voucher, global grants) includes `impliedRoles`: the roles its role
  implies in its system, sorted, without the role itself. A global grant
  gives its role in every system that defines it, so it has
  `impliedRoles: []` and `impliedRolesBySystem: { systemId: [role] }`.
- **R9 Roles for everyone.** A root can mark a role `everyone` (`PUT
  /api/systems/:id/roles/:role` with `{ everyone: true }`, `false` to
  stop): every identity then holds it in that system, with what it
  implies, as an effective role (R3, `/api/check`, `/api/roles`,
  `/api/me`): anyone who signs in, and any address an application asks
  about. It is a grant to the grantee `*` made with the flag, in one
  transaction, starting now and never ending; turning it off revokes that
  grant (L1). A system lists such roles in `everyone`; the grant isn't
  listed among the system's grants. Removing the role revokes it (L3), and
  a re-added role starts unmarked. For example, mark `free` so everyone
  signed in gets the free tier.
- **R10 System URLs.** A system may have a `url`, an absolute `http://` or
  `https://` address of at most 2048 characters (anything else, such as
  `javascript:`, gives 400), set or cleared with `PATCH /api/systems/:id`
  `{ url }`. The pages print each role name of the system as a link to it
  that opens in a new tab. `/vpi/me` gives the URLs of the systems the
  signed-in person holds roles in.
- **R11 Maintenance mode.** A root can put a system in maintenance
  (`PATCH /api/systems/:id` `{ maintenance: true }`, `false` to end it;
  off by default, as `maintenance` in the system). While it is on, role
  queries give nobody any role in that system, roots included:
  `/api/roles` and `/api/me` list it with no roles, and `/api/check`
  answers `allowed: false` (an unknown role is still 404), so its
  application can be fixed while nobody is let in. Nothing else changes:
  grants, implications, roles for everyone (R9), subscriber grants (Q2)
  and vouchers are kept and still managed, global roles are unaffected,
  and the system's roles count again as soon as it is off. The system
  page shows a toggle and a warning, the systems list a badge.

## Grant validity

- **G1** Every grant has a validity: an optional start (`startsAt`) and an
  optional end (`endsAt`, exclusive). A missing start means immediately, a
  missing end means forever. If both are set, the start must come before
  the end (400). A grant gives its role (R3, R6, C3) only while
  `startsAt ≤ now < endsAt`; its `status` is `active`, `not-started` or
  `expired` accordingly. Grants outside their validity stay listed until
  revoked (L2).
- **G2** A grantee holds a role in a system (or globally) through at most
  one grant. A root granting it again with the same validity changes
  nothing (the original grant is kept); with another validity, the new
  grant replaces the old one, whoever made it.
- **G3** A voucher's grant starts at redemption and never ends. It replaces
  an existing grant of that role to the redeemer, unless that grant already
  gives the role now and forever, which is kept.

## Permissions

| Action | Root | Anyone signed in |
|--------|:----:|:----------------:|
| See own roles, redeem a voucher | ✓ | ✓ |
| Create, list or revoke **own API tokens** | ✓ | ✓ |
| Ask about **own** roles (`/api/me`, `/api/check`, `/api/roles`) | ✓ | ✓ |
| Ask about **another** identity's roles, global roles included | ✓ | — |
| List or see systems, their grants and vouchers | ✓ | — |
| Create, configure or delete systems; add or remove roles; register implications | ✓ | — |
| Grant or revoke roles, to addresses, domains or globally | ✓ | — |
| Create, list or disable vouchers (per system or global) | ✓ | — |
| See the root allow list (`/settings`) | ✓ | — |

- **P1** Only roots manage: everything but the first three rows is refused
  to anyone else with 403. Holding a role (any name) never grants
  management.
- **P2** Removing a role also revokes its grants, removes its implications,
  disables its vouchers and clears it as its system's subscriber role.
  Deleting a system does that for every role in it (L3).
- **P3** Grants and vouchers stay valid if the root who created them later
  leaves the root list.

## Vouchers

- **V1** A voucher has a code and a scope: one system, or **global**
  (`systemId: null`, roots only). It also has one or more **roles**
  (`roles`, sorted, at most 20; `role` is the first of them, for clients
  that predate several roles per voucher), a **discount**
  (`discountPercent`, a whole number from 0 to 100, default 100), an
  optional start date (`startsAt`), an optional end date (`endsAt`,
  exclusive) and an optional usage count (`maxUses` ≥ 1). It records its
  creator and its uses. If both dates are set, the start must come before
  the end. A system voucher's roles must be in that system's catalog. A
  global voucher's roles only have to be valid names other than `root`.
  Requests send `roles`, or a single `role` as before.
- **V2** A root may choose the code (`code`); without one, rbacr makes
  one up from the current calendar quarter (UTC) and three random animal
  names out of 256, e.g. `2026Q4-OTTER-FALCON-LEMUR` (24 random bits;
  redeeming needs a signed-in identity, V5). The pages suggest such a code
  and, as the validity, the current quarter: from its first day to the
  next quarter's first day. A code is stored upper case with any run of
  other characters as one dash, and needs 6 to 40 letters and digits.
  Codes are matched ignoring case and separators, so `spring sale` and
  `SPRING-SALE` are the same code, and they are unique: reusing one, even
  a disabled voucher's, gives 409. Vouchers made before codes could be
  chosen keep their `XXXX-XXXX-XXXX-XXXX` codes and still redeem.
- **V3** A voucher is `active` unless it is `disabled`, `not-started` (now <
  startsAt), `expired` (now ≥ endsAt) or `exhausted` (uses ≥ maxUses), checked
  in that order.
- **V4** Redeeming an active voucher with a **100% discount** grants each of
  its roles to the redeemer's address (G3) and increments `uses`. A system
  voucher creates grants in its system; a global voucher creates global
  grants. Redemption runs in one transaction with a row lock, so concurrent
  redemptions cannot exceed `maxUses`, and grants all the roles or none.
- **V4a** A voucher with a discount **below 100%** requires payment, which is
  *not implemented yet*. Redeeming it answers 402 with
  `{ error, payment: { code, systemId, roles, role, discountPercent } }`, and
  records nothing: no use, redemption or grant. Inactive vouchers report their
  status (V3/V5) before payment comes into it. When payment is implemented,
  a confirmed payment completes the redemption as in V4.
- **V5** Each identity can redeem a given voucher only once (409). Redeeming
  an inactive voucher fails with 409 and the reason. An unknown code gives 404.
- **V6** Disabling is permanent and records who did it (`disabledBy`, L1).
  Disabled vouchers stay listed for auditing, with their redemptions.

## Logical deletion

Nothing in rbacr is physically deleted, so every change can be audited.

- **L1** Deleting anything marks the record in place with when and by whom,
  and the record stays:

  | Action | Record | Marked with |
  |--------|--------|-------------|
  | Revoke a grant (system or global) | the grant | `revokedAt`, `revokedBy` |
  | Remove a role | the role | `removedAt`, `removedBy` |
  | Drop an implication (R7) | the implication | `removedAt`, `removedBy` |
  | Delete a system | the system | `deletedAt`, `deletedBy` |
  | Disable a voucher | the voucher | `disabledAt`, `disabledBy` |
  | Revoke an API token | the token | `revokedAt`, `revokedBy` |
  | Sign out | the session | `revokedAt`, `revokedBy` |

  `…By` is the acting root's (or the token or session owner's) address, or
  `stripe` for the subscription sync (Q3). Redemptions are never deleted.
  Expired tokens stay too; the main table has no TTL. The one exception is
  sessions: DynamoDB purges each one the retention period after it
  expires (S3).
- **L2** A record is deleted once its deletion date is set; rbacr then
  treats it as gone. A revoked grant gives no role and isn't listed; a
  removed role or implication, or a deleted system, isn't in the catalog
  or listings and can't be granted, configured or referenced (404);
  deleting it again gives 404; a revoked token or session no longer
  authenticates. Disabled vouchers and revoked tokens still appear in
  their own listings with their status (V6, T5), since those are their
  audit views.
- **L3** Removing a role or deleting a system marks its dependents with
  the same actor and time: the role's grants are revoked, its
  implications (both directions) removed and its vouchers (every voucher
  granting it, among other roles too) disabled.
  Deleting a system does that for every role, then marks the system.
  Global grants belong to no system and are not touched.
- **L4** A deleted name or key can be used again: granting a revoked grant
  again, redeeming a voucher over it, re-adding a removed role or
  implication, or re-creating a deleted system. The new record starts
  fresh (a re-created system has no grants or implications; its earlier
  vouchers stay listed, disabled, V6). Before it is
  written, the deleted record is copied to a history record (sort key
  `HIST#<original sort key>#<deletion date>`), so a deletion is never
  overwritten.
- **L5** Only deletions are kept this way. Replacing a grant with another
  validity (G2, G3, Q2a) updates it in place.

## Substack integration

Paying subscribers of the publisher's Substack newsletter
(prodbytes.substack.com) hold a role in rbacr while they pay: in each
system, the role its configuration names. Substack has no API or webhooks for subscribers (its developer API
only looks up public profiles), but its paid subscriptions are billed
through the publisher's own Stripe account, connected to Substack with
Stripe Connect. That account sends webhooks, so rbacr syncs from Stripe:

    Substack checkout -> publisher's Stripe account -> customer.subscription.* webhook
      -> POST /webhooks/stripe -> Stripe API (customer + subscriptions) -> grant or revoke

- **Q1** `POST /webhooks/stripe` receives that Stripe account's webhook
  events. It is outside both APIs and authenticated only by the
  `Stripe-Signature` header: an HMAC-SHA256 with the endpoint's signing
  secret (`RBACR_STRIPE_WEBHOOK_SECRET`), at most 300 seconds old. A bad or
  missing signature gives 400; without `RBACR_STRIPE_WEBHOOK_SECRET` and
  `RBACR_STRIPE_API_KEY` the sync is off and the endpoint answers 503.
- **Q2** Roots choose, per system, the role paying subscribers hold there:
  the system's `subscriberRole`, a role of its catalog (404 otherwise), or
  `null` for none, the default (`PATCH /api/systems/:id`). On every
  `customer.subscription.*` event, rbacr reads the customer and their
  current subscriptions from the Stripe API, so the result never depends
  on the order or repetition of events. A customer is **subscribed** while
  one of their subscriptions is `active`, `trialing` or `past_due` (Stripe's
  retry window). A subscribed customer's e-mail address gets, in every
  system with a subscriber role, a grant of that role. Its `grantedBy` is
  `stripe`. An existing grant of that role to
  that address that someone else made (a root or a voucher) is kept as it
  is, unless it has expired (G1), when the sync's grant replaces it.
- **Q2a** The sync's grant is valid for the subscription's current billing
  period: `startsAt` and `endsAt` are its `current_period_start` and
  `current_period_end` (read from the subscription items in Stripe API
  versions that keep them there). With several entitled subscriptions, the
  one whose period ends last counts. Each renewal is a
  `customer.subscription.updated` event, which moves the grant to the new
  period, so if no renewal comes, the role ends with the period that was
  paid for, even if the cancellation event is missed.
- **Q3** When the customer is no longer subscribed (canceled, unpaid,
  incomplete, paused, or deleted), rbacr revokes those grants (L1, with
  `revokedBy: stripe`), but only if their `grantedBy` is `stripe`: grants a root made, or that came from a
  voucher, stay. The same happens to the customer's `stripe` grants that
  no system's configuration asks for any more (the role changed, or was
  set to none), at their next event. The webhook answers
  `{ received, outcomes: [{ systemId, role, outcome }] }`, each outcome
  `granted`, `updated` (a new period), `revoked` or `unchanged`.
- **Q4** Other events, and customers without an e-mail address, are
  acknowledged (200) and change nothing. If Stripe or the database fails,
  the endpoint answers 500 and Stripe retries the event. Only the Stripe
  customer id is logged, never the address.
- **Q5** The subscriber must sign in with the same address they use on
  Substack: rbacr matches identities by e-mail only. Complimentary and gift
  subscriptions that Substack grants without a Stripe subscription are not
  seen; grant those by hand or with a voucher.

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
  404). Revoking is permanent (L1); revoked tokens stay listed. Tokens are managed
  only through `/vpi`, so a token can't mint more tokens.
- **T6** Role queries: `/api/check` and `/api/roles` answer with R1-R6.
  Anyone may ask about themselves. Roots may ask about anyone, global roles
  included. Anything else gives 403. An unknown system, or a role missing
  from its catalog, gives 404. Without a `systemId`, `/api/check` asks about
  a global role (such as `root`).
- **T7** Local development only: with `RBACR_BOOTSTRAP_TOKEN` and
  `RBACR_BOOTSTRAP_EMAIL` set, the app makes that token a live token of that
  address, named `bootstrap`, never expiring, the first time it reaches
  DynamoDB. It is chosen by the operator instead of generated (T2), so it
  must be `rbacr_` followed by at least 32 base64url characters, or the app
  doesn't start. It is idempotent: a token already stored, revoked included,
  is left as it is. It is refused unless `RBACR_DYNAMODB_ENDPOINT` is set
  (DynamoDB Local), so it can't exist in AWS. The dev server image
  (`prodbytes/rbacr-local`, README "Local rbacr for your app") uses it so
  apps call `/api` without signing in, taking `RBACR_TOKEN` (C7) when
  `RBACR_BOOTSTRAP_TOKEN` is unset, and else generating one.

## Client integration

How applications use rbacr. The README has a walkthrough with examples.

- **C1** rbacr does not authenticate an application's users. The application
  signs them in itself and asks rbacr about the verified e-mail address,
  server-side, with a personal API token (T1-T5). rbacr trusts the address
  it is given.
- **C2** A token sees what its owner may see (T6): a root's token, anyone's
  roles everywhere plus global roles; anyone else's, only their own.
  Applications that ask about their users need a root-owned token, so they
  should keep it server-side, give it an expiry and revoke it when unused.
- **C3** `POST /api/check` answers `allowed: true` exactly when the identity
  holds the role in the system as an effective role (R3, R6): through a
  grant valid now (G1) to its address or domain, a global grant, an
  implication, or root status (R2). A role the identity doesn't hold gives `allowed: false`. A
  system or role that doesn't exist gives 404, after the reach check (403).
- **C3a** When the answer is `allowed: true`, it also says how long it may
  be cached: `expiresAt`, the latest end (G1) among the grants valid now
  that give the role (directly, through its domain, globally or by
  implication), and `ttl`, the whole seconds left until then. Both are
  `null` when the role has no end: one of those grants never ends, or the
  identity is a root. A `false` answer has `expiresAt: null` and
  `ttl: null`. The TTL bounds the grants' validity only: revoking a grant,
  or changing implications, ends the role sooner (C6).
- **C4** `POST /api/roles` with a `systemId` returns the same effective
  roles as a sorted list; without one, every system's and the global roles.
  `GET /api/me` returns the token owner's own roles.
- **C5** E-mail addresses and role names are matched case-insensitively and
  returned lower-cased.
- **C6** A change to grants, implications or vouchers shows in these
  answers within about a second (D3). A revoked or expired token is refused
  at once (T3). Clients that cache answers should cache them briefly (a "yes"
  never beyond its `ttl`, C3a) and never cache errors, and should deny
  access when rbacr can't answer.
- **C7** rbacr's client libraries take their base URL from `RBACR_URL`
  (default `https://rbacr.nu01.com`) and their token from `RBACR_TOKEN`
  when the caller passes none. The local dev server (T7) takes the same
  `RBACR_TOKEN` as its bootstrap token, so one `.env` configures both. A
  client accepts plain `http` only for localhost.

## HTTP interface

### `/api`: the external API (personal API token, A1)

Errors are returned as
`{ "error": "message" }` with status 400 (invalid input), 401 (no valid token),
403 (forbidden), 404 (not found) or 409 (conflict, inactive or already
redeemed voucher), or 402 (the voucher needs payment, V4a). Dates are
ISO-8601 strings in UTC.

| Method & path | Body | Response |
|---------------|------|----------|
| `GET /api/me` | — | `{ email, root, globalRoles: ["root"] or [], roles: { systemId: [role] } }` |
| `POST /api/vouchers/redeem` | `{ code }` | the grant of the voucher's first role with `impliedRoles` (`systemId: null` and `impliedRolesBySystem` when global), plus `grants`: one per role (V4); or 402 (V4a) |
| `GET /api/vouchers` | — | `{ vouchers: [...] }`, the global vouchers (roots) |
| `POST /api/vouchers` | `{ roles (or role), code?, discountPercent?, startsAt?, endsAt?, maxUses? }` | 201, a global voucher (roots) |
| `GET /api/global-grants` | — | `{ grants: [{ systemId: null, role, grantee, grantedBy, grantedAt, startsAt, endsAt, status, voucherCode, impliedRoles: [], impliedRolesBySystem }] }` (roots, R8, G1) |
| `POST /api/global-grants` | `{ role, grantee, startsAt?, endsAt? }` | 201, the global grant, with `impliedRolesBySystem` (roots, G1, G2) |
| `DELETE /api/global-grants` | `{ role, grantee }` | 204 (roots; revokes it, L1) |
| `DELETE /api/vouchers/:code` | — | the disabled voucher, with `disabledBy` |
| `GET /api/systems` | — | `{ systems: [{ id, name, roles, implies: { role: [role] }, subscriberRole, everyone: [role], url, maintenance }] }` (only manageable systems; `implies` lists direct implications) |
| `POST /api/systems` | `{ id, name?, roles?: [string] }` | 201, the system with exactly the given roles (R4) |
| `GET /api/systems/:id` | — | `{ id, name, roles, implies, subscriberRole, everyone, url, maintenance }` |
| `PATCH /api/systems/:id` | `{ subscriberRole?: role or null, url?: URL or null, maintenance?: boolean }`, at least one | the system (roots, Q2, R10, R11) |
| `DELETE /api/systems/:id` | — | 204 (marks it and its contents deleted, L1, L3) |
| `POST /api/systems/:id/roles` | `{ role }` | the system |
| `DELETE /api/systems/:id/roles/:role` | — | 204 (removes it, L1, L3) |
| `PUT /api/systems/:id/roles/:role` | `{ implies?: [role], everyone?: boolean }`, at least one | the system, with the role's implied roles replaced (R7) and/or its `everyone` property set (R9) (roots) |
| `GET /api/systems/:id/grants` | — | `{ grants: [{ systemId, role, grantee, grantedBy, grantedAt, startsAt, endsAt, status, voucherCode, impliedRoles }] }` (R8, G1) |
| `POST /api/systems/:id/grants` | `{ role, grantee, startsAt?, endsAt? }` | 201, the grant with `impliedRoles` (G1; re-granting with the same validity is idempotent, G2) |
| `DELETE /api/systems/:id/grants` | `{ role, grantee }` | 204 (revokes it, L1) |
| `GET /api/systems/:id/vouchers` | — | `{ vouchers: [{ code, systemId, roles, role, discountPercent, startsAt, endsAt, maxUses, uses, status, createdBy, createdAt, disabledAt, disabledBy }] }` |
| `POST /api/systems/:id/vouchers` | `{ roles (or role), code?, discountPercent?, startsAt?, endsAt?, maxUses? }` | 201, the voucher |
| `POST /api/check` | `{ email, systemId?, role }` | `{ email, systemId, role, allowed, expiresAt, ttl }` (T6, C3a) |
| `POST /api/roles` | `{ email, systemId? }` | `{ email, systemId, roles: [role] }`, or without `systemId`, `{ email, globalRoles, roles: { systemId: [role] } }` (T6) |

`/api/check` and `/api/roles` are `POST` with a JSON body, so e-mail
addresses stay out of URLs and access logs.

### Outside both APIs

- **HC1** `GET /health` reports whether rbacr can serve, with no
  authentication. It and the Stripe webhook of the Substack integration (Q1) are the only JSON
  endpoints outside `/api` and `/vpi`. It
  answers `{ ok, version, checks: { google } }`, with
  `Cache-Control: no-store`. `google` is `ok` when the Google OAuth client is
  configured, else `missing`.
- **HC2** The status is 200 when every required check is `ok`, else 503.
  `google` is required, except under `vite dev`, which has the dev login
  (S4), and on DynamoDB Local (`RBACR_DYNAMODB_ENDPOINT`), where apps use a
  bootstrap token (T7). DynamoDB is deliberately not checked: it is a managed regional
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
(version, API address, account, and the root allow list for roots), `GET /vpi/me`,
`POST /vpi/me/redeem` (402 with `payment` per V4a), `GET|POST /vpi/tokens`,
`DELETE /vpi/tokens/:id`, `GET|POST /vpi/systems`,
`GET|PATCH|DELETE /vpi/systems/:id`, `POST /vpi/systems/:id/roles`,
`PUT|DELETE /vpi/systems/:id/roles/:role`, `POST|DELETE /vpi/systems/:id/grants`,
`POST /vpi/systems/:id/vouchers`, `DELETE /vpi/vouchers/:code`,
`GET /vpi/global`, `POST|DELETE /vpi/global/grants` and
`POST /vpi/global/vouchers`. They return the same errors as `/api`; a
missing session gives 401.

### Pages

`/` (sign in), `/me` (own roles, redeem a voucher, API tokens), `/settings`
(the running version, the API's address, the signed-in account; roots also
see the root allow list), `/systems`
(manageable systems; create one from its name alone, which also makes its
id), `/systems/:id` (its URL; its roles, each marked for everyone or not
and with the roles it implies, added and removed one at a time; grants;
vouchers) and `/global` (roots: global
grants and vouchers). Roles are always picked from those that exist,
never typed (except a new role's name): grant and subscriber forms offer a
list, voucher forms checkboxes, of the system's roles, or on `/global` of
every role some system has. Wherever a system's role names are printed
(the systems list, a system's page, `/me`), they link to the system's URL
in a new tab (R10); global roles belong to no one system and aren't
linked.
Pages load
through `/vpi`; a page whose data needs a session sends anonymous visitors
to `/`. The pages need JavaScript.

## Request hardening

- **H1** When `RBACR_ORIGIN_SECRET` is set, any request without that exact
  value in `x-rbacr-origin-secret` gets 403 before anything else runs (a
  constant-time comparison). In AWS, CloudFront adds the header, so calling
  the Lambda function URL directly is refused.
- **H2** In production builds, form submissions (`POST`/`PUT`/`PATCH`/`DELETE`
  with a form or plain-text body, or with no content type) whose `Origin` is
  missing or not the app's own (the request's origin or
  `RBACR_PUBLIC_ORIGIN`) get 403, except under `/api`, which takes bearer
  tokens only (A1) and so can't be forged from a browser: API clients send
  no `Origin`, and a body-less `DELETE` must reach the token check. rbacr
  applies this itself (src/lib/server/csrf.ts); SvelteKit's own check, which
  can't exempt a path, is off.

## Configuration

All settings come from environment variables prefixed `RBACR_`:

| Variable | Required | Purpose |
|----------|----------|---------|
| `RBACR_DYNAMODB_TABLE` | yes | The DynamoDB table holding all data but sessions (`rbacr`, `rbacr-rc`; `infra/tables.yaml`) |
| `RBACR_DYNAMODB_SESSIONS_TABLE` | no | The sessions table (S3); default `<RBACR_DYNAMODB_TABLE>-sessions` |
| `RBACR_SESSION_RETENTION_DAYS` | no | Whole days (1 or more) a session record is kept after it expires, then purged by TTL (S3); default 365. An invalid value stops the app from starting. In AWS it is the app stack's `SessionRetentionDays` parameter. |
| `RBACR_DYNAMODB_ENDPOINT` | no | DynamoDB Local's URL for development (e.g. `http://127.0.0.1:8642`); the app creates its table there. Unset in AWS. |
| `RBACR_BOOTSTRAP_TOKEN`, `RBACR_BOOTSTRAP_EMAIL` | no | A fixed API token and its owner, for local development only (T7). An invalid token stops the app from starting. |
| `RBACR_ROOT_LIST` | no (no roots if empty; in AWS the default is `@nu01.com`) | Root addresses and domains (R1, R1a) |
| `RBACR_GOOGLE_CLIENT_ID`, `RBACR_GOOGLE_CLIENT_SECRET` | for Google sign-in | OAuth web client. Without them `/login/google` returns 503. |
| `RBACR_PUBLIC_ORIGIN` | no | Origin for the Google redirect URI (`<origin>/login/google/callback`); default: the request's origin |
| `RBACR_ORIGIN_SECRET` | no | Required value of the `x-rbacr-origin-secret` header (H1) |
| `RBACR_VERSION` | no | Version reported by `/health` (default `dev`) |
| `RBACR_DEV_LOGIN` | no | `1` enables `/login/dev` under `vite dev` only (S4) |
| `RBACR_STRIPE_WEBHOOK_SECRET`, `RBACR_STRIPE_API_KEY` | for the subscription sync | The webhook endpoint's signing secret and a restricted key that reads Customers and Subscriptions (Q1, Q2) |

## Runtime and storage

- SvelteKit with `@sveltejs/adapter-node`. `lambda.js` wraps the built handler
  with `serverless-http` for AWS Lambda. Lambda runs behind a function URL
  fronted by CloudFront ([infra/app.yaml](infra/app.yaml)). The request's
  host comes from the `x-rbacr-host` header (adapter-node's `HOST_HEADER`),
  which CloudFront sets, and the protocol is assumed to be `https`.
- DynamoDB: two on-demand tables per stage ([infra/tables.yaml](infra/tables.yaml)),
  the main one and `<name>-sessions` (S3),
  on DynamoDB Local in development ([compose.yaml](compose.yaml)) and in the
  unit tests. The item layout is documented in
  [src/lib/server/rbac.ts](src/lib/server/rbac.ts); it needs no migrations.
- Locally, the [Containerfile](Containerfile) runs the same adapter-node
  build (not `vite dev`) on DynamoDB Local in one container, with a
  bootstrap token (T7), so apps develop against the production code paths.
- **D1** Writes that must not race are single DynamoDB transactions with
  conditions: a grant, voucher or implication checks that its role still
  exists; redeeming counts the use (within `maxUses`), records the
  redemption (once per identity) and grants, all or nothing; concurrent
  implication edits are serialized by a version on the system.
- **D2** Removing a role marks the role first, so nothing new can attach
  meanwhile (grants, implications and vouchers check that their role is
  not removed), then marks its dependents (L3). Deleting a system marks its
  dependents first and the system last, so a failed deletion leaves it
  listed and can be retried. Neither is atomic.
- **D3** Lookups across partitions (an identity's roles, a person's tokens,
  a system's vouchers) use a secondary index, which is eventually
  consistent: a change can take up to about a second to show there.

## Tests

| Suite | Command | Covers |
|-------|---------|--------|
| Unit and domain | `npx vitest --run` | Identity parsing, the R*, G*, P*, V*, Q*, T*, L* and D* rules against DynamoDB Local (a Docker container started by the test setup, or `RBACR_TEST_DYNAMODB_ENDPOINT`), the A3 guard, sessions, Google OAuth exchange |
| Lambda smoke | `npm run test:lambda` | The production build invoked through `lambda.js` with function URL (v2) events: H1, H2, A1, A3 and the Stripe webhook's signature check (Q1), the version, redirects, 401s, static assets. `scripts/package-lambda.sh` reruns it against the deployable bundle. |
| End-to-end | `npm run test:e2e` | `/api` with personal tokens, `/vpi` as the frontend, the A1/A3 separation, and the pages, against a running dev server with DynamoDB Local, directly or through Floci over HTTPS |
| Live | `scripts/deploy.sh` (last step) | The deployed site: version, sign-in page, 401 (also for an unknown token, which reads DynamoDB), 404 for `/login/dev`, 403 for the bare function URL |

`npm test` runs the first two.
