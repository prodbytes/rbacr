/// Effective roles keyed by system id, each list sorted (SPEC R3, R6).
typedef RoleMap = Map<String, List<String>>;

/// The token owner's own roles: `GET /api/me`.
class Me {
  const Me({required this.email, required this.root, required this.globalRoles, required this.roles});

  factory Me.fromJson(Map<String, Object?> json) => Me(
    email: json['email'] as String,
    root: json['root'] as bool,
    globalRoles: _strings(json['globalRoles']),
    roles: _roleMap(json['roles']),
  );

  final String email;

  /// On rbacr's root allow list: holds every role of every system (R2).
  final bool root;

  /// `["root"]` for roots, otherwise the roles of global grants.
  final List<String> globalRoles;

  /// Effective roles in each system, implied roles included.
  final RoleMap roles;

  /// Whether this identity holds [role] in [systemId].
  bool hasRole(String systemId, String role) => roles[systemId]?.contains(role.toLowerCase()) ?? false;
}

/// The answer to "does this identity hold this role?": `POST /api/check` (SPEC C3, C3a).
class RoleCheck {
  const RoleCheck({
    required this.email,
    required this.systemId,
    required this.role,
    required this.allowed,
    required this.expiresAt,
    required this.ttl,
  });

  factory RoleCheck.fromJson(Map<String, Object?> json) => RoleCheck(
    email: json['email'] as String,
    systemId: json['systemId'] as String?,
    role: json['role'] as String,
    allowed: json['allowed'] as bool,
    expiresAt: _date(json['expiresAt']),
    ttl: json['ttl'] == null ? null : Duration(seconds: (json['ttl'] as num).toInt()),
  );

  final String email;

  /// null for a global role (such as `root`).
  final String? systemId;
  final String role;
  final bool allowed;

  /// When allowed: when the grants giving the role end; null if they never do.
  final DateTime? expiresAt;

  /// When allowed: how long this "yes" may be cached at most; null without an end.
  /// Revoking a grant can end the role sooner.
  final Duration? ttl;
}

/// An identity's roles in every system plus its global roles: `POST /api/roles` without a system.
class AllRoles {
  const AllRoles({required this.email, required this.globalRoles, required this.roles});

  factory AllRoles.fromJson(Map<String, Object?> json) => AllRoles(
    email: json['email'] as String,
    globalRoles: _strings(json['globalRoles']),
    roles: _roleMap(json['roles']),
  );

  final String email;
  final List<String> globalRoles;
  final RoleMap roles;
}

/// A system's status: `GET /api/systems/:id/status` (SPEC R12), readable with any token.
class SystemStatus {
  const SystemStatus({required this.id, required this.name, required this.url, required this.maintenance});

  factory SystemStatus.fromJson(Map<String, Object?> json) => SystemStatus(
    id: json['id'] as String,
    name: json['name'] as String,
    url: json['url'] as String?,
    maintenance: json['maintenance'] as bool,
  );

  final String id;
  final String name;

  /// Where the system's users go (R10); null for none.
  final String? url;

  /// In maintenance (R11), rbacr gives nobody any role in this system, roots
  /// included: every check answers no until it is turned off.
  final bool maintenance;
}

/// Whether a grant gives its role now (SPEC G1).
enum GrantStatus {
  active('active'),
  notStarted('not-started'),
  expired('expired');

  const GrantStatus(this.wire);

  /// The value rbacr sends.
  final String wire;

  static GrantStatus parse(String value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => throw FormatException('Unknown grant status "$value"'));
}

/// A grant of a role to a grantee, as the API returns it (SPEC R8, G1).
class Grant {
  const Grant({
    required this.systemId,
    required this.role,
    required this.grantee,
    required this.grantedBy,
    required this.grantedAt,
    required this.startsAt,
    required this.endsAt,
    required this.status,
    required this.voucherCode,
    required this.impliedRoles,
    required this.impliedRolesBySystem,
  });

  factory Grant.fromJson(Map<String, Object?> json) => Grant(
    systemId: json['systemId'] as String?,
    role: json['role'] as String,
    grantee: json['grantee'] as String,
    grantedBy: json['grantedBy'] as String,
    grantedAt: DateTime.parse(json['grantedAt'] as String),
    startsAt: _date(json['startsAt']),
    endsAt: _date(json['endsAt']),
    status: GrantStatus.parse(json['status'] as String),
    voucherCode: json['voucherCode'] as String?,
    impliedRoles: _strings(json['impliedRoles']),
    impliedRolesBySystem: json['impliedRolesBySystem'] == null ? null : _roleMap(json['impliedRolesBySystem']),
  );

  /// null for a global grant: the role in every system that defines it.
  final String? systemId;
  final String role;

  /// An address, or a whole domain as `@example.com`.
  final String grantee;
  final String grantedBy;
  final DateTime grantedAt;

  /// null: valid immediately.
  final DateTime? startsAt;

  /// Exclusive; null: valid forever.
  final DateTime? endsAt;
  final GrantStatus status;
  final String? voucherCode;

  /// Roles the granted role implies in its system (empty for global grants).
  final List<String> impliedRoles;

  /// For global grants: the implied roles in each system that defines the role.
  final RoleMap? impliedRolesBySystem;

  bool get isGlobal => systemId == null;
}

/// Whether a voucher can be redeemed now (SPEC V3).
enum VoucherStatus {
  active('active'),
  disabled('disabled'),
  notStarted('not-started'),
  expired('expired'),
  exhausted('exhausted');

  const VoucherStatus(this.wire);

  /// The value rbacr sends.
  final String wire;

  static VoucherStatus parse(String value) =>
      values.firstWhere((s) => s.wire == value, orElse: () => throw FormatException('Unknown voucher status "$value"'));
}

/// A voucher, as the API returns it to roots (SPEC V1-V6).
class Voucher {
  const Voucher({
    required this.code,
    required this.systemId,
    required this.roles,
    required this.role,
    required this.discountPercent,
    required this.startsAt,
    required this.endsAt,
    required this.maxUses,
    required this.uses,
    required this.status,
    required this.createdBy,
    required this.createdAt,
    required this.disabledAt,
    required this.disabledBy,
  });

  factory Voucher.fromJson(Map<String, Object?> json) => Voucher(
    code: json['code'] as String,
    systemId: json['systemId'] as String?,
    roles: _rolesOf(json),
    role: json['role'] as String,
    discountPercent: (json['discountPercent'] as num).toInt(),
    startsAt: _date(json['startsAt']),
    endsAt: _date(json['endsAt']),
    maxUses: (json['maxUses'] as num?)?.toInt(),
    uses: (json['uses'] as num).toInt(),
    status: VoucherStatus.parse(json['status'] as String),
    createdBy: json['createdBy'] as String,
    createdAt: DateTime.parse(json['createdAt'] as String),
    disabledAt: _date(json['disabledAt']),
    disabledBy: json['disabledBy'] as String?,
  );

  /// Upper case, words separated by dashes, e.g. `2026Q4-OTTER-FALCON-LEMUR`;
  /// matched ignoring case and separators (V2).
  final String code;

  /// null for a global voucher: redeeming it makes a global grant.
  final String? systemId;

  /// The roles redeeming it grants, sorted (V1).
  final List<String> roles;

  /// The first of [roles], as rbacr reported before vouchers had several.
  final String role;

  /// 100 grants the roles on redemption; lower needs payment (V4a).
  final int discountPercent;

  /// null: redeemable immediately.
  final DateTime? startsAt;

  /// Exclusive; null: redeemable forever.
  final DateTime? endsAt;

  /// null: no limit.
  final int? maxUses;
  final int uses;
  final VoucherStatus status;
  final String createdBy;
  final DateTime createdAt;

  /// When it was disabled, for good (V6).
  final DateTime? disabledAt;

  /// Who disabled it: a root, directly or by removing its role or system (L3).
  final String? disabledBy;

  bool get isGlobal => systemId == null;
}

/// The terms of a voucher that needs payment (SPEC V4a), sent with a 402.
class Payment {
  const Payment({
    required this.code,
    required this.systemId,
    required this.roles,
    required this.role,
    required this.discountPercent,
  });

  factory Payment.fromJson(Map<String, Object?> json) => Payment(
    code: json['code'] as String,
    systemId: json['systemId'] as String?,
    roles: _rolesOf(json),
    role: json['role'] as String,
    discountPercent: (json['discountPercent'] as num).toInt(),
  );

  final String code;
  final String? systemId;

  /// The roles the voucher grants (V1).
  final List<String> roles;

  /// The first of [roles].
  final String role;
  final int discountPercent;
}

/// What redeeming a voucher did to one of its roles (SPEC V7).
class RedeemedGrant {
  const RedeemedGrant({required this.systemId, required this.role, required this.outcome, required this.replaced});

  factory RedeemedGrant.fromJson(Map<String, Object?> json) => RedeemedGrant(
    systemId: json['systemId'] as String?,
    role: json['role'] as String,
    outcome: json['outcome'] as String,
    replaced: json['replaced'] as Map<String, Object?>?,
  );

  final String? systemId;
  final String role;

  /// `granted` (no live grant before), `kept` (one already gave the role now
  /// and forever) or `replaced` (the earlier grant, in [replaced], gave way).
  final String outcome;

  /// The replaced grant as it was: grantedBy, grantedAt, startsAt, endsAt, voucherCode.
  final Map<String, Object?>? replaced;
}

/// A voucher redemption with all its details (SPEC V7). Redemptions recorded
/// before V7 have only [email] and [redeemedAt]; the rest is null or empty.
class RedeemEvent {
  const RedeemEvent({
    required this.id,
    required this.code,
    required this.systemId,
    required this.roles,
    required this.discountPercent,
    required this.voucherCreatedBy,
    required this.email,
    required this.redeemedAt,
    required this.via,
    required this.grants,
  });

  factory RedeemEvent.fromJson(Map<String, Object?> json) => RedeemEvent(
    id: json['id'] as String?,
    code: json['code'] as String,
    systemId: json['systemId'] as String?,
    roles: _strings(json['roles']),
    discountPercent: (json['discountPercent'] as num?)?.toInt(),
    voucherCreatedBy: json['voucherCreatedBy'] as String?,
    email: json['email'] as String,
    redeemedAt: DateTime.parse(json['redeemedAt'] as String),
    via: json['via'] as String?,
    grants: List.unmodifiable(
      (json['grants'] as List<Object?>).map((g) => RedeemedGrant.fromJson(g as Map<String, Object?>)),
    ),
  );

  final String? id;
  final String code;
  final String? systemId;
  final List<String> roles;
  final int? discountPercent;
  final String? voucherCreatedBy;

  /// Who redeemed it.
  final String email;
  final DateTime redeemedAt;

  /// `api` or `page`: through the external API or rbacr's own pages.
  final String? via;
  final List<RedeemedGrant> grants;
}

/// A voucher's `roles`, or its single `role` from servers that predate several.
List<String> _rolesOf(Map<String, Object?> json) =>
    json['roles'] == null ? List.unmodifiable([json['role'] as String]) : _strings(json['roles']);

List<String> _strings(Object? value) => List.unmodifiable((value as List<Object?>).cast<String>());

RoleMap _roleMap(Object? value) =>
    Map.unmodifiable((value as Map<String, Object?>).map((k, v) => MapEntry(k, _strings(v))));

DateTime? _date(Object? value) => value == null ? null : DateTime.parse(value as String);

/// A redeem attempt that failed (SPEC V9): who tried which code, when, how,
/// and the answer they got.
class RedeemFailure {
  const RedeemFailure({
    required this.id,
    required this.code,
    required this.known,
    required this.systemId,
    required this.email,
    required this.attemptedAt,
    required this.via,
    required this.status,
    required this.reason,
  });

  factory RedeemFailure.fromJson(Map<String, Object?> json) => RedeemFailure(
    id: json['id'] as String,
    code: json['code'] as String,
    known: json['known'] as bool,
    systemId: json['systemId'] as String?,
    email: json['email'] as String,
    attemptedAt: DateTime.parse(json['attemptedAt'] as String),
    via: json['via'] as String,
    status: (json['status'] as num).toInt(),
    reason: json['reason'] as String,
  );

  final String id;

  /// The voucher's code; for an unknown code, what was typed, normalized.
  final String code;

  /// Whether the code named a voucher (false: the attempt got 404).
  final bool known;

  /// The voucher's system; null for a global or unknown voucher.
  final String? systemId;

  /// Who tried.
  final String email;
  final DateTime attemptedAt;

  /// `api` or `page`: through the external API or rbacr's own pages.
  final String via;

  /// The HTTP status the attempt got: 402, 404 or 409.
  final int status;

  /// The error message the attempt got.
  final String reason;
}
