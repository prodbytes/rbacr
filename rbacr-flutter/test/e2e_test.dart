// The client against a running rbacr dev server (rbacr-sls: `devbox services
// up`, with RBACR_DEV_LOGIN=1). Skipped unless RBACR_E2E_URL is set:
//
//   RBACR_E2E_URL=http://127.0.0.1:5173 RBACR_E2E_ROOT=e2e-root@nu01.com dart test -t e2e
@Tags(['e2e'])
library;

import 'dart:convert';
import 'dart:io';

import 'package:http/http.dart' as http;
import 'package:rbacr/rbacr.dart';
import 'package:test/test.dart';

final base = Platform.environment['RBACR_E2E_URL'];
final rootEmail = Platform.environment['RBACR_E2E_ROOT'] ?? 'root@e2e.test';

/// Signs in through /login/dev and mints an API token through /vpi, as the /me page does.
Future<String> tokenFor(String email) async {
  final login = http.Request('POST', Uri.parse('$base/login/dev'))
    ..followRedirects = false
    ..headers.addAll({'origin': base!, 'accept': 'text/html', 'content-type': 'application/x-www-form-urlencoded'})
    ..bodyFields = {'email': email};
  final res = await http.Client().send(login);
  expect(res.statusCode, 303, reason: 'dev login failed; is RBACR_DEV_LOGIN=1 set?');
  final cookie = res.headers['set-cookie']!.split(';').first;
  final minted = await http.post(
    Uri.parse('$base/vpi/tokens'),
    headers: {
      'cookie': cookie,
      'origin': base!,
      'x-rbacr-vpi': '1',
      'sec-fetch-site': 'same-origin',
      'content-type': 'application/json',
    },
    body: jsonEncode({'name': 'dart e2e'}),
  );
  expect(minted.statusCode, 201, reason: minted.body);
  return (jsonDecode(minted.body) as Map<String, Object?>)['token'] as String;
}

void main() {
  if (base == null) {
    test('against a dev server', () {}, skip: 'Set RBACR_E2E_URL to run against a dev server');
    return;
  }
  final system = 'dart-e2e-${DateTime.now().millisecondsSinceEpoch}';
  final user = 'dart-user@partner.test';
  late RbacrClient root;
  late RbacrClient me;

  /// Root-only setup through the raw API, which this client deliberately leaves out.
  Future<http.Response> admin(String method, String path, Object body, String token) async {
    final request = http.Request(method, Uri.parse('$base$path'))
      ..headers.addAll({'authorization': 'Bearer $token', 'content-type': 'application/json'})
      ..body = jsonEncode(body);
    return http.Response.fromStream(await http.Client().send(request));
  }

  late String rootToken;
  setUpAll(() async {
    rootToken = await tokenFor(rootEmail);
    root = RbacrClient(baseUrl: Uri.parse(base!), token: rootToken);
    me = RbacrClient(baseUrl: Uri.parse(base!), token: await tokenFor(user));
    expect(
      (await admin('POST', '/api/systems', {
        'id': system,
        'roles': ['free', 'premium'],
      }, rootToken)).statusCode,
      201,
    );
  });

  tearDownAll(() async {
    await http.delete(Uri.parse('$base/api/systems/$system'), headers: {'authorization': 'Bearer $rootToken'});
    root.close();
    me.close();
  });

  test('answers who holds which role, with how long a yes holds', () async {
    final ends = DateTime.now().toUtc().add(const Duration(days: 30));
    final granted = await admin('POST', '/api/systems/$system/grants', {
      'role': 'premium',
      'grantee': user,
      'endsAt': ends.toIso8601String(),
    }, rootToken);
    expect(granted.statusCode, 201, reason: granted.body);

    final yes = await root.check(email: user, systemId: system, role: 'premium');
    expect(yes.allowed, isTrue);
    expect(yes.expiresAt!.millisecondsSinceEpoch, ends.millisecondsSinceEpoch);
    expect(
      yes.ttl!.inSeconds,
      inInclusiveRange(const Duration(days: 30).inSeconds - 10, const Duration(days: 30).inSeconds),
    );
    final no = await root.check(email: user, systemId: system, role: 'free');
    expect([no.allowed, no.expiresAt, no.ttl], [false, null, null]);
    expect(await root.allows(email: rootEmail, role: 'root'), isTrue);

    expect((await me.me()).hasRole(system, 'premium'), isTrue);
    expect(await me.rolesIn(email: user, systemId: system), ['premium']);
    expect((await me.allRoles(email: user)).roles[system], ['premium']);
  });

  test('keeps people out of other people roles, and reports unknown roles', () async {
    await expectLater(
      me.check(email: rootEmail, systemId: system, role: 'free'),
      throwsA(isA<RbacrException>().having((e) => e.isForbidden, 'isForbidden', isTrue)),
    );
    await expectLater(
      root.check(email: user, systemId: system, role: 'ghost'),
      throwsA(isA<RbacrException>().having((e) => e.isNotFound, 'isNotFound', isTrue)),
    );
    final stranger = RbacrClient(baseUrl: Uri.parse(base!), token: 'rbacr_not-a-token');
    await expectLater(
      stranger.me(),
      throwsA(isA<RbacrException>().having((e) => e.isUnauthorized, 'isUnauthorized', isTrue)),
    );
  });

  test('redeems vouchers, and reports those that need payment', () async {
    final free = await admin('POST', '/api/systems/$system/vouchers', {'role': 'free'}, rootToken);
    final code = (jsonDecode(free.body) as Map<String, Object?>)['code'] as String;
    final grant = await me.redeemVoucher(code.toLowerCase().replaceAll('-', ' '));
    expect([grant.systemId, grant.role, grant.status, grant.endsAt], [system, 'free', GrantStatus.active, null]);

    final paid = await admin('POST', '/api/systems/$system/vouchers', {
      'role': 'premium',
      'discountPercent': 25,
    }, rootToken);
    final paidCode = (jsonDecode(paid.body) as Map<String, Object?>)['code'] as String;
    await expectLater(
      me.redeemVoucher(paidCode),
      throwsA(isA<RbacrPaymentRequired>().having((e) => e.payment.discountPercent, 'discountPercent', 25)),
    );
  });
}
