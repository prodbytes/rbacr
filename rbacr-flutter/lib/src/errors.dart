import 'models.dart';

/// rbacr answered with an error (SPEC "HTTP interface"), or couldn't be reached.
class RbacrException implements Exception {
  const RbacrException(this.message, {this.statusCode, this.cause});

  /// rbacr's `error` message, or what went wrong reaching it.
  final String message;

  /// The HTTP status; null when rbacr couldn't be reached or answered garbage.
  final int? statusCode;

  /// The underlying error, for failures that never got an answer.
  final Object? cause;

  /// 400: invalid input.
  bool get isBadRequest => statusCode == 400;

  /// 401: missing, unknown, revoked or expired token (T3).
  bool get isUnauthorized => statusCode == 401;

  /// 403: beyond what the token's owner may see (T6).
  bool get isForbidden => statusCode == 403;

  /// 404: unknown system, role or voucher.
  bool get isNotFound => statusCode == 404;

  /// 409: conflict, such as an inactive or already redeemed voucher (V5).
  bool get isConflict => statusCode == 409;

  @override
  String toString() => 'RbacrException(${statusCode ?? 'no answer'}): $message';
}

/// 402: the voucher needs payment, which rbacr doesn't take yet (SPEC V4a).
class RbacrPaymentRequired extends RbacrException {
  const RbacrPaymentRequired(super.message, this.payment) : super(statusCode: 402);

  /// The voucher's terms.
  final Payment payment;
}
