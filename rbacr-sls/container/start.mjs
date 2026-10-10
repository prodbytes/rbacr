// Entrypoint of the local rbacr image (Containerfile): starts DynamoDB Local,
// then the production server against it, with a bootstrap API token (SPEC T7)
// so apps can call /api without signing in. Node, not a shell script: the
// runtime image has no shell.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';

const DATA = '/data';
const TOKEN_FILE = `${DATA}/bootstrap-token`;
const DYNAMODB_PORT = 8000;

const dynamodb = spawn(
	'/opt/jre/bin/java',
	['-jar', '/opt/dynamodb/DynamoDBLocal.jar', '-sharedDb', '-dbPath', DATA, '-port', String(DYNAMODB_PORT)],
	{ cwd: '/opt/dynamodb', stdio: 'inherit' }
);
// Whatever stops DynamoDB Local stops the container; signals stop it first.
let stopping = false;
dynamodb.on('exit', (code) => process.exit(stopping ? 0 : (code ?? 1)));
for (const signal of ['SIGTERM', 'SIGINT']) {
	process.on(signal, () => {
		stopping = true;
		dynamodb.kill('SIGTERM');
	});
}

const reachable = () =>
	new Promise((resolve) => {
		const socket = connect(DYNAMODB_PORT, '127.0.0.1', () => {
			socket.end();
			resolve(true);
		}).on('error', () => resolve(false));
	});
for (let i = 0; !(await reachable()); i++) {
	if (i === 300) throw new Error('DynamoDB Local did not start');
	await new Promise((r) => setTimeout(r, 100));
}

// The token: RBACR_BOOTSTRAP_TOKEN, else RBACR_TOKEN (what the clients send,
// so one .env serves both), else one generated on the first start and kept in
// the data volume, so it survives restarts.
let token = process.env.RBACR_BOOTSTRAP_TOKEN || process.env.RBACR_TOKEN;
if (!token) {
	try {
		token = readFileSync(TOKEN_FILE, 'utf8').trim();
	} catch {
		token = 'rbacr_' + randomBytes(32).toString('base64url');
		writeFileSync(TOKEN_FILE, token + '\n', { mode: 0o600 });
	}
	console.log(`rbacr: API token of ${process.env.RBACR_BOOTSTRAP_EMAIL}: ${token}`);
}
process.env.RBACR_BOOTSTRAP_TOKEN = token;
process.env.RBACR_DYNAMODB_ENDPOINT = `http://127.0.0.1:${DYNAMODB_PORT}`;

await import('./build/index.js');
