import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'cache.dart';
import 'errors.dart';
import 'models.dart';
import 'settings.dart';

/// Supplies the bearer token for each request, so it can change without a
/// new client: a personal API token (SPEC T1-T4), e.g. from secure storage,
/// or the signed-in user's Google ID token (SPEC I1-I5), e.g. from
/// `google_sign_in`, which expires within an hour, so fetch a fresh one here.
typedef RbacrTokenProvider = FutureOr<String> Function();

/// A client for rbacr's external API (`/api`), authenticated with a personal
/// API token or a Google ID token. It acts as the token's owner (SPEC T4):
/// anyone may ask about themselves; asking about other people needs a root's
/// personal token (C2), which must never ship inside an app.
///
/// A Google ID token (SPEC I1-I5), issued to one of the OAuth clients rbacr
/// trusts (`RBACR_GOOGLE_AUDIENCES`), reaches only the self-service calls:
/// [me], [check], [allows], [rolesIn] and [allRoles] about the signed-in user,
/// [systemStatus], [redeemVoucher] and [redeemVoucherGrants]. Everything else
/// answers 403, even for a root. On Flutter web, the app's origin must be in
/// rbacr's `RBACR_CORS_ORIGINS`.
///
/// ```dart
/// final rbacr = RbacrClient(token: myToken);
/// if (await rbacr.allows(email: user.email, systemId: 'presence', role: 'premium')) { ... }
///
/// // In an app, as its signed-in user:
/// final mine = RbacrClient(tokenProvider: () async => (await googleUser.authentication).idToken!);
/// final me = await mine.me();
/// ```
///
/// **Kept answers.** [me], [check], [allows], [rolesIn], [allRoles] and
/// [systemStatus] keep rbacr's answers in memory, per caller (the token's
/// identity) and question, so that most checks need no request:
/// - an answer that grants something for [cacheDuration] (default an hour),
///   and a "yes" never past the `ttl` rbacr gives with it (SPEC C3a);
/// - a "no", an empty role list and a system's status for
///   [negativeCacheDuration] (default 5 minutes), so a role just granted or
///   bought shows soon;
/// - never an error (C6).
///
/// In the last fifth of its life a kept answer is still returned at once,
/// and refreshed in the background. A question with no kept answer that
/// fails because rbacr can't be reached, is slow, answers 5xx or 429 is
/// asked again after each of [retryDelays] before it errors (or, for
/// [allows], answers `false`). Expired answers are never used: rbacr not
/// answering means "no" (C6). Ages use a monotonic clock, so changing the
/// device's clock doesn't stretch them.
///
/// The trade-off: a role revoked in rbacr can still be answered from memory
/// until its answer expires, at most [cacheDuration]. Pass `fresh: true` where
/// that matters (right after a payment, say), call [clearCache] when the user
/// signs out (answers are also dropped when another user's token shows up,
/// and after [redeemVoucher]), or pass a shorter [cacheDuration]. A check in
/// an app only decides what it shows: anything that must be enforced belongs
/// on a server.
class RbacrClient {
  /// [baseUrl] defaults to the `RBACR_URL` setting, else [production]. Pass
  /// a fixed [token] or a [tokenProvider], or neither to use the
  /// `RBACR_TOKEN` setting. Settings come from `--dart-define` (Flutter:
  /// `--dart-define-from-file=.env`), then the process environment. Only
  /// `https` URLs are accepted, except for localhost during development, so
  /// the token never travels in clear text.
  RbacrClient({
    Uri? baseUrl,
    String? token,
    RbacrTokenProvider? tokenProvider,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 10),
    this.cacheDuration = const Duration(hours: 1),
    this.negativeCacheDuration = const Duration(minutes: 5),
    this.retryDelays = const [Duration(seconds: 1), Duration(seconds: 3)],
    int maxCacheEntries = 1000,
    RbacrClock? clock,
  }) : baseUrl = baseUrl ?? _settingUrl() ?? production,
       _token = tokenProvider ?? _fixed(token ?? setting(tokenSetting)),
       _http = httpClient ?? http.Client(),
       _ownsHttp = httpClient == null,
       _cache = AnswerCache(clock: clock ?? monotonicClock(), maxEntries: maxCacheEntries, retryDelays: retryDelays) {
    if (cacheDuration.isNegative || negativeCacheDuration.isNegative || retryDelays.any((d) => d.isNegative)) {
      throw ArgumentError('Durations must not be negative');
    }
    if (maxCacheEntries < 1) throw ArgumentError.value(maxCacheEntries, 'maxCacheEntries', 'must be at least 1');
    if (token != null && tokenProvider != null) {
      throw ArgumentError('Pass at most one of token and tokenProvider');
    }
    if (token == null && tokenProvider == null && setting(tokenSetting) == null) {
      throw ArgumentError('Pass a token or tokenProvider, or set $tokenSetting');
    }
    final local = const {'localhost', '127.0.0.1', '::1'}.contains(this.baseUrl.host);
    if (this.baseUrl.scheme != 'https' && !(local && this.baseUrl.scheme == 'http')) {
      throw ArgumentError.value(this.baseUrl, 'baseUrl', 'must be https (http only for localhost)');
    }
  }

  /// https://rbacr.nu01.com
  static final Uri production = Uri.parse('https://rbacr.nu01.com');

  /// https://rc.rbacr.nu01.com, the release candidate.
  static final Uri releaseCandidate = Uri.parse('https://rc.rbacr.nu01.com');

  /// http://localhost:8686, rbacr-sls's local container (its Containerfile),
  /// for development; usually set as `RBACR_URL` instead.
  static final Uri local = Uri.parse('http://localhost:8686');

  final Uri baseUrl;

  /// Per request; a request that takes longer fails with [RbacrException].
  final Duration timeout;

  /// How long an answer that grants something is kept (a "yes" no longer
  /// than its `ttl`); [Duration.zero] keeps nothing.
  final Duration cacheDuration;

  /// How long a "no", an empty role list and a system's status are kept (at
  /// most [cacheDuration]).
  final Duration negativeCacheDuration;

  /// The waits before asking again when rbacr can't be reached, is slow, or
  /// answers 5xx or 429; empty: no retries.
  final List<Duration> retryDelays;

  final AnswerCache _cache;

  /// Who the last cached question was asked as: another caller clears the cache.
  String? _principal;

  final RbacrTokenProvider _token;
  final http.Client _http;
  final bool _ownsHttp;

  static Uri? _settingUrl() {
    final url = setting(urlSetting);
    return url == null ? null : Uri.parse(url);
  }

  static RbacrTokenProvider _fixed(String? token) =>
      () => token!;

  /// The token owner's own roles: `GET /api/me`, kept [cacheDuration]. It
  /// carries no `ttl`, so gate features with [allows], which does.
  Future<Me> me({bool fresh = false}) =>
      _cached('GET', '/api/me', null, Me.fromJson, (_) => cacheDuration, fresh: fresh);

  /// Whether [email] holds [role] in [systemId], or the global role [role]
  /// without a system (C3), with how long a "yes" holds (C3a). An unknown
  /// system or role throws a 404 [RbacrException] rather than answering no.
  /// A "yes" is kept [cacheDuration] but never past its `ttl`; a "no",
  /// [negativeCacheDuration].
  Future<RoleCheck> check({required String email, String? systemId, required String role, bool fresh = false}) =>
      _cached(
        'POST',
        '/api/check',
        {'email': email, 'systemId': systemId, 'role': role},
        RoleCheck.fromJson,
        (c) => !c.allowed
            ? _negative
            : c.ttl != null && c.ttl! < cacheDuration
            ? c.ttl!
            : cacheDuration,
        fresh: fresh,
      );

  /// [check] that fails closed (C6): any error, or no answer, means no,
  /// including a token provider that fails and an answer of the wrong shape.
  /// Errors are never kept, so the next call asks rbacr again.
  Future<bool> allows({required String email, String? systemId, required String role, bool fresh = false}) async {
    try {
      return (await check(email: email, systemId: systemId, role: role, fresh: fresh)).allowed;
    } catch (_) {
      return false;
    }
  }

  /// [email]'s effective roles in [systemId], sorted (C4); kept like [check]'s
  /// answers, without a `ttl` (an empty list as a "no").
  Future<List<String>> rolesIn({required String email, required String systemId, bool fresh = false}) => _cached(
    'POST',
    '/api/roles',
    {'email': email, 'systemId': systemId},
    (json) => List<String>.unmodifiable((json['roles'] as List<Object?>).cast<String>()),
    (roles) => roles.isEmpty ? _negative : cacheDuration,
    fresh: fresh,
  );

  /// [email]'s roles in every system and its global roles (C4); kept like [rolesIn].
  Future<AllRoles> allRoles({required String email, bool fresh = false}) => _cached(
    'POST',
    '/api/roles',
    {'email': email},
    AllRoles.fromJson,
    (all) => all.globalRoles.isEmpty && all.roles.values.every((r) => r.isEmpty) ? _negative : cacheDuration,
    fresh: fresh,
  );

  /// [systemId]'s status (R12): name, URL and whether it is in maintenance
  /// (R11). Any token may ask, so an app can tell "down for maintenance"
  /// from a missing role. An unknown system throws a 404 [RbacrException].
  /// Kept [negativeCacheDuration], so maintenance shows soon.
  Future<SystemStatus> systemStatus(String systemId, {bool fresh = false}) => _cached(
    'GET',
    '/api/systems/${Uri.encodeComponent(systemId)}/status',
    null,
    SystemStatus.fromJson,
    (_) => _negative,
    fresh: fresh,
  );

  /// Drops every kept answer. Call it when the user signs out.
  void clearCache() => _cache.clear();

  Duration get _negative => negativeCacheDuration < cacheDuration ? negativeCacheDuration : cacheDuration;

  /// A question whose answer may be kept: asked as the current token's
  /// owner, so answers never cross from one caller to another.
  Future<T> _cached<T>(
    String method,
    String path,
    Map<String, Object?>? body,
    T Function(Map<String, Object?>) parse,
    Duration Function(T) lifetimeOf, {
    bool fresh = false,
  }) async {
    // The token read to key the answer is used for the first request; retries
    // and background refreshes ask for a current one (ID tokens expire).
    String? token = await _currentToken();
    Future<T> load() async {
      final first = token;
      token = null;
      return parse(await _send(method, path, body, first));
    }

    if (cacheDuration == Duration.zero) return _cache.withRetries(load);
    final principal = AnswerCache.principalOf(token!);
    if (_principal != null && principal != _principal) _cache.clear();
    _principal = principal;
    return _cache.get(AnswerCache.key(principal, method, path, body), load, lifetimeOf, fresh: fresh);
  }

  /// Every system's status, sorted by id: `GET /api/systems`. Roots only;
  /// anyone else's token gets an empty list (P1).
  Future<List<SystemStatus>> systems() async {
    final json = await _send('GET', '/api/systems');
    return List.unmodifiable(
      (json['systems'] as List<Object?>).map((s) => SystemStatus.fromJson(s as Map<String, Object?>)),
    );
  }

  /// Redeems a voucher for the token's owner and returns the grant of its
  /// first role (V4); [redeemVoucherGrants] returns them all. A voucher that
  /// needs payment throws [RbacrPaymentRequired] (V4a).
  /// The user's roles change, so kept answers are dropped.
  Future<Grant> redeemVoucher(String code) async {
    final json = await _send('POST', '/api/vouchers/redeem', {'code': code});
    _cache.clear();
    return Grant.fromJson(json);
  }

  /// Redeems a voucher for the token's owner and returns a grant for each of
  /// its roles (V4).
  Future<List<Grant>> redeemVoucherGrants(String code) async {
    final json = await _send('POST', '/api/vouchers/redeem', {'code': code});
    _cache.clear();
    final grants = (json['grants'] as List<Object?>?) ?? [json];
    return List.unmodifiable(grants.map((g) => Grant.fromJson(g as Map<String, Object?>)));
  }

  /// Creates a voucher granting [roles] in [systemId], or without a system a
  /// global voucher granting [grants], roles of any systems, each in its own
  /// (V1); roots only, so call it from your server, never an app. Pass one
  /// of [grants] (global only), [roles] or a single [role]: a global voucher
  /// given [roles] grants them by name, in every system that has them. [code] is a code of
  /// your own; without one rbacr makes one up from the quarter and animal
  /// names (V2). [discountPercent] defaults to 100 (free); [endsAt] is
  /// exclusive.
  Future<Voucher> createVoucher({
    String? systemId,
    List<String>? roles,
    String? role,
    List<SystemRole>? grants,
    String? code,
    int? discountPercent,
    DateTime? startsAt,
    DateTime? endsAt,
    int? maxUses,
  }) async {
    if ([roles, role, grants].where((v) => v != null).length != 1) {
      throw ArgumentError('Pass one of grants, roles or role');
    }
    if (grants != null && systemId != null) throw ArgumentError('Only a global voucher takes grants');
    return Voucher.fromJson(
      await _send('POST', _vouchersPath(systemId), {
        'roles': ?roles,
        'role': ?role,
        'grants': ?grants?.map((g) => g.toJson()).toList(),
        'code': ?code,
        'discountPercent': ?discountPercent,
        'startsAt': ?startsAt?.toUtc().toIso8601String(),
        'endsAt': ?endsAt?.toUtc().toIso8601String(),
        'maxUses': ?maxUses,
      }),
    );
  }

  /// The vouchers of [systemId], or the global vouchers without a system,
  /// newest first, disabled ones included (V6); roots only.
  Future<List<Voucher>> listVouchers({String? systemId}) async {
    final json = await _send('GET', _vouchersPath(systemId));
    return List.unmodifiable(
      (json['vouchers'] as List<Object?>).map((v) => Voucher.fromJson(v as Map<String, Object?>)),
    );
  }

  /// Deletes a voucher, system or global, and returns it. Deletion is
  /// logical (L1): rbacr disables it for good, records `disabledBy`, and
  /// keeps it listed for auditing (V6). Grants already redeemed stay.
  /// Removing its role or deleting its system disables it too (L3). Roots only.
  Future<Voucher> disableVoucher(String code) async =>
      Voucher.fromJson(await _send('DELETE', '/api/vouchers/${Uri.encodeComponent(code)}'));

  /// A voucher's redemptions, each with all its details (V7), newest first;
  /// roots only.
  Future<List<RedeemEvent>> listRedemptions(String code) async {
    final json = await _send('GET', '/api/vouchers/${Uri.encodeComponent(code)}/redemptions');
    return List.unmodifiable(
      (json['redemptions'] as List<Object?>).map((e) => RedeemEvent.fromJson(e as Map<String, Object?>)),
    );
  }

  /// Failed redeem attempts (V9), newest first; roots only. With [code],
  /// that voucher's (404 if there is none); without, the latest 100 of every
  /// voucher, unknown codes included.
  Future<List<RedeemFailure>> listRedeemFailures({String? code}) async {
    final json = await _send(
      'GET',
      code == null ? '/api/redeem-failures' : '/api/vouchers/${Uri.encodeComponent(code)}/failures',
    );
    return List.unmodifiable(
      (json['failures'] as List<Object?>).map((f) => RedeemFailure.fromJson(f as Map<String, Object?>)),
    );
  }

  static String _vouchersPath(String? systemId) =>
      systemId == null ? '/api/vouchers' : '/api/systems/${Uri.encodeComponent(systemId)}/vouchers';

  /// Closes the HTTP client, unless it was passed in, and drops kept answers.
  void close() {
    _cache.clear();
    if (_ownsHttp) _http.close();
  }

  Future<String> _currentToken() async {
    try {
      return await Future.value(_token()).timeout(timeout);
    } catch (e) {
      // Never the token itself: the provider's failure, e.g. no signed-in user.
      throw RbacrException('Could not get a token for rbacr', cause: e);
    }
  }

  Future<Map<String, Object?>> _send(String method, String path, [Map<String, Object?>? body, String? token]) async {
    token ??= await _currentToken();
    // rbacr's API never redirects; not following one keeps the token from going elsewhere.
    final request = http.Request(method, baseUrl.resolve(path))
      ..followRedirects = false
      ..headers['authorization'] = 'Bearer $token'
      ..headers['accept'] = 'application/json';
    if (body != null) {
      request
        ..headers['content-type'] = 'application/json'
        ..body = jsonEncode(body);
    }
    final http.Response response;
    try {
      response = await _http.send(request).then(http.Response.fromStream).timeout(timeout);
    } on TimeoutException catch (e) {
      throw RbacrException('rbacr did not answer within $timeout', cause: e);
    } on http.ClientException catch (e) {
      throw RbacrException('Could not reach rbacr: ${e.message}', cause: e);
    } on Exception catch (e) {
      // Platform clients (TLS handshakes, sockets) may throw their own types.
      throw RbacrException('Could not reach rbacr', cause: e);
    }
    final Object? json;
    try {
      json = jsonDecode(utf8.decode(response.bodyBytes));
    } on FormatException catch (e) {
      throw RbacrException(
        'rbacr answered ${response.statusCode} without JSON',
        statusCode: response.statusCode,
        cause: e,
      );
    }
    if (json is! Map<String, Object?>) {
      throw RbacrException(
        'rbacr answered ${response.statusCode} with unexpected JSON',
        statusCode: response.statusCode,
      );
    }
    if (response.statusCode >= 200 && response.statusCode < 300) return json;
    final message = json['error'] is String ? json['error'] as String : 'rbacr answered ${response.statusCode}';
    final payment = json['payment'];
    if (response.statusCode == 402 && payment is Map<String, Object?>) {
      throw RbacrPaymentRequired(message, Payment.fromJson(payment));
    }
    throw RbacrException(message, statusCode: response.statusCode);
  }
}
