import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:rbacr/rbacr.dart';
import 'package:rbacr/src/settings.dart' as settings;
import 'package:test/test.dart';

http.Response reply(Object body, [int status = 200]) =>
    http.Response(jsonEncode(body), status, headers: {'content-type': 'application/json'});

Map<String, Object?> checkAnswer(bool allowed, {int? ttl}) => {
  'email': 'ana@x.com',
  'systemId': 'presence',
  'role': 'premium',
  'allowed': allowed,
  'expiresAt': null,
  'ttl': ttl,
};

/// An unsigned JWT-shaped token: the cache only reads who it is for.
String idToken(String sub) {
  String part(Object v) => base64Url.encode(utf8.encode(jsonEncode(v))).replaceAll('=', '');
  return '${part({'alg': 'RS256'})}.${part({'iss': 'https://issuer.test', 'sub': sub, 'email': '$sub@x.com'})}.sig';
}

void main() {
  setUp(() => settings.environment = () => const {});

  late Duration now;
  late List<http.Request> seen;
  late FutureOr<http.Response> Function(http.Request) answer;
  late String token;

  RbacrClient client({
    Duration cacheDuration = const Duration(hours: 1),
    List<Duration> retryDelays = const [Duration.zero, Duration.zero],
    int maxCacheEntries = 1000,
  }) => RbacrClient(
    baseUrl: Uri.parse('https://rbacr.test'),
    tokenProvider: () => token,
    cacheDuration: cacheDuration,
    retryDelays: retryDelays,
    maxCacheEntries: maxCacheEntries,
    clock: () => now,
    httpClient: MockClient((r) async {
      seen.add(r);
      return answer(r);
    }),
  );

  Future<bool> premium(RbacrClient c, {bool fresh = false}) =>
      c.allows(email: 'ana@x.com', systemId: 'presence', role: 'premium', fresh: fresh);

  setUp(() {
    now = Duration.zero;
    seen = [];
    token = 'rbacr_ana';
    answer = (_) => reply(checkAnswer(true));
  });

  group('kept answers', () {
    test('a "yes" is kept for the cache duration (default an hour), then asked again', () async {
      final c = client();
      expect(c.cacheDuration, const Duration(hours: 1));
      expect(await premium(c), isTrue);
      now = const Duration(minutes: 47);
      expect(await premium(c), isTrue);
      expect(seen, hasLength(1));
      now = const Duration(hours: 1, minutes: 1);
      expect(await premium(c), isTrue);
      expect(seen, hasLength(2));
    });

    test('a "yes" is never kept past its ttl (C3a)', () async {
      answer = (_) => reply(checkAnswer(true, ttl: 120));
      final c = client();
      await premium(c);
      now = const Duration(seconds: 119);
      await premium(c);
      expect(seen, hasLength(1));
      now = const Duration(seconds: 120);
      await premium(c);
      expect(seen, hasLength(2));
    });

    test('a "no" is kept only for the negative cache duration (default 5 minutes)', () async {
      answer = (_) => reply(checkAnswer(false));
      final c = client();
      expect(await premium(c), isFalse);
      now = const Duration(minutes: 3);
      await premium(c);
      expect(seen, hasLength(1));
      now = const Duration(minutes: 5);
      await premium(c);
      expect(seen, hasLength(2));
    });

    test('fresh asks rbacr even when an answer is kept, and keeps the new one', () async {
      final c = client();
      await premium(c);
      answer = (_) => reply(checkAnswer(false));
      expect(await premium(c, fresh: true), isFalse);
      expect(await premium(c), isFalse);
      expect(seen, hasLength(2));
    });

    test('concurrent questions share one request', () async {
      final gate = Completer<void>();
      answer = (_) async {
        await gate.future;
        return reply(checkAnswer(true));
      };
      final c = client();
      final answers = Future.wait([premium(c), premium(c), premium(c)]);
      gate.complete();
      expect(await answers, [true, true, true]);
      expect(seen, hasLength(1));
    });

    test('a zero cache duration keeps nothing', () async {
      final c = client(cacheDuration: Duration.zero);
      await premium(c);
      await premium(c);
      expect(seen, hasLength(2));
    });

    test('me, roles and system status are kept too; status only briefly', () async {
      answer = (r) => switch (r.url.path) {
        '/api/me' => reply({
          'email': 'ana@x.com',
          'root': false,
          'globalRoles': <String>[],
          'roles': {
            'presence': ['premium'],
          },
        }),
        '/api/roles' => reply({
          'email': 'ana@x.com',
          'systemId': 'presence',
          'roles': ['premium'],
        }),
        _ => reply({'id': 'presence', 'name': 'Presence', 'url': null, 'maintenance': false}),
      };
      final c = client();
      for (var i = 0; i < 2; i++) {
        await c.me();
        await c.rolesIn(email: 'ana@x.com', systemId: 'presence');
        await c.systemStatus('presence');
      }
      expect(seen, hasLength(3));
      now = const Duration(minutes: 6);
      await c.me();
      await c.systemStatus('presence');
      expect(seen.map((r) => r.url.path), [
        '/api/me',
        '/api/roles',
        '/api/systems/presence/status',
        '/api/systems/presence/status',
      ]);
    });

    test('are bounded: the oldest is dropped first', () async {
      final c = client(maxCacheEntries: 2);
      for (final role in ['a', 'b', 'c']) {
        await c.allows(email: 'ana@x.com', systemId: 'presence', role: role);
      }
      await c.allows(email: 'ana@x.com', systemId: 'presence', role: 'c'); // kept
      await c.allows(email: 'ana@x.com', systemId: 'presence', role: 'a'); // dropped
      expect(seen, hasLength(4));
    });
  });

  group('refreshing', () {
    test('in the last fifth of its life an answer is returned at once and refreshed in the background', () async {
      final c = client();
      await premium(c);
      answer = (_) => reply(checkAnswer(false));
      now = const Duration(minutes: 50);
      expect(await premium(c), isTrue); // still the kept "yes"...
      await pumpEventQueue();
      expect(seen, hasLength(2)); // ...refreshed meanwhile
      expect(await premium(c), isFalse);
      expect(seen, hasLength(2));
    });

    test('a failed background refresh keeps the answer until it expires, and is retried later', () async {
      final c = client(retryDelays: const []);
      await premium(c);
      answer = (_) => throw http.ClientException('offline');
      now = const Duration(minutes: 50);
      expect(await premium(c), isTrue);
      await pumpEventQueue();
      expect(await premium(c), isTrue);
      expect(seen, hasLength(2)); // no second refresh within 30 s
      now = const Duration(minutes: 51);
      expect(await premium(c), isTrue);
      await pumpEventQueue();
      expect(seen, hasLength(3));
      now = const Duration(hours: 1);
      expect(await premium(c), isFalse); // expired and unreachable: no (C6)
    });

    test('rbacr unreachable, slow, 5xx or 429 is asked again before erroring', () async {
      var calls = 0;
      answer = (_) => ++calls < 3 ? reply({'error': 'busy'}, 503) : reply(checkAnswer(true));
      final c = client();
      expect(await premium(c), isTrue);
      expect(calls, 3);
    });

    test('after the retries the error surfaces, and is not kept', () async {
      answer = (_) => reply({'error': 'slow down'}, 429);
      final c = client();
      await expectLater(
        c.check(email: 'ana@x.com', systemId: 'presence', role: 'premium'),
        throwsA(isA<RbacrException>().having((e) => e.isTooManyRequests, 'isTooManyRequests', isTrue)),
      );
      expect(seen, hasLength(3));
      answer = (_) => reply(checkAnswer(true));
      expect(await premium(c), isTrue);
    });

    test('4xx answers are not retried', () async {
      answer = (_) => reply({'error': 'Role "x" not found'}, 404);
      final c = client();
      await expectLater(c.check(email: 'ana@x.com', systemId: 'presence', role: 'x'), throwsA(isA<RbacrException>()));
      expect(seen, hasLength(1));
    });
  });

  group('callers stay apart', () {
    test("another user's token never gets the first user's answers, and clears them", () async {
      final c = client();
      token = idToken('ana');
      expect(await premium(c), isTrue);
      token = idToken('bob');
      answer = (_) => reply({'error': "Only roots can ask about other people's roles"}, 403);
      expect(await premium(c), isFalse);
      expect(seen, hasLength(2));
      token = idToken('ana');
      answer = (_) => reply(checkAnswer(true));
      expect(await premium(c), isTrue);
      expect(seen, hasLength(3)); // Ana's answer went when Bob's token showed up
    });

    test('a refreshed ID token of the same user keeps the answers', () async {
      final c = client();
      token = idToken('ana');
      await premium(c);
      token = '${idToken('ana')}-renewed';
      await premium(c);
      expect(seen, hasLength(1));
    });

    test('clearCache (sign-out) and a redemption drop kept answers', () async {
      final c = client();
      await premium(c);
      c.clearCache();
      await premium(c);
      expect(seen, hasLength(2));
      answer = (r) => r.url.path == '/api/vouchers/redeem'
          ? reply({
              'systemId': 'presence',
              'role': 'premium',
              'grantee': 'ana@x.com',
              'grantedBy': 'r@x.com',
              'grantedAt': '2026-10-18T00:00:00.000Z',
              'startsAt': null,
              'endsAt': null,
              'status': 'active',
              'voucherCode': 'X',
              'impliedRoles': <String>[],
            })
          : reply(checkAnswer(true));
      await c.redeemVoucher('X');
      await premium(c);
      expect(seen, hasLength(4));
    });

    test('a sign-out during a request keeps that answer out', () async {
      final gate = Completer<void>();
      answer = (_) async {
        await gate.future;
        return reply(checkAnswer(true));
      };
      final c = client();
      final pending = premium(c);
      await pumpEventQueue(); // the request is now in flight
      expect(seen, hasLength(1));
      c.clearCache();
      gate.complete();
      await pending;
      answer = (_) => reply(checkAnswer(true));
      await premium(c);
      expect(seen, hasLength(2));
    });
  });

  test('rejects nonsense settings', () {
    expect(() => client(cacheDuration: const Duration(seconds: -1)), throwsArgumentError);
    expect(() => client(maxCacheEntries: 0), throwsArgumentError);
  });
}
