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

/// The terms of a voucher that needs payment (SPEC V4a), sent with a 402.
class Payment {
  const Payment({required this.code, required this.systemId, required this.role, required this.discountPercent});

  factory Payment.fromJson(Map<String, Object?> json) => Payment(
    code: json['code'] as String,
    systemId: json['systemId'] as String?,
    role: json['role'] as String,
    discountPercent: (json['discountPercent'] as num).toInt(),
  );

  final String code;
  final String? systemId;
  final String role;
  final int discountPercent;
}

List<String> _strings(Object? value) => List.unmodifiable((value as List<Object?>).cast<String>());

RoleMap _roleMap(Object? value) =>
    Map.unmodifiable((value as Map<String, Object?>).map((k, v) => MapEntry(k, _strings(v))));

DateTime? _date(Object? value) => value == null ? null : DateTime.parse(value as String);
