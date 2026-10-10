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

  /// Root-only setup (systems, grants) through the raw API, which this client leaves out.
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

  test('shows any token a system status, maintenance included', () async {
    final status = await me.systemStatus(system);
    expect([status.id, status.maintenance], [system, false]);
    expect((await root.systems()).map((s) => s.id), contains(system));
    expect(await me.systems(), isEmpty);
    await expectLater(
      me.systemStatus('$system-ghost'),
      throwsA(isA<RbacrException>().having((e) => e.isNotFound, 'isNotFound', isTrue)),
    );

    expect((await admin('PATCH', '/api/systems/$system', {'maintenance': true}, rootToken)).statusCode, 200);
    try {
      expect((await me.systemStatus(system)).maintenance, isTrue);
      expect(await root.allows(email: rootEmail, systemId: system, role: 'free'), isFalse);
    } finally {
      await admin('PATCH', '/api/systems/$system', {'maintenance': false}, rootToken);
    }
    expect((await me.systemStatus(system)).maintenance, isFalse);
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

  test('manages vouchers: create, list, redeem, disable', () async {
    final ends = DateTime.now().toUtc().add(const Duration(days: 7));
    final free = await root.createVoucher(systemId: system, role: 'free', endsAt: ends, maxUses: 2);
    expect(
      [free.systemId, free.role, free.discountPercent, free.maxUses, free.uses, free.status],
      [system, 'free', 100, 2, 0, VoucherStatus.active],
    );
    expect(free.endsAt!.millisecondsSinceEpoch, ends.millisecondsSinceEpoch);
    expect(free.createdBy, rootEmail);

    final grant = await me.redeemVoucher(free.code.toLowerCase().replaceAll('-', ' '));
    expect(
      [grant.systemId, grant.role, grant.status, grant.endsAt, grant.voucherCode],
      [system, 'free', GrantStatus.active, null, free.code],
    );
    await expectLater(
      me.redeemVoucher(free.code),
      throwsA(isA<RbacrException>().having((e) => e.isConflict, 'isConflict', isTrue)),
    );

    final listed = (await root.listVouchers(systemId: system)).singleWhere((v) => v.code == free.code);
    expect(listed.uses, 1);

    final disabled = await root.disableVoucher(free.code);
    expect([disabled.status, disabled.disabledAt == null], [VoucherStatus.disabled, false]);
    expect(disabled.disabledBy, rootEmail);
    expect(
      (await root.listVouchers(systemId: system)).singleWhere((v) => v.code == free.code).status,
      VoucherStatus.disabled,
    );
    expect((await me.me()).hasRole(system, 'free'), isTrue, reason: 'redeemed grants outlive the voucher');

    await expectLater(
      me.createVoucher(systemId: system, role: 'free'),
      throwsA(isA<RbacrException>().having((e) => e.isForbidden, 'isForbidden', isTrue)),
    );
    await expectLater(
      root.disableVoucher('ZZZZ-ZZZZ-ZZZZ-ZZZZ'),
      throwsA(isA<RbacrException>().having((e) => e.isNotFound, 'isNotFound', isTrue)),
    );
  });

  test('manages global vouchers', () async {
    final global = await root.createVoucher(role: 'dart-e2e-global', maxUses: 1);
    expect(global.isGlobal, isTrue);
    try {
      expect((await root.listVouchers()).map((v) => v.code), contains(global.code));
    } finally {
      await root.disableVoucher(global.code);
    }
  });

  test('vouchers grant several roles under a code of their own', () async {
    final code = 'dart e2e ${DateTime.now().millisecondsSinceEpoch}';
    final voucher = await root.createVoucher(systemId: system, roles: ['premium', 'free'], code: code, maxUses: 1);
    expect(
      [voucher.code, voucher.roles],
      [
        code.toUpperCase().replaceAll(' ', '-'),
        ['free', 'premium'],
      ],
    );
    try {
      final grants = await me.redeemVoucherGrants(code.replaceAll(' ', ''));
      expect(grants.map((g) => g.role), ['free', 'premium']);
      final event = (await root.listRedemptions(voucher.code)).single;
      expect([event.email, event.via, event.roles], [user, 'api', voucher.roles]);
      // Trying again fails, and the failure is kept (V9).
      await expectLater(me.redeemVoucherGrants(code), throwsA(anything));
      final failure = (await root.listRedeemFailures(code: voucher.code)).single;
      expect([failure.email, failure.known, failure.status], [user, true, 409]);
    } finally {
      await root.disableVoucher(voucher.code);
    }
  });

  test('reports vouchers that need payment', () async {
    final paid = await root.createVoucher(systemId: system, role: 'premium', discountPercent: 25);
    await expectLater(
      me.redeemVoucher(paid.code),
      throwsA(isA<RbacrPaymentRequired>().having((e) => e.payment.discountPercent, 'discountPercent', 25)),
    );
  });
}
