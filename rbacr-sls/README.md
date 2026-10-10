# rbacr-sls

The rbacr service. A role manager for your applications. Users sign in with Google. rbacr records
which roles each identity (e-mail address or whole domain) holds in each
system, and serves them both as web pages and as JSON. It runs as a SvelteKit
app on AWS Lambda. Run every command below from this folder
(`rbacr-sls/`).

## How it works

- **Roots** are listed in `RBACR_ROOT_LIST`, as addresses or domains
  (`@nu01.com` means everyone at nu01.com). They hold the single global
  `root` role and every role in every system. The list is the only way to
  become a root: `root` can't be granted or redeemed. `root` is the only
  built-in role, and roots alone manage rbacr: they create systems and
  roles, grant roles to addresses, domains or globally, and issue vouchers.
- **Roles and implied roles are registered data.** A system has exactly the
  roles a root registers (no role name but `root` means anything, so a role
  called `admin` has no powers). A root also registers which roles imply
  others, e.g. `admin` implies `premium` and `free`, `premium` implies
  `free`, and `free` implies nothing. Implication is transitive. Grants
  returned by the API list the roles they imply (`impliedRoles`).
- **Roles for everyone.** A role marked *all users* on its system's page
  (e.g. `free`) is held by every identity, signed in or asked about, with
  what it implies; no grant per person needed.
- **System URLs.** A system can have a URL; role names on the pages link to
  it in a new tab, so you can follow a role into its system.
- **System cards.** A system can have a description and a screenshot (an
  image URL), set on its page; until it has a screenshot, the card shows
  a cover generated from what the system is for (its name and
  description). People see each system they hold roles in
  as a card, with a link into it, on `/me` and after redeeming a voucher.
- **Maintenance mode.** Switched on from a system's page, the API gives
  nobody any role in that system (empty lists, every check denied, roots
  included) while you fix its application. Grants are kept and count
  again as soon as it's off. Any API token can read a system's status
  (`GET /api/systems/:id/status`), so applications can tell.
- **Grants have a validity**: an optional start and end (`startsAt`,
  `endsAt`). No start means immediately, no end means forever. Outside it a
  grant gives nothing, and shows as `not-started` or `expired`.
- **Nothing is ever deleted.** Revoking a grant, removing a role, deleting a
  system, disabling a voucher, revoking a token or signing out marks the
  record with who did it and when (e.g. `revokedBy`, `revokedAt`), and
  rbacr hides it from then on, so every change can be audited. Only
  sign-in sessions are purged, a year (configurable) after they expire.
- **Vouchers** are codes like `2026Q4-OTTER-FALCON-LEMUR` that grant one or
  more roles when redeemed, either in one system or **globally**. A global
  voucher grants roles you pick from any systems (say `premium` in
  `presence` and in `tabscan`), each in its own system. The voucher
  forms offer the existing roles as checkboxes and suggest a code (the
  quarter plus random animals, or type your own, e.g. `SPRING-SALE`) valid
  through the current quarter; codes ignore case and separators. Each
  voucher has a **discount**: a 100% voucher grants its roles immediately,
  while a lower discount will require payment (not built yet; it answers 402
  Payment Required). The start date, end date and usage count are all
  optional. Each voucher in a list has a **Copy link** button: the link
  (`/redeem/<code>`) asks whoever opens it to sign in if they aren't,
  redeems the voucher and shows the roles it granted, with cards for the
  systems they open. Every redemption is kept as a **RedeemEvent** (who, when, from
  the API or the page, and what it did to each role); open a voucher's
  uses on its page to see them, or `GET /api/vouchers/:code/redemptions`.
  Failed attempts (unknown code, expired, used up, already redeemed, needs
  payment) are kept too, as **RedeemFailures**: under the voucher's uses,
  the latest on `/notifications`, or `GET /api/vouchers/:code/failures` and
  `GET /api/redeem-failures`.
- **Notifications** warn roots about things that need attention, on
  `/notifications` (the navigation shows how many are open). rbacr checks
  each time a root signs in, or on demand from that page. For now it warns
  when a voucher ends within a week and no other voucher of the same
  system (or global) takes over its roles, valid from when it ends and
  ending later. A warning clears itself once its cause is gone; a root
  can also dismiss it for everyone.
- **Everyone** can sign in, see their own roles at `/me` and redeem vouchers.
  `/settings` shows the running version and the API's address; roots also
  see the root allow list there.
- **API tokens** let scripts and other applications call rbacr as a person.
  Anyone creates their own on `/global`. A token can do what its owner can do;
  for example, a root's token can ask whether anyone holds a role.
- **Apps can call rbacr as their users.** An app that signs its users in
  with Google can send the user's Google ID token instead of an API token,
  straight from the app (web, Android, iOS), for the user's own roles, a
  system's status and redeeming vouchers, and nothing else, not even for
  a root. See [Apps calling rbacr as their users](#apps-calling-rbacr-as-their-users).

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
| `RBACR_DYNAMODB_SESSIONS_TABLE` | no | The table holding sign-in sessions (default `<RBACR_DYNAMODB_TABLE>-sessions`; in AWS `rbacr-sessions`, `rbacr-rc-sessions`) |
| `RBACR_SESSION_RETENTION_DAYS` | no | Days a session record is kept after it expires before DynamoDB's TTL purges it (default 365). In AWS, set it for `scripts/deploy.sh` (the stack's `SessionRetentionDays`). |
| `RBACR_DYNAMODB_ENDPOINT` | no | DynamoDB Local's URL in development (process-compose sets `http://127.0.0.1:8642`); the app creates the tables there |
| `RBACR_BOOTSTRAP_TOKEN` / `RBACR_BOOTSTRAP_EMAIL` | no | Local only (needs `RBACR_DYNAMODB_ENDPOINT`): a fixed API token (`rbacr_` + 32 or more base64url characters) made live for that address, see [Local rbacr for your app](#local-rbacr-for-your-app) |
| `RBACR_ROOT_LIST` | no | Comma-separated root addresses and/or domains, e.g. `ana@example.com, @example.org`: the only way to be a root. An invalid entry stops the app from starting. In AWS it defaults to `@nu01.com`. |
| `RBACR_GOOGLE_CLIENT_ID` / `RBACR_GOOGLE_CLIENT_SECRET` | for sign-in | Google OAuth web client |
| `RBACR_GOOGLE_AUDIENCES` | no | Comma-separated Google OAuth client ids whose users' ID tokens `/api` accepts on its self-service routes; empty turns it off. See [Apps calling rbacr as their users](#apps-calling-rbacr-as-their-users). In AWS, the `RBACR_GA_GOOGLE_AUDIENCES` / `RBACR_RC_GOOGLE_AUDIENCES` repository variables. |
| `RBACR_CORS_ORIGINS` | no | Comma-separated web origins (exact, e.g. `https://app.example.com`) allowed to call `/api` from the browser; empty: no CORS. In AWS, `RBACR_GA_CORS_ORIGINS` / `RBACR_RC_CORS_ORIGINS`. |
| `RBACR_PUBLIC_ORIGIN` | no | The origin users browse, used for the Google redirect URI (default: the request's origin) |
| `RBACR_ORIGIN_SECRET` | no | When set, every request must carry it in `x-rbacr-origin-secret`. In AWS, CloudFront adds it, so the Lambda URL can't be called directly. |
| `RBACR_VERSION` | no | The release version, reported by `/health` (default `dev`) |
| `RBACR_DEV_LOGIN` | no | `1` enables `/login/dev` under `vite dev` |
| `RBACR_STRIPE_WEBHOOK_SECRET` / `RBACR_STRIPE_API_KEY` | for the Substack sync | Stripe webhook signing secret (`whsec_…`) and restricted key (`rk_…`), see [Substack integration](#substack-integration) |

## Local rbacr for your app

To develop an application against rbacr without touching the production
service, run the **rbacr dev server**: the image
[`prodbytes/rbacr-local`](https://hub.docker.com/r/prodbytes/rbacr-local)
(linux/amd64 and linux/arm64). It runs the production server (the same
build Lambda runs, not `vite dev`) on DynamoDB Local, in one container with
no shell, as a non-root user. It serves the same `/api` as production on
**http://localhost:8686**, so clients only change their URL and token. It
is for development only and is never deployed.

### 1. One `.env` for rbacr and your app

Put the two client settings in your app project's `.env`. The dev server
reads the same file, so the token your app sends is the token rbacr
accepts:

```bash
# .env in your app's project (comments on their own lines: docker --env-file keeps inline ones)
RBACR_URL=http://localhost:8686
# generate one: node -e "console.log('rbacr_'+require('crypto').randomBytes(32).toString('base64url'))"
RBACR_TOKEN=rbacr_…
```

Without `RBACR_TOKEN`, the dev server generates a token on first start,
keeps it in its volume and prints it on every start
(`rbacr: API token of dev@rbacr.local: rbacr_…`). Copy it into `.env`.

### 2. Start the dev server

Pick one. Data and the token live in the `rbacr-data` volume, which all
three share, and survive restarts. The port is published on 127.0.0.1 only.

**docker run** (or `podman run`):

```bash
docker run -d --name rbacr-local -p 127.0.0.1:8686:8686 \
  --env-file .env -v rbacr-data:/data prodbytes/rbacr-local
docker logs rbacr-local
```

**Docker Compose**: copy [container/compose.yaml](container/compose.yaml)
next to your `.env`, or merge its `rbacr` service and `rbacr-data` volume
into your compose file. Compose reads `.env` itself. The service reports
healthy once rbacr answers.

```bash
docker compose up -d rbacr
```

**process-compose** (and `devbox services up`): copy the `rbacr` process
from [container/process-compose.yaml](container/process-compose.yaml) into
your `process-compose.yaml`, and make your app wait for it:

```yaml
processes:
  my-app:
    depends_on:
      rbacr:
        condition: process_healthy
```

### 3. Set up your system

Signing in to the UI needs Google credentials, so set up with the root
token over `/api` instead (any call from
[Using rbacr from your application](#using-rbacr-from-your-application)
works):

```bash
set -a; . ./.env; set +a
curl -X POST "$RBACR_URL/api/systems" -H "authorization: Bearer $RBACR_TOKEN" \
  -H 'content-type: application/json' -d '{"id":"presence","roles":["free","premium"]}'
curl -X POST "$RBACR_URL/api/systems/presence/grants" -H "authorization: Bearer $RBACR_TOKEN" \
  -H 'content-type: application/json' -d '{"role":"premium","grantee":"ana@example.com"}'
```

### 4. Point your clients at it

rbacr's client libraries read `RBACR_URL` and `RBACR_TOKEN` by default,
falling back to production when `RBACR_URL` is unset. With
[rbacr-flutter](../rbacr-flutter/README.md#against-a-local-rbacr),
`RbacrClient()` with no arguments uses them: from `--dart-define-from-file=.env`
in Flutter apps, or from the environment in Dart servers and tests.

### Variables

Client settings (your app, the compose files and the curl calls above):

| Variable | Default | Purpose |
|----------|---------|---------|
| `RBACR_URL` | `https://rbacr.nu01.com` | rbacr's base URL; `http://localhost:8686` for the dev server. Plain `http` is accepted only for localhost. |
| `RBACR_TOKEN` | — | The API token clients send. The dev server makes it a live root token for `RBACR_BOOTSTRAP_EMAIL` (SPEC T7). |
| `RBACR_PORT` | `8686` | Host port the compose files publish rbacr on (change `RBACR_URL` to match) |

Dev server settings (pass with `-e`, `--env-file` or the compose files):

| Variable | Default in the image | Purpose |
|----------|----------------------|---------|
| `RBACR_TOKEN` / `RBACR_BOOTSTRAP_TOKEN` | generated, kept in `/data` | The bootstrap token (`rbacr_` + 32 or more base64url characters). `RBACR_BOOTSTRAP_TOKEN` wins when both are set. An invalid one stops the server. |
| `RBACR_BOOTSTRAP_EMAIL` | `dev@rbacr.local` | Owner of the bootstrap token |
| `RBACR_ROOT_LIST` | `dev@rbacr.local` | Roots (addresses and/or domains). Keep the token's owner in it for a root token. |
| `PORT` | `8686` | Port inside the container |
| `RBACR_DYNAMODB_TABLE` | `rbacr` | Table name in DynamoDB Local (the sessions table is `<name>-sessions`) |
| `RBACR_VERSION` | `local` | Version reported by `/health` |
| `RBACR_GOOGLE_CLIENT_ID` / `RBACR_GOOGLE_CLIENT_SECRET`, `RBACR_GOOGLE_AUDIENCES`, `RBACR_CORS_ORIGINS`, `RBACR_PUBLIC_ORIGIN`, `RBACR_SESSION_RETENTION_DAYS`, `RBACR_STRIPE_*` | unset | As in [Configuration](#configuration), for the UI's sign-in or the Substack sync |

`RBACR_DYNAMODB_ENDPOINT` is set by the container (its own DynamoDB Local
on port 8000, not published). `RBACR_DEV_LOGIN` has no effect: it is a
production build.

### Build or publish the image

```bash
docker build -t prodbytes/rbacr-local -f Containerfile .   # from rbacr-sls/
scripts/push-local-image.sh                                 # amd64 + arm64 to Docker Hub as :latest and :X.Y.Z; needs docker login
```

The [Containerfile](Containerfile) builds the app with `npm ci` and
`npm run build`, then copies only the build, the runtime dependencies,
DynamoDB Local and a Java runtime trimmed with `jlink` onto
`gcr.io/distroless/nodejs24-debian12:nonroot`.
[container/start.mjs](container/start.mjs) starts DynamoDB Local, sets up
the bootstrap token, then starts the server.

## Using rbacr from your application

rbacr answers one question for your applications: **which roles does this
person hold in my system?** It doesn't sign your users in. Your application
authenticates its users itself (typically with Google), then asks rbacr
about the verified e-mail address, server-side, with an API token.

### 1. Set up your system (once, in the UI)

1. A root creates the system on `/systems` (its id is what your code sends
   as `systemId`, e.g. `presence`) and registers its roles (e.g. `admin`,
   `premium`, `free`). A system has no roles until a root registers them.
2. Optionally, a root registers **implied roles** (`admin` implies
   `premium` and `free`, `premium` implies `free`), so your code can ask
   for the role a feature needs and anyone with a higher role passes too.
3. A root grants roles to addresses, whole domains or globally, or hands
   out vouchers that people redeem on `/me` or by opening the voucher's
   link.

### 2. Create a token for your application

Sign in as a root, open `/global` → **API tokens**, create one with an expiry,
and store it as a server-side secret (it's shown once). A token acts as the
person who created it, with their status at the time of each request:

| Token owner | Can ask about |
|---|---|
| A **root** | anyone's roles in every system, and global roles |
| Anyone else | only themselves (`/api/me`, or their own address) |

An application asking about its users therefore needs a root's token: keep
it server-side only, give it an expiry, and revoke it on `/global` when it's no
longer needed (a revoked or expired token gets 401 at once). A token from
someone who leaves the root list stops being able to ask about others.

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
# {"email":"ana@example.com","systemId":"presence","role":"premium","allowed":true,"expiresAt":"2026-11-10T08:00:00.000Z","ttl":2592000}
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

**Check your system's status**, e.g. to show "down for maintenance"
instead of "you don't have access". Any token may ask, not only a root's:

```bash
curl -H "Authorization: Bearer $RBACR_TOKEN" https://rbacr.nu01.com/api/systems/presence/status
# {"id":"presence","name":"Presence","url":"https://presence.example.com","maintenance":false}
```

While `maintenance` is `true`, every role check in that system answers no.

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
  roles imply, as registered. Roots (`RBACR_ROOT_LIST`) hold every role of
  every system. Grants returned by
  the API carry `impliedRoles`, e.g. granting `premium` returns
  `"impliedRoles": ["free"]`.
- **E-mail addresses** are matched case-insensitively. Send the address
  your sign-in verified; rbacr trusts what you send.
- **`allowed: false`** means the person doesn't hold the role. A role or
  system that doesn't exist is a 404, not `false`, so typos surface (a
  non-root token asking about someone else gets 403 first).
- **`allowed: true` says how long it holds**: `expiresAt` and `ttl`
  (seconds) mark when the grants giving the role end, e.g. a subscriber's
  billing period. Both are `null` when the role has no end date. Never
  cache a "yes" beyond its `ttl`; revoking a grant can end it sooner.
- **Fresh within about a second.** A grant or revocation can take up to a
  second to show (SPEC D3). If you cache answers, keep it short (a minute
  or less, and within the `ttl`) and never cache errors.
- **Errors** are JSON `{ "error": "…" }`: 400 bad input, 401 missing,
  revoked or expired token (with `WWW-Authenticate: Bearer`), 403 asking
  beyond the token owner's reach, 404 unknown system or role. Fail closed:
  deny access when rbacr can't answer.

### Apps calling rbacr as their users

An app that signs its users in with Google (e.g. Flutter on the web,
Android and iOS) can call rbacr **as the signed-in user**, straight from
the app, with the Google ID token it already has: no API token to create,
store or ship. It sends `Authorization: Bearer <ID token>` to these
self-service routes only (SPEC I4):

| Route | For |
|-------|-----|
| `GET /api/me` | the user's own roles |
| `POST /api/roles`, `POST /api/check` | the user's own address only |
| `GET /api/systems/:id/status` | maintenance (R12) |
| `POST /api/vouchers/redeem` | redeeming a voucher for the user |

Every other `/api` route answers 403 to an ID token, even when the user is
a root: managing rbacr always takes a personal API token. rbacr checks the
token's Google signature, issuer, expiry and verified e-mail, and that it
was issued to one of the app's OAuth clients (SPEC I2).
[rbacr-flutter](../rbacr-flutter/README.md#your-users-google-id-token)
takes the ID token from its `tokenProvider`.

To let an app do this, a root adds to the stage's settings (the
`RBACR_GA_*` / `RBACR_RC_*` repository variables, then a deploy; locally,
`.env`):

1. **Its Google OAuth client ids** to `RBACR_GOOGLE_AUDIENCES`,
   comma-separated. On Android and iOS, Google Sign-In issues the ID token
   to the **web** client id the app passes as `serverClientId`, so list the
   web client id, plus the Android and iOS client ids if the app ever gets
   tokens issued to them. List only your own apps' clients: any listed
   client's users can act as themselves on every system's self-service
   routes (SPEC I6).
2. **Its web origins** to `RBACR_CORS_ORIGINS`, comma-separated and exact
   (scheme, host and port), when it runs in a browser (Flutter web), e.g.
   `https://presence.nu01.com,https://rc.presence.nu01.com,http://localhost:8080`.
   Listed origins get CORS headers on `/api` (errors included) and their
   preflights answered for the routes above; other origins get none
   (SPEC H3, H4). Native apps don't need it.

```bash
gh variable set RBACR_RC_GOOGLE_AUDIENCES --body "<web client id>,<android client id>,<ios client id>"
gh variable set RBACR_RC_CORS_ORIGINS --body "https://rc.presence.nu01.com,http://localhost:8080"
```

### The two interfaces

| | `/api`: the API (external) | `/vpi`: the VPI (view programming interface, frontend only) |
|---|---|---|
| For | scripts and other applications | rbacr's own pages |
| Auth | personal API token, `Authorization: Bearer rbacr_…`; an app's Google ID token on the self-service routes | the browser session cookie |
| Contract | stable, documented in [SPEC.md](SPEC.md#api-the-external-api-personal-api-token-a1) | shaped for the pages, may change |

Every `/api` request, unknown paths included, needs a valid personal API
token (401 otherwise), and `/api` ignores the session cookie. Besides role
queries, it can manage systems, grants and vouchers within the token
owner's permissions ([SPEC.md](SPEC.md#permissions)). `/vpi` refuses
anything that isn't a same-origin request from rbacr's pages (403). The only
unauthenticated JSON endpoint is `GET /health` (SPEC HC1-HC3), which a
Route 53 health check polls in AWS.

## Substack integration

Paying subscribers of the Substack newsletter (prodbytes.substack.com)
automatically hold a role while they pay: in each system, the one you
choose on its page ("Substack subscribers"). Substack has no subscriber
API or webhooks, but paid subscriptions are billed through your own Stripe
account, so rbacr listens to Stripe instead (SPEC "Substack integration",
Q1-Q5):

1. Someone subscribes, renews, cancels or stops paying on Substack.
2. Stripe sends a `customer.subscription.*` webhook to
   `https://rbacr.nu01.com/webhooks/stripe`, signed with the endpoint's
   secret.
3. rbacr reads that customer from the Stripe API. While they have an
   `active`, `trialing` or `past_due` subscription, their e-mail address
   holds each system's subscriber role for the subscription's current
   billing period: the grant starts and ends with
   it, and each renewal moves it to the next period. Otherwise rbacr
   revokes the grants (`revokedBy: stripe`). They show `grantedBy: stripe`, and grants you
   made by hand or through a voucher are never changed or removed (unless
   they have expired). Changing a system's subscriber role moves each
   subscriber over at their next subscription event.

### Setting it up

1. In the Stripe account connected to Substack (Substack → Settings →
   Payments shows which), create a **restricted key** (Developers → API
   keys) with *Read* on Customers and Subscriptions and nothing else.
2. Add a **webhook endpoint** (Developers → Webhooks):
   `https://rbacr.nu01.com/webhooks/stripe` (RC:
   `https://rc.rbacr.nu01.com/webhooks/stripe`), with the events
   `customer.subscription.created`, `.updated`, `.deleted`, `.paused` and
   `.resumed`. Copy its signing secret.
3. Store both as GitHub secrets, then deploy:

   ```sh
   gh secret set RBACR_GA_STRIPE_API_KEY          # rk_…
   gh secret set RBACR_GA_STRIPE_WEBHOOK_SECRET   # whsec_…
   ```

   (`RBACR_RC_STRIPE_*` for RC; for manual deploys, the `RBACR_STRIPE_*`
   lines in `.env.prod`.)
4. On each system's page, choose the role subscribers hold under
   **Substack subscribers** (or `PATCH /api/systems/:id` with
   `{ "subscriberRole": "premium" }`). Systems set to none grant nothing.
5. Check it: in Stripe, send a test `customer.subscription.updated` event to
   the endpoint. The response is `{ received, outcomes }`, one per system
   role, each `granted`, `updated`, `revoked` or `unchanged`. Without the secrets the endpoint answers 503;
   with a wrong signing secret, 400.

### Limitations

- Subscribers must sign in to rbacr with the address they use on Substack.
- Existing subscribers are picked up at their next subscription change
  (each renewal counts), so annual subscribers can take up to a year.
- Complimentary and gift subscriptions bypass Stripe: grant those by hand
  (with an end date to match the gift) or with a voucher.
- The role ends exactly at the end of the paid period. Renewing moves it
  on when Stripe's `customer.subscription.updated` event arrives, usually
  within seconds; until then (or while Stripe retries a failed delivery)
  the subscriber doesn't hold it.
- Every subscription in the Stripe account counts, so anything else sold
  through it also earns the role.

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

The tags trigger the [Release](../.github/workflows/release.yml),
[Deploy RC](../.github/workflows/deploy-rc.yml) and
[Deploy](../.github/workflows/deploy.yml) workflows. They deploy through
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
src/lib/server/stripe.ts        Stripe webhook signature and subscriber lookup (Substack sync)
src/lib/server/vpiguard.ts      the "frontend only" check for /vpi
src/lib/vpi.ts                  the pages' /vpi client
src/lib/server/identity.ts      e-mail/domain parsing, root allow list
src/lib/server/dynamo.ts        the DynamoDB table: definition, client, query helpers
src/lib/server/{session,google,auth}.ts  sign-in and sessions
src/routes/api/**               external API (tokens)
src/routes/vpi/**               VPI (session, frontend only)
src/routes/webhooks/stripe/     Stripe webhook (signature, not token or session)
src/routes/{me,systems,global}/**  UI pages (load and change data through /vpi)
lambda.js                       Lambda entrypoint (serverless-http + adapter-node)
Containerfile, container/       the dev server image for app development (adapter-node on DynamoDB Local), its compose files
infra/                          CloudFormation: zone, deploy roles, artifacts, app
floci/                          local CloudFront (HTTPS) on Floci
scripts/                        release, deploy, packaging, dev server image, local certs, health check
../.github/workflows/           Release, Deploy RC, Deploy (at the repository root)
tests/                          Lambda smoke test and end-to-end suite
```

## Dev container

The repository's dev container is described in the [top-level README](../README.md#dev-container).
