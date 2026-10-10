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
```

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
answer.ttl;       // the same as a Duration from now: never cache the "yes" longer

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
final global = await admin.createVoucher(roles: ['pro'], endsAt: DateTime.utc(2027)); // no system: global
final vouchers = await admin.listVouchers(systemId: 'presence'); // newest first; none: global ones
await admin.disableVoucher(voucher.code); // DELETE: disabled for good (disabledBy), still listed
```

| Method | rbacr endpoint | Returns |
|--------|----------------|---------|
| `me()` | `GET /api/me` | `Me`: email, root, global roles, roles per system |
| `check(email, systemId?, role)` | `POST /api/check` | `RoleCheck`: `allowed`, `expiresAt`, `ttl` |
| `allows(email, systemId?, role)` | `POST /api/check` | `bool`, `false` on any error |
| `systemStatus(systemId)` | `GET /api/systems/:id/status` | `SystemStatus`: id, name, url, `maintenance` (any token) |
| `systems()` | `GET /api/systems` | a `SystemStatus` per system (roots; others get none) |
| `rolesIn(email, systemId)` | `POST /api/roles` | the effective roles, sorted |
| `allRoles(email)` | `POST /api/roles` | `AllRoles`: global roles and roles per system |
| `redeemVoucher(code)` | `POST /api/vouchers/redeem` | the `Grant` of its first role |
| `redeemVoucherGrants(code)` | `POST /api/vouchers/redeem` | a `Grant` per role |
| `createVoucher(systemId?, roles or role, code?, discountPercent?, startsAt?, endsAt?, maxUses?)` | `POST /api/systems/:id/vouchers`, or `POST /api/vouchers` without a system | the `Voucher` (roots) |
| `listVouchers(systemId?)` | `GET /api/systems/:id/vouchers`, or `GET /api/vouchers` | the `Voucher`s, newest first (roots) |
| `listRedemptions(code)` | `GET /api/vouchers/:code/redemptions` | the `RedeemEvent`s, newest first (roots) |
| `listRedeemFailures({code})` | `GET /api/vouchers/:code/failures`, or without `code` `GET /api/redeem-failures` | the `RedeemFailure`s (failed attempts, V9), newest first (roots) |
| `disableVoucher(code)` | `DELETE /api/vouchers/:code` | the disabled `Voucher` (roots) |

Errors are `RbacrException`s with rbacr's message and `statusCode`
(`isUnauthorized`, `isForbidden`, `isNotFound`, …), or no status when rbacr
couldn't be reached or timed out (10 s by default). A voucher that needs
payment throws `RbacrPaymentRequired` with its `payment` terms.

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
development builds against the local dev server. In release builds, pass the
user's own token with `tokenProvider` (see Tokens).

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
