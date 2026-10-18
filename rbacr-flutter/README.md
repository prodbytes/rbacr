# rbacr-flutter

A Dart client for [rbacr](../README.md), for Flutter apps (and Dart
servers) that ask which roles their users hold, instead of calling rbacr's
HTTP API by hand. It wraps the external API (`/api`) of
[rbacr-sls](../rbacr-sls/README.md), whose [SPEC.md](../rbacr-sls/SPEC.md)
defines every answer.

It is a pure Dart package (only `package:http`), so it works in Flutter on
Android, iOS, desktop and the web, and in Dart backends. **On Flutter
web**, the browser lets the app call rbacr only when the app's origin
(e.g. `https://presence.nu01.com`) is in rbacr's `RBACR_CORS_ORIGINS`
([rbacr-sls: Apps calling rbacr as their users](../rbacr-sls/README.md#apps-calling-rbacr-as-their-users));
from any other origin the calls fail as unreachable.

## Add it

The package is named `rbacr` and isn't on pub.dev; depend on it from this
repository:

```yaml
dependencies:
  rbacr:
    git:
      url: https://github.com/prodbytes/rbacr.git
      path: rbacr-flutter
      ref: <commit>   # pin a reviewed commit of main; update deliberately
```

Pin `ref` to a commit: without it, every `flutter pub upgrade` takes
whatever `main` holds, and the lockfile is the only thing standing between
your app and an unreviewed change.

## Use it

```dart
import 'package:rbacr/rbacr.dart';

final rbacr = RbacrClient(
  // RBACR_URL, else https://rbacr.nu01.com; RbacrClient.releaseCandidate for RC.
  tokenProvider: () => secureStorage.read('rbacr_token'),
);

// Fails closed: any error, or no answer, is "no" (SPEC C6).
if (await rbacr.allows(email: user.email, systemId: 'presence', role: 'premium')) {
  showPremium();
}

// The full answer, with how long a "yes" holds (SPEC C3a).
final answer = await rbacr.check(email: user.email, systemId: 'presence', role: 'premium');
answer.allowed;   // true
answer.expiresAt; // when the grants giving the role end, e.g. the billing period; null: never
answer.ttl;       // the same as a Duration from now; the client never keeps the "yes" longer

// Any token may read a system's status (SPEC R12): in maintenance (R11),
// every check answers no, so show "down for maintenance" instead of "no access".
final status = await rbacr.systemStatus('presence');
if (status.maintenance) showMaintenance(status.name);

final me = await rbacr.me();                        // the token owner's own roles
final roles = await rbacr.rolesIn(email: user.email, systemId: 'presence');
final grant = await rbacr.redeemVoucher('2026Q4-OTTER-FALCON-LEMUR'); // its first role
final grants = await rbacr.redeemVoucherGrants('spring sale');          // one per role

// Voucher management, with a root's token on your server (see Tokens).
final admin = RbacrClient(tokenProvider: () => serverSecrets.read('rbacr_root_token'));
final voucher = await admin.createVoucher(systemId: 'presence', roles: ['premium'], maxUses: 100);
final sale = await admin.createVoucher(systemId: 'presence', roles: ['free', 'premium'], code: 'SPRING-SALE');
// No system: a global voucher, granting roles picked from any systems, each in its own.
final bundle = await admin.createVoucher(grants: [SystemRole('presence', 'premium'), SystemRole('tabscan', 'premium')]);
final vouchers = await admin.listVouchers(systemId: 'presence'); // newest first; none: global ones
await admin.disableVoucher(voucher.code); // DELETE: disabled for good (disabledBy), still listed
```

| Method | rbacr endpoint | Returns | Kept (see below) |
|--------|----------------|---------|---|
| `me({fresh})` | `GET /api/me` | `Me`: email, root, global roles, roles per system | `cacheDuration` |
| `check(email, systemId?, role, {fresh})` | `POST /api/check` | `RoleCheck`: `allowed`, `expiresAt`, `ttl` | a "yes" `cacheDuration` but never past its `ttl`; a "no" `negativeCacheDuration` |
| `allows(email, systemId?, role, {fresh})` | `POST /api/check` | `bool`, `false` on any error | as `check` |
| `systemStatus(systemId, {fresh})` | `GET /api/systems/:id/status` | `SystemStatus`: id, name, url, `maintenance` (any token) | `negativeCacheDuration` |
| `systems()` | `GET /api/systems` | a `SystemStatus` per system (roots; others get none) | no |
| `rolesIn(email, systemId, {fresh})` | `POST /api/roles` | the effective roles, sorted | roles: `cacheDuration`; none: `negativeCacheDuration` |
| `allRoles(email, {fresh})` | `POST /api/roles` | `AllRoles`: global roles and roles per system | as `rolesIn` |
| `redeemVoucher(code)` | `POST /api/vouchers/redeem` | the `Grant` of its first role |
| `redeemVoucherGrants(code)` | `POST /api/vouchers/redeem` | a `Grant` per role |
| `createVoucher(systemId?, grants (global only), roles or role, code?, discountPercent?, startsAt?, endsAt?, maxUses?)` | `POST /api/systems/:id/vouchers`, or `POST /api/vouchers` without a system | the `Voucher` (roots) |
| `listVouchers(systemId?)` | `GET /api/systems/:id/vouchers`, or `GET /api/vouchers` | the `Voucher`s, newest first (roots) |
| `listRedemptions(code)` | `GET /api/vouchers/:code/redemptions` | the `RedeemEvent`s, newest first (roots) |
| `listRedeemFailures({code})` | `GET /api/vouchers/:code/failures`, or without `code` `GET /api/redeem-failures` | the `RedeemFailure`s (failed attempts, V9), newest first (roots) |
| `disableVoucher(code)` | `DELETE /api/vouchers/:code` | the disabled `Voucher` (roots) |

Errors are `RbacrException`s with rbacr's message and `statusCode`
(`isUnauthorized`, `isForbidden`, `isNotFound`, `isTooManyRequests`, …),
or no status when rbacr couldn't be reached or timed out (10 s by default).
A voucher that needs payment throws `RbacrPaymentRequired` with its
`payment` terms.

## Kept answers

So that an app doesn't ask rbacr on every screen, the questions about
roles and status keep their answers in memory, per caller (the identity in
the token) and question:

| Option | Default | |
|---|---|---|
| `cacheDuration` | 1 hour | how long an answer that grants something is kept; a "yes" never past the `ttl` rbacr sends with it (SPEC C3a). `Duration.zero` keeps nothing. |
| `negativeCacheDuration` | 5 minutes | a "no", an empty role list and a system's status, so a role just bought or granted, or maintenance, shows soon |
| `retryDelays` | 1 s, 3 s | the waits before asking again when rbacr can't be reached, is slow, or answers 5xx or 429 (4xx answers are final) |
| `maxCacheEntries` | 1000 | the most answers kept; the oldest go first |

- **Refreshed before they expire.** In the last fifth of its life a kept
  answer is still returned at once and refreshed in the background (a
  failed refresh keeps it, and is tried again 30 s later at the earliest).
  A question with no kept answer is retried as above before it errors.
- **Never past their life, never an error.** An expired answer is not used
  even when rbacr can't be reached: `allows` then answers `false` and the
  rest throw (SPEC C6: when rbacr can't answer, deny). Errors are never kept.
- **Per user.** Answers are keyed by who the token says it is (an ID
  token's issuer and subject, or the personal token), so one user never
  gets another's; when another user's token shows up, everything kept is
  dropped. Ages use a monotonic clock, so changing the device's clock
  can't keep an answer alive.
- **One request for many callers.** Concurrent identical questions share
  one request.
- **The trade-off.** A role revoked in rbacr can still be answered from
  memory until its answer expires (at most `cacheDuration`). Where that
  matters, pass `fresh: true` (asks rbacr now, and keeps the new answer),
  call `clearCache()`, or pass a shorter `cacheDuration`. `redeemVoucher`
  drops kept answers itself.

`me()` has no `ttl` (a role in it may end before its answer expires): gate
features with `allows`/`check`, which have one.

## In a Flutter app

```dart
// One client per signed-in user, for the whole session (it keeps the
// connection and the answers); never a root's token in an app.
final rbacr = RbacrClient(
  tokenProvider: () async => (await googleUser.authentication).idToken!,
);

// Gate what the app shows; anything that must hold is enforced on a server.
final premium = await rbacr.allows(email: user.email, systemId: 'presence', role: 'premium');

// Down for maintenance, not "no access" (kept 5 minutes).
if ((await rbacr.systemStatus('presence')).maintenance) showMaintenance();

// Right after a purchase or a grant elsewhere: ask rbacr now.
await rbacr.allows(email: user.email, systemId: 'presence', role: 'premium', fresh: true);

// On sign-out: drop what was kept, and the connection.
rbacr.close();
```

- **Tokens.** Pass the signed-in user's ID token from `tokenProvider`,
  freshly each time (`google_sign_in` refreshes it). An app that signs
  users in some other way, such as Sign in with Apple, has its backend
  issue its own short-lived ID tokens from an issuer rbacr trusts,
  preferably limited to the app's systems (rbacr-sls README, "Apps with
  their own ID tokens"; SPEC I7-I10). Release builds ignore an
  `RBACR_TOKEN` define (see Settings).
- **Cost.** With the defaults, a user's role is asked about about once an
  hour, and a "no" once every 5 minutes, per question, however often the
  app checks. Keep one client: a new client starts with nothing kept.
- **Web.** The app's origin must be in rbacr's `RBACR_CORS_ORIGINS`.

## Tokens

The client authenticates with a bearer token and acts as its owner, so it
sees what they may see (SPEC C2). The token is either a personal API token
(rbacr's `/me` page, SPEC T1-T5) or, in an app that signs its users in with
Google, the user's **Google ID token** (SPEC I1-I5).

### Your user's Google ID token

An app that already signs its users in with Google can call rbacr as the
signed-in user with nothing else to store: pass their ID token from the
`tokenProvider`. It expires within an hour, so get a fresh one for each
request (`google_sign_in` refreshes it):

```dart
final rbacr = RbacrClient(
  tokenProvider: () async => (await googleUser.authentication).idToken!,
);
final me = await rbacr.me();                          // their roles
final status = await rbacr.systemStatus('presence');  // maintenance?
await rbacr.redeemVoucher(code);                      // for themselves
```

rbacr accepts the ID token only when Google issued it to one of the OAuth
clients in rbacr's `RBACR_GOOGLE_AUDIENCES`. On Android and iOS the ID
token's audience is the **web** client id the app passes as
`serverClientId`, so that id must be listed; list the Android and iOS
client ids too if the app ever gets tokens issued to them. An ID token
reaches only the **self-service** calls: `me()`, `check`, `allows`,
`rolesIn` and `allRoles` about the signed-in user, `systemStatus`,
`redeemVoucher` and `redeemVoucherGrants`. Anything else answers 403
(`isForbidden`), even when the user is a root: root management always
needs a personal token.

### Personal API tokens

- A **user's own token** may ask only about that user: `me()`, `check` and
  `rolesIn` with their own address, and `redeemVoucher`; plus any system's
  status (`systemStatus`). That is the token
  an app on a user's device can hold, kept in secure storage.
- A **root's token** may ask about anyone. **Never ship one inside an
  app**: anyone can extract it from the binary. Keep it on your server
  and let the app ask your server.

Voucher management (`createVoucher`, `listVouchers`, `disableVoucher`)
needs a root's token, so it belongs on your server. rbacr deletes nothing
(SPEC L1): deleting a voucher disables it for good and records who did it
(`disabledBy`). It stays listed for auditing, and grants already redeemed
stay (V6). Removing its role or deleting its system disables it the same
way (L3). The rest of root management (configuring systems, grants) is
left out of this client; `systems()` only reads them. Plain `http` URLs are refused, except for localhost during
development.

## Settings: `RBACR_URL` and `RBACR_TOKEN`

Without arguments, the client takes its base URL from `RBACR_URL` (else
production) and its token from `RBACR_TOKEN`. Arguments always win. The
settings come from compile-time defines first, then the process
environment:

```bash
flutter run --dart-define-from-file=.env    # Flutter apps
dart run bin/server.dart                    # Dart servers: RBACR_URL / RBACR_TOKEN in the environment
```

```dart
final rbacr = RbacrClient(); // RBACR_URL, RBACR_TOKEN
```

A define is compiled into the app, so only define `RBACR_TOKEN` for
development builds against the local dev server. Release builds ignore the
`RBACR_TOKEN` define (the environment variable still counts, for Dart
servers), so a shared `.env` can't ship a personal token in an app: pass the
user's own token with `tokenProvider` (see Tokens).

`allows` answers `false` on any failure, including a `tokenProvider` that
throws (say, nobody is signed in) and an answer it can't read. Requests never
follow redirects, so the token only goes to `baseUrl`. A 429
(`isTooManyRequests`) means too many failed attempts to redeem a voucher:
wait the minutes the message says.

## Against a local rbacr

For development, run the rbacr dev server
([rbacr-sls: Local rbacr for your app](../rbacr-sls/README.md#local-rbacr-for-your-app)),
with `RBACR_URL=http://localhost:8686` and `RBACR_TOKEN` in your project's
`.env`. The same file configures the dev server and this client, so nothing
else changes. `RbacrClient.local` is that URL as a constant.

`localhost` is the host machine on desktop and in the iOS simulator. On
Android (emulator or device), run `adb reverse tcp:8686 tcp:8686` so the
device's `localhost:8686` reaches the dev server. Also allow cleartext
traffic to `localhost` in debug builds (`android:usesCleartextTraffic="true"`
in the debug manifest, or a network security config). Plain `http` is
accepted only for `localhost`, `127.0.0.1` and `::1`. The dev server's token
is a root's, so keep it out of release builds.

## Develop

Needs Dart 3.9 or later (or Flutter). From this folder:

```bash
dart pub get
dart analyze
dart format --line-length 120 --set-exit-if-changed lib test example
dart test                      # unit tests, offline
# against a running dev server (rbacr-sls: devbox services up, RBACR_DEV_LOGIN=1):
RBACR_E2E_URL=http://127.0.0.1:5173 RBACR_E2E_ROOT=e2e-root@nu01.com dart test -t e2e
```

The [rbacr-flutter workflow](../.github/workflows/rbacr-flutter.yml) runs
the offline checks on every pull request that touches this folder.
