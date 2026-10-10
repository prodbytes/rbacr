// Asks rbacr whether someone holds a role:
//
//   RBACR_TOKEN=rbacr_… dart run example/example.dart ana@example.com presence premium
import 'dart:io';

import 'package:rbacr/rbacr.dart';

Future<void> main(List<String> args) async {
  if (args.length != 3) {
    stderr.writeln('usage: example.dart <email> <systemId> <role>');
    exit(2);
  }
  final rbacr = RbacrClient(
    baseUrl: Uri.parse(Platform.environment['RBACR_URL'] ?? 'https://rbacr.nu01.com'),
    tokenProvider: () => Platform.environment['RBACR_TOKEN'] ?? (throw StateError('Set RBACR_TOKEN')),
  );
  try {
    final answer = await rbacr.check(email: args[0], systemId: args[1], role: args[2]);
    final until = answer.allowed ? ' (cache for at most ${answer.ttl ?? 'no limit'})' : '';
    print('${answer.email} ${answer.allowed ? 'holds' : 'does not hold'} ${answer.role} in ${answer.systemId}$until');
  } on RbacrException catch (e) {
    stderr.writeln(e);
    exitCode = 1;
  } finally {
    rbacr.close();
  }
}
