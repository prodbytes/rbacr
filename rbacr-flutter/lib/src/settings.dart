import 'settings_stub.dart' if (dart.library.io) 'settings_io.dart' as platform;

/// The settings a client takes by default, shared with rbacr's local
/// container (rbacr-sls README, "Local rbacr for your app"): the base URL and
/// the API token.
const urlSetting = 'RBACR_URL';
const tokenSetting = 'RBACR_TOKEN';

/// The process environment, replaceable in tests.
Map<String, String> Function() environment = platform.environment;

/// Whether this is a release (product) build, such as an app for the stores.
const _release = bool.fromEnvironment('dart.vm.product');

/// [name]'s value, or null when unset or empty: first a compile-time define
/// (`--dart-define` or `--dart-define-from-file=.env`, how Flutter apps get
/// them), then the process environment (Dart servers, tests, CLIs). In a
/// release build the token's define is ignored: a define is compiled into the
/// binary, so a shared `.env` would ship a personal API token (SPEC C2) in
/// the app. Apps pass their users' ID tokens with a token provider instead.
String? setting(String name) {
  final defined = switch (name) {
    urlSetting => const String.fromEnvironment(urlSetting),
    tokenSetting => _release ? '' : const String.fromEnvironment(tokenSetting),
    _ => '',
  };
  final value = defined.isNotEmpty ? defined : environment()[name];
  return value == null || value.isEmpty ? null : value;
}
