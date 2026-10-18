import 'dart:async';
import 'dart:convert';

import 'errors.dart';

/// Monotonic time since some fixed point: unlike the device's wall clock, a
/// user can't change it to keep a cached answer alive.
typedef RbacrClock = Duration Function();

/// The default [RbacrClock]: a stopwatch started when it is first read.
RbacrClock monotonicClock() {
  final watch = Stopwatch()..start();
  return () => watch.elapsed;
}

/// Kept answers are refreshed in the background once this share of their
/// life has passed, so the app keeps getting them instantly.
const _refreshAt = 0.8;

/// A failed background refresh isn't tried again sooner than this.
const _minRefreshInterval = Duration(seconds: 30);

class _Entry {
  _Entry(this.value, this.refreshAt, this.expiresAt);

  final Object? value;
  final Duration refreshAt;
  final Duration expiresAt;
  Duration? lastRefresh;
}

/// rbacr's answers, kept per caller and request (SPEC C6): never errors,
/// never past their lifetime (a "yes" not past its `ttl`, C3a), refreshed in
/// the background before they expire, and loaded once for concurrent
/// callers. In memory only, bounded by [maxEntries] (oldest dropped first).
class AnswerCache {
  AnswerCache({required this.clock, required this.maxEntries, required this.retryDelays});

  final RbacrClock clock;
  final int maxEntries;

  /// The waits before each retry of a failed load that may succeed later.
  final List<Duration> retryDelays;

  final _entries = <String, _Entry>{};
  final _inFlight = <String, Future<Object?>>{};

  /// Bumped by [clear]: a load started before it doesn't store its answer.
  int _generation = 0;

  /// The key of a request made as [principal] (see [principalOf]).
  static String key(String principal, String method, String path, [Map<String, Object?>? body]) =>
      '$principal\n$method $path\n${body == null ? '' : jsonEncode(body)}';

  /// The kept answer for [key], or a newly loaded one. [lifetimeOf] says how
  /// long an answer may be kept (zero: not at all). A kept answer in the last
  /// part of its life is returned at once and refreshed in the background.
  Future<T> get<T>(String key, Future<T> Function() load, Duration Function(T) lifetimeOf, {bool fresh = false}) async {
    final entry = _entries[key];
    final now = clock();
    if (!fresh && entry != null && now < entry.expiresAt) {
      if (now >= entry.refreshAt) _refreshInBackground(key, entry, load, lifetimeOf, now);
      return entry.value as T;
    }
    if (entry != null) _entries.remove(key);
    return _load(key, load, lifetimeOf, shared: !fresh);
  }

  /// Drops every kept answer (sign-out, another user, a redemption).
  void clear() {
    _entries.clear();
    _generation++;
  }

  int get length => _entries.length;

  Future<T> _load<T>(String key, Future<T> Function() load, Duration Function(T) lifetimeOf, {bool shared = true}) {
    final pending = _inFlight[key];
    if (shared && pending != null) return pending.then((v) => v as T);
    final generation = _generation;
    // Lifetimes count from the request, not the answer: latency only shortens them.
    final startedAt = clock();
    final future = withRetries(load).then((value) {
      if (generation == _generation) _store(key, value, lifetimeOf(value), startedAt);
      return value;
    });
    if (shared) {
      _inFlight[key] = future;
      future.then((_) => null, onError: (_) => null).whenComplete(() {
        if (identical(_inFlight[key], future)) _inFlight.remove(key);
      });
    }
    return future;
  }

  void _refreshInBackground<T>(
    String key,
    _Entry entry,
    Future<T> Function() load,
    Duration Function(T) lifetimeOf,
    Duration now,
  ) {
    if (_inFlight.containsKey(key)) return;
    final last = entry.lastRefresh;
    if (last != null && now - last < _minRefreshInterval) return;
    entry.lastRefresh = now;
    // The kept answer stays until it expires; a failure here is tried again later.
    unawaited(_load(key, load, lifetimeOf).then((_) {}, onError: (Object _) {}));
  }

  void _store(String key, Object? value, Duration lifetime, Duration startedAt) {
    _entries.remove(key);
    if (lifetime <= Duration.zero) return;
    while (_entries.length >= maxEntries) {
      _entries.remove(_entries.keys.first);
    }
    _entries[key] = _Entry(value, startedAt + lifetime * _refreshAt, startedAt + lifetime);
  }

  /// [load], tried again after each of [retryDelays] while it fails in a way
  /// that may pass: rbacr unreachable or slow, 5xx, or 429.
  Future<T> withRetries<T>(Future<T> Function() load) async {
    for (var attempt = 0; ; attempt++) {
      try {
        return await load();
      } on RbacrException catch (e) {
        if (attempt >= retryDelays.length || !transient(e)) rethrow;
        await Future<void>.delayed(retryDelays[attempt]);
      }
    }
  }

  /// A failure that a later try may not have: no answer, 5xx, or 429.
  static bool transient(RbacrException e) {
    final status = e.statusCode;
    return status == null || status >= 500 || status == 429;
  }

  /// Who a token acts as, for keeping answers apart: an ID token's issuer
  /// and subject (read, not verified: it only keys the cache, and rbacr
  /// verifies the token itself), else the token itself (a personal token
  /// stays the same person). Never logged.
  static String principalOf(String token) {
    final parts = token.split('.');
    if (parts.length == 3) {
      try {
        final claims = jsonDecode(utf8.decode(base64Url.decode(base64Url.normalize(parts[1]))));
        if (claims is Map<String, Object?>) {
          final who = claims['sub'] ?? claims['email'];
          if (who is String) return 'jwt\n${claims['iss']}\n$who';
        }
      } catch (_) {
        // Not a JWT after all: keyed by the token as a whole.
      }
    }
    return 'token\n$token';
  }
}
