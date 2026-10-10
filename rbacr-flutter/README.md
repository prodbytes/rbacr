# rbacr-flutter

A Dart client for [rbacr](../README.md), for Flutter apps (and Dart
servers) that ask which roles their users hold, instead of calling rbacr's
HTTP API by hand. It wraps the external API (`/api`) of
[rbacr-sls](../rbacr-sls/README.md), whose [SPEC.md](../rbacr-sls/SPEC.md)
defines every answer.

It is a pure Dart package (only `package:http`), so it works in Flutter on
Android, iOS and desktop, and in Dart backends. **Not on Flutter web:**
rbacr's `/api` sends no CORS headers, so browsers block the calls.

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
  // https://rbacr.nu01.com by default; RbacrClient.releaseCandidate for RC.
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

final me = await rbacr.me();                        // the token owner's own roles
final roles = await rbacr.rolesIn(email: user.email, systemId: 'presence');
final grant = await rbacr.redeemVoucher('7JH2-UQF5-XA7B-VMQT');
```

| Method | rbacr endpoint | Returns |
|--------|----------------|---------|
| `me()` | `GET /api/me` | `Me`: email, root, global roles, roles per system |
| `check(email, systemId?, role)` | `POST /api/check` | `RoleCheck`: `allowed`, `expiresAt`, `ttl` |
| `allows(email, systemId?, role)` | `POST /api/check` | `bool`, `false` on any error |
| `rolesIn(email, systemId)` | `POST /api/roles` | the effective roles, sorted |
| `allRoles(email)` | `POST /api/roles` | `AllRoles`: global roles and roles per system |
| `redeemVoucher(code)` | `POST /api/vouchers/redeem` | the `Grant` |

Errors are `RbacrException`s with rbacr's message and `statusCode`
(`isUnauthorized`, `isForbidden`, `isNotFound`, …), or no status when rbacr
couldn't be reached or timed out (10 s by default). A voucher that needs
payment throws `RbacrPaymentRequired` with its `payment` terms.

## Tokens

The client authenticates with a personal API token (rbacr's `/me` page,
SPEC T1-T5) and acts as its owner, so it sees what they may see (SPEC C2):

- A **user's own token** may ask only about that user: `me()`, `check` and
  `rolesIn` with their own address, and `redeemVoucher`. That is the token
  an app on a user's device can hold, kept in secure storage.
- A **root's token** may ask about anyone. **Never ship one inside an
  app**: anyone can extract it from the binary. Keep it on your server
  and let the app ask your server.

Root management (systems, grants, vouchers) is deliberately left out of
this client. Plain `http` URLs are refused, except for localhost during
development.

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
