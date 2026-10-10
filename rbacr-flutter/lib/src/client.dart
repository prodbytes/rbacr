import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models.dart';
import 'settings.dart';

/// Supplies the personal API token for each request (SPEC T1-T4), e.g. from
/// secure storage, so it can change without a new client.
typedef RbacrTokenProvider = FutureOr<String> Function();

/// A client for rbacr's external API (`/api`), authenticated with a personal
/// API token. It acts as the token's owner (SPEC T4): anyone may ask about
/// themselves; asking about other people needs a root's token (C2), which
/// must never ship inside an app.
///
/// ```dart
/// final rbacr = RbacrClient(token: myToken);
/// if (await rbacr.allows(email: user.email, systemId: 'presence', role: 'premium')) { ... }
/// ```
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
  }) : baseUrl = baseUrl ?? _settingUrl() ?? production,
       _token = tokenProvider ?? _fixed(token ?? setting(tokenSetting)),
       _http = httpClient ?? http.Client(),
       _ownsHttp = httpClient == null {
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

  final RbacrTokenProvider _token;
  final http.Client _http;
  final bool _ownsHttp;

  static Uri? _settingUrl() {
    final url = setting(urlSetting);
    return url == null ? null : Uri.parse(url);
  }

  static RbacrTokenProvider _fixed(String? token) =>
      () => token!;

  /// The token owner's own roles: `GET /api/me`.
  Future<Me> me() async => Me.fromJson(await _send('GET', '/api/me'));

  /// Whether [email] holds [role] in [systemId], or the global role [role]
  /// without a system (C3), with how long a "yes" holds (C3a). An unknown
  /// system or role throws a 404 [RbacrException] rather than answering no.
  Future<RoleCheck> check({required String email, String? systemId, required String role}) async =>
      RoleCheck.fromJson(await _send('POST', '/api/check', {'email': email, 'systemId': systemId, 'role': role}));

  /// [check] that fails closed (C6): any error, or no answer, means no.
  Future<bool> allows({required String email, String? systemId, required String role}) async {
    try {
      return (await check(email: email, systemId: systemId, role: role)).allowed;
    } on RbacrException {
      return false;
    }
  }

  /// [email]'s effective roles in [systemId], sorted (C4).
  Future<List<String>> rolesIn({required String email, required String systemId}) async {
    final json = await _send('POST', '/api/roles', {'email': email, 'systemId': systemId});
    return List.unmodifiable((json['roles'] as List<Object?>).cast<String>());
  }

  /// [email]'s roles in every system and its global roles (C4).
  Future<AllRoles> allRoles({required String email}) async =>
      AllRoles.fromJson(await _send('POST', '/api/roles', {'email': email}));

  /// [systemId]'s status (R12): name, URL and whether it is in maintenance
  /// (R11). Any token may ask, so an app can tell "down for maintenance"
  /// from a missing role. An unknown system throws a 404 [RbacrException].
  Future<SystemStatus> systemStatus(String systemId) async =>
      SystemStatus.fromJson(await _send('GET', '/api/systems/${Uri.encodeComponent(systemId)}/status'));

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
  Future<Grant> redeemVoucher(String code) async =>
      Grant.fromJson(await _send('POST', '/api/vouchers/redeem', {'code': code}));

  /// Redeems a voucher for the token's owner and returns a grant for each of
  /// its roles (V4).
  Future<List<Grant>> redeemVoucherGrants(String code) async {
    final json = await _send('POST', '/api/vouchers/redeem', {'code': code});
    final grants = (json['grants'] as List<Object?>?) ?? [json];
    return List.unmodifiable(grants.map((g) => Grant.fromJson(g as Map<String, Object?>)));
  }

  /// Creates a voucher granting [roles] in [systemId], or a global voucher
  /// without a system (V1); roots only, so call it from your server, never
  /// an app. Pass [roles], or a single [role] as before. [code] is a code of
  /// your own; without one rbacr makes one up from the quarter and animal
  /// names (V2). [discountPercent] defaults to 100 (free); [endsAt] is
  /// exclusive.
  Future<Voucher> createVoucher({
    String? systemId,
    List<String>? roles,
    String? role,
    String? code,
    int? discountPercent,
    DateTime? startsAt,
    DateTime? endsAt,
    int? maxUses,
  }) async {
    if ((roles == null) == (role == null)) throw ArgumentError('Pass either roles or role');
    return Voucher.fromJson(
      await _send('POST', _vouchersPath(systemId), {
        'roles': ?roles,
        'role': ?role,
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

  static String _vouchersPath(String? systemId) =>
      systemId == null ? '/api/vouchers' : '/api/systems/${Uri.encodeComponent(systemId)}/vouchers';

  /// Closes the HTTP client, unless it was passed in.
  void close() {
    if (_ownsHttp) _http.close();
  }

  Future<Map<String, Object?>> _send(String method, String path, [Map<String, Object?>? body]) async {
    final request = http.Request(method, baseUrl.resolve(path))
      ..headers['authorization'] = 'Bearer ${await _token()}'
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
