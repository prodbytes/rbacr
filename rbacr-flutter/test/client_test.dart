import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rbacr/rbacr.dart';
import 'package:test/test.dart';

/// A client whose requests [handler] answers; requests are recorded in [seen].
RbacrClient fake(FutureOr<http.Response> Function(http.Request) handler, {List<http.Request>? seen}) => RbacrClient(
  baseUrl: Uri.parse('https://rbacr.test'),
  token: 'rbacr_test',
  httpClient: MockClient((request) async {
    seen?.add(request);
    return handler(request);
  }),
);

http.Response reply(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

void main() {
  group('requests', () {
    test('send the token and JSON body to /api', () async {
      final seen = <http.Request>[];
      final client = fake(
        (_) => reply({
          'email': 'ana@x.com',
          'systemId': 'presence',
          'role': 'premium',
          'allowed': false,
          'expiresAt': null,
          'ttl': null,
        }),
        seen: seen,
      );
      await client.check(email: 'ana@x.com', systemId: 'presence', role: 'premium');
      final request = seen.single;
      expect(request.method, 'POST');
      expect(request.url.toString(), 'https://rbacr.test/api/check');
      expect(request.headers['authorization'], 'Bearer rbacr_test');
      expect(request.headers['content-type'], startsWith('application/json'));
      expect(jsonDecode(request.body), {'email': 'ana@x.com', 'systemId': 'presence', 'role': 'premium'});
    });

    test('ask the token provider for every request', () async {
      var n = 0;
      final seen = <http.Request>[];
      final client = RbacrClient(
        baseUrl: Uri.parse('https://rbacr.test'),
        tokenProvider: () async => 'rbacr_${++n}',
        httpClient: MockClient((r) async {
          seen.add(r);
          return reply({'email': 'a@x.com', 'root': false, 'globalRoles': <String>[], 'roles': <String, Object>{}});
        }),
      );
      await client.me();
      await client.me();
      expect(seen.map((r) => r.headers['authorization']), ['Bearer rbacr_1', 'Bearer rbacr_2']);
    });

    test('refuse plain http except on localhost, and exactly one token source', () {
      expect(() => RbacrClient(baseUrl: Uri.parse('http://rbacr.nu01.com'), token: 't'), throwsArgumentError);
      expect(RbacrClient(baseUrl: Uri.parse('http://127.0.0.1:5173'), token: 't').baseUrl.port, 5173);
      expect(RbacrClient(token: 't').baseUrl, RbacrClient.production);
      expect(() => RbacrClient(), throwsArgumentError);
      expect(() => RbacrClient(token: 't', tokenProvider: () => 't'), throwsArgumentError);
    });
  });

  group('answers', () {
    test('me', () async {
      final me = await fake(
        (_) => reply({
          'email': 'ana@x.com',
          'root': false,
          'globalRoles': ['pro'],
          'roles': {
            'presence': ['free', 'premium'],
          },
        }),
      ).me();
      expect(me.email, 'ana@x.com');
      expect(me.globalRoles, ['pro']);
      expect(me.hasRole('presence', 'Premium'), isTrue);
      expect(me.hasRole('presence', 'admin'), isFalse);
      expect(me.hasRole('other', 'free'), isFalse);
    });

    test('check carries how long a yes holds (C3a)', () async {
      final yes = await fake(
        (_) => reply({
          'email': 'ana@x.com',
          'systemId': 'presence',
          'role': 'premium',
          'allowed': true,
          'expiresAt': '2026-11-01T00:00:00.000Z',
          'ttl': 3600,
        }),
      ).check(email: 'ana@x.com', systemId: 'presence', role: 'premium');
      expect(yes.allowed, isTrue);
      expect(yes.expiresAt, DateTime.utc(2026, 11, 1));
      expect(yes.ttl, const Duration(hours: 1));
      final forever = await fake(
        (_) => reply({
          'email': 'r@x.com',
          'systemId': null,
          'role': 'root',
          'allowed': true,
          'expiresAt': null,
          'ttl': null,
        }),
      ).check(email: 'r@x.com', role: 'root');
      expect([forever.systemId, forever.expiresAt, forever.ttl], [null, null, null]);
    });

    test('roles in one system and everywhere', () async {
      expect(
        await fake(
          (_) => reply({
            'email': 'a@x.com',
            'systemId': 'presence',
            'roles': ['free'],
          }),
        ).rolesIn(email: 'a@x.com', systemId: 'presence'),
        ['free'],
      );
      final all = await fake(
        (_) => reply({
          'email': 'a@x.com',
          'globalRoles': <String>[],
          'roles': {
            'presence': ['free'],
          },
        }),
      ).allRoles(email: 'a@x.com');
      expect(all.roles, {
        'presence': ['free'],
      });
    });

    test('redeemed grants, global ones included', () async {
      final grant = await fake(
        (_) => reply({
          'systemId': null,
          'role': 'pro',
          'grantee': 'a@x.com',
          'grantedBy': 'r@x.com',
          'grantedAt': '2026-10-10T08:00:00.000Z',
          'startsAt': null,
          'endsAt': '2027-01-01T00:00:00.000Z',
          'status': 'active',
          'voucherCode': 'AAAA-BBBB-CCCC-DDDD',
          'impliedRoles': <String>[],
          'impliedRolesBySystem': {
            'presence': ['free'],
          },
        }),
      ).redeemVoucher('aaaa bbbb cccc dddd');
      expect(grant.isGlobal, isTrue);
      expect(grant.status, GrantStatus.active);
      expect(grant.endsAt, DateTime.utc(2027));
      expect(grant.impliedRolesBySystem, {
        'presence': ['free'],
      });
    });
  });

  group('vouchers', () {
    Map<String, Object?> voucher({String? systemId = 'presence', String status = 'active'}) => {
      'code': 'AAAA-BBBB-CCCC-DDDD',
      'systemId': systemId,
      'role': 'premium',
      'discountPercent': 100,
      'startsAt': null,
      'endsAt': '2027-01-01T00:00:00.000Z',
      'maxUses': 5,
      'uses': 1,
      'status': status,
      'createdBy': 'r@x.com',
      'createdAt': '2026-10-10T08:00:00.000Z',
      'disabledAt': status == 'disabled' ? '2026-10-11T08:00:00.000Z' : null,
      'disabledBy': status == 'disabled' ? 'root@corp.com' : null,
    };

    test('create in a system, sending only what is set, dates in UTC', () async {
      final seen = <http.Request>[];
      final created = await fake(
        (_) => reply(voucher(), 201),
        seen: seen,
      ).createVoucher(systemId: 'presence', role: 'premium', endsAt: DateTime.utc(2027), maxUses: 5);
      expect(seen.single.method, 'POST');
      expect(seen.single.url.path, '/api/systems/presence/vouchers');
      expect(jsonDecode(seen.single.body), {'role': 'premium', 'endsAt': '2027-01-01T00:00:00.000Z', 'maxUses': 5});
      expect(created.code, 'AAAA-BBBB-CCCC-DDDD');
      expect(created.status, VoucherStatus.active);
      expect([created.maxUses, created.uses, created.endsAt], [5, 1, DateTime.utc(2027)]);
      expect(created.isGlobal, isFalse);
    });

    test('create and list global vouchers without a system', () async {
      final seen = <http.Request>[];
      final client = fake(
        (r) => r.method == 'POST'
            ? reply(voucher(systemId: null), 201)
            : reply({
                'vouchers': [voucher(systemId: null)],
              }),
        seen: seen,
      );
      final created = await client.createVoucher(role: 'pro', discountPercent: 25);
      final listed = await client.listVouchers();
      expect(seen.map((r) => '${r.method} ${r.url.path}'), ['POST /api/vouchers', 'GET /api/vouchers']);
      expect(jsonDecode(seen.first.body), {'role': 'pro', 'discountPercent': 25});
      expect(created.isGlobal, isTrue);
      expect(listed.single.isGlobal, isTrue);
    });

    test('list a system and disable by code, escaping path segments', () async {
      final seen = <http.Request>[];
      final client = fake(
        (r) => r.method == 'DELETE'
            ? reply(voucher(status: 'disabled'))
            : reply({
                'vouchers': [voucher()],
              }),
        seen: seen,
      );
      expect((await client.listVouchers(systemId: 'presence')).single.systemId, 'presence');
      final disabled = await client.disableVoucher('aaaa/bbbb');
      expect(seen.map((r) => '${r.method} ${r.url}'), [
        'GET https://rbacr.test/api/systems/presence/vouchers',
        'DELETE https://rbacr.test/api/vouchers/aaaa%2Fbbbb',
      ]);
      expect(seen.last.body, isEmpty);
      expect(disabled.status, VoucherStatus.disabled);
      expect(disabled.disabledAt, DateTime.utc(2026, 10, 11, 8));
      expect(disabled.disabledBy, 'root@corp.com');
    });
  });

  group('errors', () {
    test('carry the status and rbacr message', () async {
      final error = await fake(
        (_) => reply({'error': 'Role "x" not found in "presence"'}, 404),
      ).check(email: 'a@x.com', systemId: 'presence', role: 'x').then<Object?>((_) => null, onError: (Object e) => e);
      expect(error, isA<RbacrException>().having((e) => e.isNotFound, 'isNotFound', isTrue));
      expect((error as RbacrException).message, 'Role "x" not found in "presence"');
    });

    test('402 carries the payment terms', () async {
      final error = await fake(
        (_) => reply({
          'error': 'This voucher requires payment',
          'payment': {'code': 'AAAA-BBBB-CCCC-DDDD', 'systemId': null, 'role': 'pro', 'discountPercent': 25},
        }, 402),
      ).redeemVoucher('AAAA-BBBB-CCCC-DDDD').then<Object?>((_) => null, onError: (Object e) => e);
      expect(error, isA<RbacrPaymentRequired>());
      expect((error as RbacrPaymentRequired).payment.discountPercent, 25);
    });

    test('no answer, or no JSON, is an RbacrException without a status', () async {
      final down = fake((_) => throw http.ClientException('connection refused'));
      await expectLater(down.me(), throwsA(isA<RbacrException>().having((e) => e.statusCode, 'statusCode', isNull)));
      final html = fake((_) => http.Response('<html>', 502));
      await expectLater(html.me(), throwsA(isA<RbacrException>().having((e) => e.statusCode, 'statusCode', 502)));
    });

    test('allows fails closed (C6)', () async {
      expect(
        await fake(
          (_) => reply({'error': 'A valid API token is required'}, 401),
        ).allows(email: 'a@x.com', role: 'root'),
        isFalse,
      );
      expect(await fake((_) => throw http.ClientException('down')).allows(email: 'a@x.com', role: 'root'), isFalse);
    });

    test('a slow answer times out', () async {
      final slow = RbacrClient(
        baseUrl: Uri.parse('https://rbacr.test'),
        token: 't',
        timeout: const Duration(milliseconds: 50),
        httpClient: MockClient((_) => Future.delayed(const Duration(seconds: 1), () => reply({}))),
      );
      await expectLater(slow.me(), throwsA(isA<RbacrException>()));
    });
  });
}
