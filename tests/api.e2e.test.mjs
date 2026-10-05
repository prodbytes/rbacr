// End-to-end test of the external API (/api, personal API tokens), the
// VPI (/vpi, view programming interface: session cookie, frontend only) and the pages,
// against a running dev server (`devbox services up` or `npm run dev`) with
// RBACR_DEV_LOGIN=1 and RBACR_ROOT_LIST containing the root below (default:
// e2e.test). Each person signs in through /login/dev, then mints an API token
// through /vpi the way the /me page does, and uses it on /api.
//
//   RBACR_E2E_URL=http://127.0.0.1:5173 npm run test:e2e
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const BASE = process.env.RBACR_E2E_URL ?? 'http://127.0.0.1:5173';
const ROOT = process.env.RBACR_E2E_ROOT ?? 'root@e2e.test';
const ADMIN = 'admin@partner.test';
const USER = 'user@partner.test';
const OTHER = 'other@partner.test';
const SYSTEM = `e2e-${Date.now()}`;

async function login(email) {
	const res = await fetch(`${BASE}/login/dev`, {
		method: 'POST',
		redirect: 'manual',
		headers: { origin: BASE, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({ email })
	});
	assert.equal(res.status, 303, `dev login for ${email} failed; is RBACR_DEV_LOGIN=1 set?`);
	const cookie = res.headers.getSetCookie().find((c) => c.startsWith('rbacr_session='));
	assert.ok(cookie, 'no session cookie');
	return cookie.split(';')[0];
}

async function call(path, { method = 'GET', headers = {}, body } = {}) {
	const res = await fetch(`${BASE}${path}`, {
		method,
		headers: { accept: 'application/json', ...(body !== undefined && { 'content-type': 'application/json' }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const text = await res.text();
	return { status: res.status, body: text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text };
}

// What the frontend's fetches look like (src/lib/vpi.ts plus the browser's own headers).
const FRONTEND = { 'x-rbacr-vpi': '1', 'sec-fetch-site': 'same-origin', origin: BASE };
const vpi = (cookie, method, path, body) => call(`/vpi${path}`, { method, body, headers: { cookie, ...FRONTEND } });

/** An /api client acting as the token's owner. */
function client(token) {
	return (method, path, body) => call(path, { method, body, headers: { authorization: `Bearer ${token}` } });
}

/** Signs in and mints a personal API token through the VPI. */
async function tokenFor(email) {
	const cookie = await login(email);
	const res = await vpi(cookie, 'POST', '/tokens', { name: 'e2e', expiresInDays: 1 });
	assert.equal(res.status, 201, JSON.stringify(res.body));
	return { cookie, token: res.body.token, id: res.body.id };
}

describe('rbacr API', { skip: !(await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) && `no server at ${BASE}` }, () => {
	let root, admin, user, other, voucher, creds;

	it('signs in roots, admins and users, who mint API tokens', async () => {
		creds = await Promise.all([ROOT, ADMIN, USER, OTHER].map(tokenFor));
		[root, admin, user, other] = creds.map((c) => client(c.token));
		const me = await root('GET', '/api/me');
		assert.equal(me.status, 200);
		assert.equal(me.body.root, true, `${ROOT} must be in RBACR_ROOT_LIST`);
		assert.deepEqual(me.body.globalRoles, ['root']);
		assert.deepEqual((await user('GET', '/api/me')).body.globalRoles, []);
	});

	it('keeps /api and /vpi apart', async () => {
		const { cookie, token } = creds[2];
		// /api: tokens only; the session cookie means nothing there.
		assert.equal((await call('/api/me', { headers: { cookie } })).status, 401);
		assert.equal((await call('/api/me', { headers: { authorization: 'Bearer rbacr_bogus' } })).status, 401);
		assert.equal((await call('/api/nope')).status, 401);
		assert.equal((await client(token)('GET', '/api/nope')).status, 404);
		// /vpi: only the frontend, only with the session.
		assert.equal((await vpi(cookie, 'GET', '/me')).status, 200);
		assert.equal((await call('/vpi/me', { headers: { cookie } })).status, 403);
		assert.equal((await call('/vpi/me', { headers: { cookie, ...FRONTEND, 'sec-fetch-site': 'cross-site' } })).status, 403);
		assert.equal((await call('/vpi/me', { method: 'POST', headers: { cookie, ...FRONTEND, origin: 'https://evil.example' } })).status, 403);
		assert.equal((await call('/vpi/me', { headers: { authorization: `Bearer ${token}`, ...FRONTEND } })).status, 401);
		assert.equal((await call('/vpi/tokens', { headers: { authorization: `Bearer ${token}` } })).status, 403);
	});

	it('lets people list and revoke their own tokens', async () => {
		const { cookie } = creds[3];
		const extra = await vpi(cookie, 'POST', '/tokens', { name: 'short-lived' });
		assert.equal((await client(extra.body.token)('GET', '/api/me')).status, 200);
		const listed = (await vpi(cookie, 'GET', '/tokens')).body.tokens.map((t) => t.name);
		assert.ok(listed.includes('short-lived') && listed.includes('e2e'));
		assert.equal((await vpi(creds[2].cookie, 'DELETE', `/tokens/${extra.body.id}`)).status, 404); // not theirs
		assert.equal((await vpi(cookie, 'DELETE', `/tokens/${extra.body.id}`)).status, 200);
		assert.equal((await client(extra.body.token)('GET', '/api/me')).status, 401);
	});

	it('lets roots create systems and grant the admin role', async () => {
		const created = await root('POST', '/api/systems', { id: SYSTEM, name: 'E2E', roles: ['viewer'] });
		assert.equal(created.status, 201);
		assert.deepEqual(created.body.roles, ['admin', 'viewer']);
		const granted = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'admin', grantee: ADMIN });
		assert.equal(granted.status, 201);
		assert.deepEqual((await root('GET', '/api/me')).body.roles[SYSTEM], ['admin', 'viewer']);
	});

	it('stops admins from propagating admin or granting domains', async () => {
		const me = await admin('GET', '/api/me');
		assert.deepEqual(me.body.adminOf, [SYSTEM]);
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/grants`, { role: 'admin', grantee: USER })).status, 403);
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee: 'partner.test' })).status, 403);
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'admin' })).status, 403);
	});

	it('lets admins issue single-use vouchers that users redeem', async () => {
		const created = await admin('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'viewer', maxUses: 1 });
		assert.equal(created.status, 201);
		voucher = created.body.code;
		assert.equal(created.body.status, 'active');

		const redeemed = await user('POST', '/api/vouchers/redeem', { code: voucher.toLowerCase() });
		assert.equal(redeemed.status, 200);
		assert.deepEqual((await user('GET', '/api/me')).body.roles, { [SYSTEM]: ['viewer'] });

		const exhausted = await other('POST', '/api/vouchers/redeem', { code: voucher });
		assert.equal(exhausted.status, 409);
		assert.match(exhausted.body.error, /no uses left/);
	});

	it('lists only manageable systems and hides admin vouchers from admins', async () => {
		const adminVoucher = await root('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'admin', endsAt: '2099-01-01T00:00:00Z' });
		assert.equal(adminVoucher.status, 201);
		const seenByAdmin = await admin('GET', `/api/systems/${SYSTEM}/vouchers`);
		assert.deepEqual(seenByAdmin.body.vouchers.map((v) => v.role), ['viewer']);
		const seenByRoot = await root('GET', `/api/systems/${SYSTEM}/vouchers`);
		assert.deepEqual(seenByRoot.body.vouchers.map((v) => v.role).sort(), ['admin', 'viewer']);
		assert.equal((await admin('DELETE', `/api/vouchers/${adminVoucher.body.code}`)).status, 404);
		assert.equal((await root('DELETE', `/api/vouchers/${adminVoucher.body.code}`)).body.status, 'disabled');
		assert.deepEqual((await admin('GET', '/api/systems')).body.systems.map((s) => s.id), [SYSTEM]);
	});

	it('gives implied roles, set only by roots', async () => {
		for (const role of ['free', 'premium']) await root('POST', `/api/systems/${SYSTEM}/roles`, { role });
		const set = await root('PUT', `/api/systems/${SYSTEM}/roles/premium`, { implies: ['free'] });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.deepEqual(set.body.implies, { premium: ['free'] });
		assert.equal((await admin('PUT', `/api/systems/${SYSTEM}/roles/premium`, { implies: [] })).status, 403);
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/free`, { implies: ['premium'] })).status, 400);
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/free`, { implies: ['admin'] })).status, 400);
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/grants`, { role: 'premium', grantee: OTHER })).status, 201);
		assert.deepEqual((await other('GET', '/api/me')).body.roles[SYSTEM], ['free', 'premium']);
		assert.equal((await admin('POST', '/api/check', { email: OTHER, systemId: SYSTEM, role: 'free' })).body.allowed, true);
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/roles/premium`)).status, 204);
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/roles/free`)).status, 204);
		assert.equal((await other('GET', '/api/me')).body.roles[SYSTEM], undefined);
	});

	it('lets roots issue global vouchers; paid ones answer 402', async () => {
		const role = `e2e${Date.now()}`;
		assert.equal((await root('POST', `/api/systems/${SYSTEM}/roles`, { role })).status, 200);
		assert.equal((await admin('POST', '/api/vouchers', { role })).status, 403);

		const free = await root('POST', '/api/vouchers', { role, maxUses: 5 });
		assert.equal(free.status, 201);
		assert.equal(free.body.systemId, null);
		assert.equal(free.body.discountPercent, 100);
		assert.equal((await other('POST', '/api/vouchers/redeem', { code: free.body.code })).status, 200);
		const me = (await other('GET', '/api/me')).body;
		assert.deepEqual(me.globalRoles, [role]);
		assert.deepEqual(me.roles[SYSTEM], [role]);

		const paid = await root('POST', '/api/vouchers', { role, discountPercent: 25 });
		const res = await user('POST', '/api/vouchers/redeem', { code: paid.body.code });
		assert.equal(res.status, 402);
		assert.deepEqual(res.body.payment, { code: paid.body.code, systemId: null, role, discountPercent: 25 });

		assert.equal((await root('DELETE', '/api/global-grants', { role, grantee: OTHER })).status, 204);
		assert.deepEqual((await other('GET', '/api/me')).body.globalRoles, []);
		for (const v of [free.body.code, paid.body.code]) await root('DELETE', `/api/vouchers/${v}`);
	});

	it('answers role checks within the caller\'s permissions', async () => {
		const check = (who, body) => who('POST', '/api/check', body);
		assert.equal((await check(root, { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed, true);
		assert.equal((await check(root, { email: USER, systemId: SYSTEM, role: 'admin' })).body.allowed, false);
		assert.equal((await check(root, { email: ROOT, role: 'root' })).body.allowed, true);
		assert.equal((await check(admin, { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed, true);
		assert.equal((await check(admin, { email: USER, role: 'root' })).status, 403);
		assert.equal((await check(user, { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed, true);
		assert.equal((await check(user, { email: ADMIN, systemId: SYSTEM, role: 'admin' })).status, 403);
		assert.deepEqual((await admin('POST', '/api/roles', { email: USER, systemId: SYSTEM })).body, {
			email: USER,
			systemId: SYSTEM,
			roles: ['viewer']
		});
		assert.deepEqual((await user('POST', '/api/roles', { email: USER })).body.roles[SYSTEM], ['viewer']);
		assert.equal((await user('POST', '/api/roles', { email: OTHER })).status, 403);
	});

	it('keeps regular users out of management', async () => {
		assert.deepEqual((await user('GET', '/api/systems')).body, { systems: [] });
		assert.equal((await user('POST', '/api/systems', { id: 'nope' })).status, 403);
		assert.equal((await user('GET', `/api/systems/${SYSTEM}/grants`)).status, 403);
	});

	it('renders roles in the UI', async () => {
		const res = await fetch(`${BASE}/me`, { headers: { cookie: creds[2].cookie, accept: 'text/html' } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, new RegExp(SYSTEM));
		assert.match(html, /viewer/);
	});

	it('validates input with JSON errors', async () => {
		const bad = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee: 'not an email' });
		assert.equal(bad.status, 400);
		assert.match(bad.body.error, /Invalid grantee/);
		assert.equal((await root('POST', '/api/systems', 'nope')).status, 400);
	});

	it('lets roots delete systems', async () => {
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}`)).status, 204);
		assert.deepEqual((await user('GET', '/api/me')).body.roles, {});
	});
});
