import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

import 'errors.dart';
import 'models.dart';

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
  /// [baseUrl] defaults to [production]. Pass either a fixed [token] or a
  /// [tokenProvider]. Only `https` URLs are accepted, except for localhost
  /// during development, so the token never travels in clear text.
  RbacrClient({
    Uri? baseUrl,
    String? token,
    RbacrTokenProvider? tokenProvider,
    http.Client? httpClient,
    this.timeout = const Duration(seconds: 10),
  }) : baseUrl = baseUrl ?? production,
       _token = tokenProvider ?? _fixed(token),
       _http = httpClient ?? http.Client(),
       _ownsHttp = httpClient == null {
    if ((token == null) == (tokenProvider == null)) {
      throw ArgumentError('Pass exactly one of token and tokenProvider');
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

  final Uri baseUrl;

  /// Per request; a request that takes longer fails with [RbacrException].
  final Duration timeout;

  final RbacrTokenProvider _token;
  final http.Client _http;
  final bool _ownsHttp;

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

  /// Redeems a voucher for the token's owner and returns the grant (V4). A
  /// voucher that needs payment throws [RbacrPaymentRequired] (V4a).
  Future<Grant> redeemVoucher(String code) async =>
      Grant.fromJson(await _send('POST', '/api/vouchers/redeem', {'code': code}));

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
