// End-to-end test of the external API (/api, personal API tokens), the
// VPI (/vpi, view programming interface: session cookie, frontend only) and the pages,
// against a running dev server (`devbox services up` or `npm run dev`) with
// RBACR_DEV_LOGIN=1 and RBACR_ROOT_LIST containing the root below (default:
// e2e.test). Each person signs in through /login/dev, then mints an API token
// through /vpi the way the /me page does, and uses it on /api. With
// RBACR_E2E_CORS_ORIGIN, one of the server's RBACR_CORS_ORIGINS, it also
// checks CORS on /api (H3, H4).
//
//   RBACR_E2E_URL=http://127.0.0.1:5173 npm run test:e2e
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

const BASE = process.env.RBACR_E2E_URL ?? 'http://127.0.0.1:5173';
const ROOT = process.env.RBACR_E2E_ROOT ?? 'root@e2e.test';
const ADMIN = 'admin@partner.test';
const USER = 'user@partner.test';
const OTHER = 'other@partner.test';
const SYSTEM = `e2e-${Date.now()}`;
const CORS_ORIGIN = process.env.RBACR_E2E_CORS_ORIGIN;

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

/** Every token this run minted, revoked when it ends (see `after` below). */
const minted = [];

/** Signs in and mints a personal API token through the VPI. */
async function tokenFor(email) {
	const cookie = await login(email);
	const res = await vpi(cookie, 'POST', '/tokens', { name: 'e2e', expiresInDays: 1 });
	assert.equal(res.status, 201, JSON.stringify(res.body));
	minted.push({ cookie, id: res.body.id });
	return { cookie, token: res.body.token, id: res.body.id };
}

describe('rbacr API', { skip: !(await fetch(`${BASE}/health`).then((r) => r.ok, () => false)) && `no server at ${BASE}` }, () => {
	let root, admin, user, other, voucher, creds;
	/** Roles in the system under test only: other systems' roles for everyone (R9) apply to these identities too. */
	const here = (me) => ({ [SYSTEM]: me.body.roles[SYSTEM] });

	// Revoke the tokens this run minted, even if it failed midway, so repeated
	// runs stay under the per-person limit (T1).
	after(async () => {
		for (const t of minted) await vpi(t.cookie, 'DELETE', `/tokens/${t.id}`);
	});

	it('reports itself healthy, with its configuration', async () => {
		const res = await call('/health');
		assert.equal(res.status, 200);
		assert.equal(res.body.ok, true);
		assert.equal(res.body.checks.google, 'ok');
	});

	it('signs in a root and other people, who mint API tokens', async () => {
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

	it('lets roots create systems with only the roles they register', async () => {
		const created = await root('POST', '/api/systems', { id: SYSTEM, name: 'E2E', roles: ['viewer', 'admin'] });
		assert.equal(created.status, 201);
		assert.deepEqual(created.body.roles, ['admin', 'viewer']);
		assert.deepEqual(created.body.implies, {});
		const granted = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'admin', grantee: ADMIN });
		assert.equal(granted.status, 201);
		assert.deepEqual((await root('GET', '/api/me')).body.roles[SYSTEM], ['admin', 'viewer']);
	});

	it('gives a role named admin no powers: only roots manage', async () => {
		const me = await admin('GET', '/api/me');
		assert.deepEqual(here(me), { [SYSTEM]: ['admin'] });
		assert.equal(me.body.adminOf, undefined);
		assert.deepEqual((await admin('GET', '/api/systems')).body, { systems: [] });
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee: USER })).status, 403);
		assert.equal((await admin('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'viewer' })).status, 403);
		assert.equal((await admin('GET', `/api/systems/${SYSTEM}/vouchers`)).status, 403);
		assert.equal((await admin('POST', '/api/check', { email: USER, systemId: SYSTEM, role: 'viewer' })).status, 403);
	});

	it('lets roots issue single-use vouchers that users redeem', async () => {
		const created = await root('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'viewer', maxUses: 1 });
		assert.equal(created.status, 201);
		voucher = created.body.code;
		assert.equal(created.body.status, 'active');

		const redeemed = await user('POST', '/api/vouchers/redeem', { code: voucher.toLowerCase() });
		assert.equal(redeemed.status, 200);
		assert.deepEqual(redeemed.body.impliedRoles, []);
		assert.deepEqual(here(await user('GET', '/api/me')), { [SYSTEM]: ['viewer'] });

		const exhausted = await other('POST', '/api/vouchers/redeem', { code: voucher });
		assert.equal(exhausted.status, 409);
		assert.match(exhausted.body.error, /no uses left/);
		assert.equal((await admin('DELETE', `/api/vouchers/${voucher}`)).status, 403);
		const disabled = await root('DELETE', `/api/vouchers/${voucher}`);
		assert.equal(disabled.status, 200);
		assert.equal(disabled.body.status, 'disabled');
		assert.equal(disabled.body.disabledBy, ROOT);
		assert.equal((await root('DELETE', '/api/vouchers/ZZZZ-ZZZZ-ZZZZ-ZZZZ')).status, 404);

		// Disabled for good, still listed for auditing; its grant stays (V6).
		const listed = (await root('GET', `/api/systems/${SYSTEM}/vouchers`)).body.vouchers.find((v) => v.code === voucher);
		assert.deepEqual([listed.status, listed.uses, listed.disabledBy], ['disabled', 1, ROOT]);
		const again = await root('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'viewer' });
		await root('DELETE', `/api/vouchers/${again.body.code}`);
		const refused = await other('POST', '/api/vouchers/redeem', { code: again.body.code });
		assert.equal(refused.status, 409);
		assert.match(refused.body.error, /disabled/);
		assert.deepEqual(here(await user('GET', '/api/me')), { [SYSTEM]: ['viewer'] });
	});

	it('gives implied roles, registered only by roots', async () => {
		for (const role of ['free', 'premium']) await root('POST', `/api/systems/${SYSTEM}/roles`, { role });
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/premium`, { implies: ['free'] })).status, 200);
		const set = await root('PUT', `/api/systems/${SYSTEM}/roles/admin`, { implies: ['premium', 'free', 'viewer'] });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.deepEqual(set.body.implies, { admin: ['free', 'premium', 'viewer'], premium: ['free'] });
		assert.equal((await admin('PUT', `/api/systems/${SYSTEM}/roles/premium`, { implies: [] })).status, 403);
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/free`, { implies: ['premium'] })).status, 400);
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/free`, { implies: ['admin'] })).status, 400);
		const granted = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'premium', grantee: OTHER });
		assert.equal(granted.status, 201);
		assert.deepEqual(granted.body.impliedRoles, ['free']);
		assert.deepEqual((await root('POST', '/api/roles', { email: ADMIN, systemId: SYSTEM })).body.roles, ['admin', 'free', 'premium', 'viewer']);
		assert.deepEqual((await other('GET', '/api/me')).body.roles[SYSTEM], ['free', 'premium']);
		assert.equal((await root('POST', '/api/check', { email: OTHER, systemId: SYSTEM, role: 'free' })).body.allowed, true);
		const premium = (await root('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'premium' })).body.code;
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/roles/premium`)).status, 204);
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/roles/free`)).status, 204);
		assert.equal((await other('GET', '/api/me')).body.roles[SYSTEM], undefined);

		// Removing a role disables its vouchers, by the same root, and keeps them listed (L3, V6).
		const cascaded = (await root('GET', `/api/systems/${SYSTEM}/vouchers`)).body.vouchers.find((v) => v.code === premium);
		assert.deepEqual([cascaded.status, cascaded.disabledBy], ['disabled', ROOT]);
		assert.equal((await user('POST', '/api/vouchers/redeem', { code: premium })).status, 409);
	});

	it('lets roots issue vouchers for several roles, with a code of their own (V1, V2)', async () => {
		const code = `e2e several ${Date.now()}`;
		const created = await root('POST', `/api/systems/${SYSTEM}/vouchers`, { roles: ['viewer', 'admin'], code, maxUses: 1 });
		assert.equal(created.status, 201, JSON.stringify(created.body));
		assert.equal(created.body.code, code.toUpperCase().replaceAll(' ', '-'));
		assert.deepEqual([created.body.roles, created.body.role], [['admin', 'viewer'], 'admin']);
		const taken = await root('POST', '/api/vouchers', { roles: ['viewer'], code });
		assert.equal(taken.status, 409);

		// Separators don't matter; the answer is the first grant plus all of them.
		const redeemed = await other('POST', '/api/vouchers/redeem', { code: code.replaceAll(' ', '') });
		assert.equal(redeemed.status, 200, JSON.stringify(redeemed.body));
		assert.equal(redeemed.body.role, 'admin');
		assert.deepEqual(redeemed.body.grants.map((g) => g.role), ['admin', 'viewer']);
		assert.deepEqual((await other('GET', '/api/me')).body.roles[SYSTEM], ['admin', 'viewer']);

		// Each redemption is kept as a RedeemEvent with its details, for roots (V7).
		const path = `/api/vouchers/${encodeURIComponent(created.body.code)}/redemptions`;
		assert.equal((await other('GET', path)).status, 403);
		const events = await root('GET', path);
		assert.equal(events.status, 200, JSON.stringify(events.body));
		const [event] = events.body.redemptions;
		assert.equal(event.email, OTHER);
		assert.equal(event.via, 'api');
		assert.deepEqual(event.roles, ['admin', 'viewer']);
		assert.deepEqual(event.grants.map((g) => [g.role, g.outcome]), [['admin', 'granted'], ['viewer', 'granted']]);

		for (const role of ['admin', 'viewer']) await root('DELETE', `/api/systems/${SYSTEM}/grants`, { role, grantee: OTHER });
		await root('DELETE', `/api/vouchers/${encodeURIComponent(created.body.code)}`);
	});

	it('gives roles marked for everyone to every identity, and links systems by URL (R9, R10)', async () => {
		const role = `everyone${Date.now()}`;
		assert.equal((await root('POST', `/api/systems/${SYSTEM}/roles`, { role })).status, 200);
		assert.equal((await admin('PUT', `/api/systems/${SYSTEM}/roles/${role}`, { everyone: true })).status, 403);
		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/${role}`, { everyone: 'yes' })).status, 400);
		const set = await root('PUT', `/api/systems/${SYSTEM}/roles/${role}`, { everyone: true });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.deepEqual(set.body.everyone, [role]);
		const stranger = `stranger${Date.now()}@elsewhere.test`;
		assert.equal((await root('POST', '/api/check', { email: stranger, systemId: SYSTEM, role })).body.allowed, true);
		assert.ok((await user('GET', '/api/me')).body.roles[SYSTEM].includes(role));

		const url = await root('PATCH', `/api/systems/${SYSTEM}`, { url: 'https://e2e.example.com' });
		assert.equal(url.status, 200, JSON.stringify(url.body));
		assert.equal(url.body.url, 'https://e2e.example.com');
		assert.equal((await root('PATCH', `/api/systems/${SYSTEM}`, { url: 'javascript:alert(1)' })).status, 400);

		assert.equal((await root('PUT', `/api/systems/${SYSTEM}/roles/${role}`, { everyone: false })).status, 200);
		assert.equal((await root('POST', '/api/check', { email: stranger, systemId: SYSTEM, role })).body.allowed, false);
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/roles/${role}`)).status, 204);
		assert.equal((await root('PATCH', `/api/systems/${SYSTEM}`, { url: null })).body.url, null);
	});

	it('gives no roles while a system is in maintenance (R11)', async () => {
		const path = `/api/systems/${SYSTEM}`;
		const check = async () => (await root('POST', '/api/check', { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed;
		assert.equal(await check(), true);
		assert.equal((await admin('PATCH', path, { maintenance: true })).status, 403);
		assert.equal((await root('PATCH', path, { maintenance: 'on' })).status, 400);
		const on = await root('PATCH', path, { maintenance: true });
		assert.equal(on.status, 200, JSON.stringify(on.body));
		assert.equal(on.body.maintenance, true);
		assert.equal(await check(), false);
		// Any token sees the status (R12), so an app can tell maintenance from a missing role.
		const status = await user('GET', `${path}/status`);
		assert.equal(status.status, 200, JSON.stringify(status.body));
		assert.deepEqual(Object.keys(status.body).sort(), ['id', 'maintenance', 'name', 'url']);
		assert.equal(status.body.maintenance, true);
		assert.equal((await user('GET', '/api/systems/no-such-system/status')).status, 404);
		assert.equal((await call(`${path}/status`)).status, 401);
		assert.deepEqual((await user('POST', '/api/roles', { email: USER, systemId: SYSTEM })).body.roles, []);
		assert.deepEqual((await root('GET', '/api/me')).body.roles[SYSTEM], []);
		assert.equal((await root('PATCH', path, { maintenance: false })).body.maintenance, false);
		assert.equal((await user('GET', `${path}/status`)).body.maintenance, false);
		assert.equal(await check(), true);
	});

	it('lets roots issue global vouchers; paid ones answer 402', async () => {
		const role = `e2e${Date.now()}`;
		assert.equal((await root('POST', `/api/systems/${SYSTEM}/roles`, { role })).status, 200);
		assert.equal((await admin('POST', '/api/vouchers', { role })).status, 403);

		const free = await root('POST', '/api/vouchers', { role, maxUses: 5 });
		assert.equal(free.status, 201);
		assert.equal(free.body.systemId, null);
		assert.equal(free.body.discountPercent, 100);
		assert.ok((await root('GET', '/api/vouchers')).body.vouchers.some((v) => v.code === free.body.code));
		assert.equal((await admin('GET', '/api/vouchers')).status, 403);
		const redeemed = await other('POST', '/api/vouchers/redeem', { code: free.body.code });
		assert.equal(redeemed.status, 200);
		assert.deepEqual(redeemed.body.impliedRolesBySystem, { [SYSTEM]: [] });
		const me = (await other('GET', '/api/me')).body;
		assert.deepEqual(me.globalRoles, [role]);
		assert.deepEqual(me.roles[SYSTEM], [role]);

		const paid = await root('POST', '/api/vouchers', { role, discountPercent: 25 });
		const res = await user('POST', '/api/vouchers/redeem', { code: paid.body.code });
		assert.equal(res.status, 402);
		assert.deepEqual(res.body.payment, { code: paid.body.code, systemId: null, roles: [role], role, discountPercent: 25 });

		assert.equal((await root('DELETE', '/api/global-grants', { role, grantee: OTHER })).status, 204);
		assert.deepEqual((await other('GET', '/api/me')).body.globalRoles, []);
		for (const v of [free.body.code, paid.body.code]) await root('DELETE', `/api/vouchers/${v}`);
	});

	it('lets roots set the role Substack subscribers hold in a system', async () => {
		const path = `/api/systems/${SYSTEM}`;
		assert.equal((await root('GET', path)).body.subscriberRole, null);
		assert.equal((await admin('PATCH', path, { subscriberRole: 'viewer' })).status, 403);
		assert.equal((await root('PATCH', path, { subscriberRole: 'ghost' })).status, 404);
		assert.equal((await root('PATCH', path, {})).status, 400);
		const set = await root('PATCH', path, { subscriberRole: 'viewer' });
		assert.equal(set.status, 200, JSON.stringify(set.body));
		assert.equal(set.body.subscriberRole, 'viewer');
		assert.equal((await root('GET', '/api/systems')).body.systems.find((s) => s.id === SYSTEM).subscriberRole, 'viewer');
		assert.equal((await root('PATCH', path, { subscriberRole: null })).body.subscriberRole, null);
	});

	it('gives grants a validity window', async () => {
		const grantee = `window-${Date.now()}@example.com`;
		const check = async () => (await root('POST', '/api/check', { email: grantee, systemId: SYSTEM, role: 'viewer' })).body.allowed;
		const later = new Date(Date.now() + 86_400_000).toISOString();
		const bad = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee, startsAt: later, endsAt: later });
		assert.equal(bad.status, 400);
		const future = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee, startsAt: later });
		assert.equal(future.status, 201);
		assert.equal(future.body.startsAt, later);
		assert.equal(future.body.endsAt, null);
		assert.equal(future.body.status, 'not-started');
		assert.equal(await check(), false);
		const now = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee, endsAt: later });
		assert.equal(now.body.status, 'active');
		assert.equal(await check(), true);
		// A "yes" may be cached until the grant ends (C3a).
		const answer = (await root('POST', '/api/check', { email: grantee, systemId: SYSTEM, role: 'viewer' })).body;
		assert.equal(answer.expiresAt, later);
		assert.ok(answer.ttl > 86_390 && answer.ttl <= 86_400, `ttl ${answer.ttl}`);
		const forever = (await root('POST', '/api/check', { email: ROOT, systemId: SYSTEM, role: 'viewer' })).body;
		assert.deepEqual([forever.allowed, forever.expiresAt, forever.ttl], [true, null, null]);
		const no = (await root('POST', '/api/check', { email: grantee, systemId: SYSTEM, role: 'admin' })).body;
		assert.deepEqual([no.allowed, no.expiresAt, no.ttl], [false, null, null]);
		const global = await root('POST', '/api/global-grants', { role: 'viewer', grantee, startsAt: later });
		assert.equal(global.body.status, 'not-started');
		assert.equal((await root('DELETE', '/api/global-grants', { role: 'viewer', grantee })).status, 204);
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee })).status, 204);
	});

	it('answers role checks for roots, and for anyone about themselves', async () => {
		const check = (who, body) => who('POST', '/api/check', body);
		assert.equal((await check(root, { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed, true);
		assert.equal((await check(root, { email: USER, systemId: SYSTEM, role: 'admin' })).body.allowed, false);
		assert.equal((await check(root, { email: ROOT, role: 'root' })).body.allowed, true);
		assert.equal((await check(root, { email: ROOT, systemId: SYSTEM, role: 'admin' })).body.allowed, true);
		assert.equal((await check(user, { email: USER, systemId: SYSTEM, role: 'viewer' })).body.allowed, true);
		assert.equal((await check(user, { email: ADMIN, systemId: SYSTEM, role: 'admin' })).status, 403);
		assert.deepEqual((await root('POST', '/api/roles', { email: USER, systemId: SYSTEM })).body, {
			email: USER,
			systemId: SYSTEM,
			roles: ['viewer']
		});
		assert.deepEqual((await user('POST', '/api/roles', { email: USER })).body.roles[SYSTEM], ['viewer']);
		assert.equal((await user('POST', '/api/roles', { email: OTHER })).status, 403);
	});

	it('keeps everyone but roots out of management', async () => {
		assert.deepEqual((await user('GET', '/api/systems')).body, { systems: [] });
		assert.equal((await user('POST', '/api/systems', { id: 'nope' })).status, 403);
		assert.equal((await user('GET', `/api/systems/${SYSTEM}/grants`)).status, 403);
	});

	it('shows the version on the settings page, and the root allow list to roots', async () => {
		const { cookie } = creds[2];
		const settings = await vpi(cookie, 'GET', '/settings');
		assert.equal(settings.status, 200);
		assert.equal(settings.body.version, (await call('/health')).body.version);
		assert.match(settings.body.apiBase, /\/api$/);
		assert.equal(settings.body.rootList, null);
		const rootList = (await vpi(creds[0].cookie, 'GET', '/settings')).body.rootList;
		assert.ok(rootList.some((e) => e === ROOT || e === `@${ROOT.split('@')[1]}`), JSON.stringify(rootList));
		const page = await fetch(`${BASE}/settings`, { headers: { cookie, accept: 'text/html' } });
		assert.match(await page.text(), new RegExp(`<code>${settings.body.version}</code>`));
	});

	it('renders roles in the UI', async () => {
		const res = await fetch(`${BASE}/me`, { headers: { cookie: creds[2].cookie, accept: 'text/html' } });
		assert.equal(res.status, 200);
		const html = await res.text();
		assert.match(html, new RegExp(SYSTEM));
		assert.match(html, /viewer/);
		// Roots see who disabled a voucher (L1).
		const page = await fetch(`${BASE}/systems/${SYSTEM}`, { headers: { cookie: creds[0].cookie, accept: 'text/html' } });
		assert.equal(page.status, 200);
		assert.match(await page.text(), new RegExp(`Disabled by ${ROOT}`));
	});

	it('redeems vouchers through a link, signing in first, and shows the systems it opened (V8, S5, R13)', async () => {
		const card = await root('PATCH', `/api/systems/${SYSTEM}`, {
			url: 'https://e2e.example.com',
			description: 'The e2e system',
			screenshotUrl: 'https://e2e.example.com/shot.png'
		});
		assert.equal(card.status, 200, JSON.stringify(card.body));
		assert.equal(card.body.description, 'The e2e system');
		assert.equal((await root('PATCH', `/api/systems/${SYSTEM}`, { screenshotUrl: 'javascript:alert(1)' })).status, 400);
		const code = (await root('POST', `/api/systems/${SYSTEM}/vouchers`, { role: 'viewer' })).body.code;
		const link = `/redeem/${encodeURIComponent(code)}`;

		// Anonymous visitors are sent to sign in, and come back to the link.
		const anon = await fetch(`${BASE}${link}`, { redirect: 'manual', headers: { accept: 'text/html' } });
		assert.equal(anon.status, 303);
		assert.equal(anon.headers.get('location'), `/?next=${encodeURIComponent(link)}`);
		const signIn = (next) =>
			fetch(`${BASE}/login/dev`, {
				method: 'POST',
				redirect: 'manual',
				headers: { origin: BASE, accept: 'text/html', 'content-type': 'application/x-www-form-urlencoded' },
				body: new URLSearchParams({ email: `link${Date.now()}@partner.test`, next })
			});
		for (const evil of ['//evil.example', 'https://evil.example', '/\\evil.example']) {
			assert.equal((await signIn(evil)).headers.get('location'), '/me');
		}
		const back = await signIn(link);
		assert.equal(back.status, 303);
		assert.equal(back.headers.get('location'), link);
		const cookie = back.headers.getSetCookie().find((c) => c.startsWith('rbacr_session=')).split(';')[0];
		// Signed in, the link's page renders (it redeems from the browser).
		assert.equal((await fetch(`${BASE}${link}`, { headers: { cookie, accept: 'text/html' } })).status, 200);

		assert.equal((await vpi(cookie, 'GET', `/me/redemptions/${code}`)).status, 404);
		assert.equal((await vpi(cookie, 'POST', '/me/redeem', { code })).status, 200);
		const done = await vpi(cookie, 'GET', `/me/redemptions/${code}`);
		assert.equal(done.status, 200, JSON.stringify(done.body));
		assert.equal(done.body.redemption.code, code);
		assert.equal(done.body.redemption.via, 'page');
		assert.deepEqual(done.body.systems, [
			{
				id: SYSTEM,
				name: card.body.name,
				url: 'https://e2e.example.com',
				description: 'The e2e system',
				screenshotUrl: 'https://e2e.example.com/shot.png',
				maintenance: false,
				roles: ['viewer']
			}
		]);
		const page = await fetch(`${BASE}/redeemed/${code}`, { headers: { cookie, accept: 'text/html' } });
		assert.equal(page.status, 200);
		const html = await page.text();
		assert.match(html, /Roles granted/);
		assert.match(html, /The e2e system/);
		assert.match(html, /shot\.png/);
		assert.equal((await vpi(cookie, 'GET', '/me/redemptions/NO-SUCH-CODE')).status, 404);

		const cleared = await root('PATCH', `/api/systems/${SYSTEM}`, { url: null, description: null, screenshotUrl: null });
		assert.deepEqual([cleared.body.url, cleared.body.description, cleared.body.screenshotUrl], [null, null, null]);
	});

	it('validates input with JSON errors', async () => {
		const bad = await root('POST', `/api/systems/${SYSTEM}/grants`, { role: 'viewer', grantee: 'not an email' });
		assert.equal(bad.status, 400);
		assert.match(bad.body.error, /Invalid grantee/);
		assert.equal((await root('POST', '/api/systems', 'nope')).status, 400);
	});

	it('warns roots when they sign in about vouchers ending with nothing to replace them (N1-N4)', async () => {
		// A role of its own, so no voucher from the tests above replaces this one.
		assert.equal((await root('POST', `/api/systems/${SYSTEM}/roles`, { role: 'notified' })).status, 200);
		const day = 24 * 60 * 60 * 1000;
		const voucher = (endsAt) =>
			root('POST', `/api/systems/${SYSTEM}/vouchers`, { roles: ['notified'], endsAt: new Date(Date.now() + endsAt).toISOString() });
		const v = (await voucher(3 * day)).body;
		const cookie = await login(ROOT); // a root's sign-in runs the rules
		const mine = async (path = '/notifications', method = 'GET') => {
			const res = await vpi(cookie, method, path);
			assert.equal(res.status, 200, JSON.stringify(res.body));
			return res.body.notifications.find((n) => n.voucherCode === v.code);
		};
		const n = await mine();
		assert.deepEqual(
			{ status: n.status, kind: n.kind, systemId: n.systemId, roles: n.roles },
			{ status: 'open', kind: 'voucher-expiring', systemId: SYSTEM, roles: ['notified'] }
		);
		assert.ok((await vpi(cookie, 'GET', '/session')).body.user.openNotifications >= 1);
		assert.equal((await vpi(creds[2].cookie, 'GET', '/notifications')).status, 403);
		assert.equal((await vpi(creds[2].cookie, 'POST', '/notifications/check')).status, 403);
		assert.equal((await vpi(creds[2].cookie, 'GET', '/session')).body.user.openNotifications, 0);
		// A replacement resolves it; losing the replacement opens it again.
		const substitute = (await voucher(30 * day)).body;
		assert.equal((await mine('/notifications/check', 'POST')).status, 'resolved');
		assert.equal((await root('DELETE', `/api/vouchers/${substitute.code}`)).status, 200);
		assert.equal((await mine('/notifications/check', 'POST')).status, 'open');
		const page = await fetch(`${BASE}/notifications`, { headers: { cookie, accept: 'text/html' } });
		assert.match(await page.text(), new RegExp(v.code));
		// Dismissed for good.
		const dismissed = await vpi(cookie, 'DELETE', `/notifications/${encodeURIComponent(n.id)}`);
		assert.equal(dismissed.status, 200);
		assert.equal(dismissed.body.dismissedBy, ROOT);
		assert.equal((await mine('/notifications/check', 'POST')).status, 'dismissed');
		assert.equal((await vpi(cookie, 'DELETE', '/notifications/voucher-expiring%3ANOPE')).status, 404);
	});

	it('keeps failed redeem attempts for roots (V9)', async () => {
		const unknown = `NOPE-${Date.now()}`;
		assert.equal((await user('POST', '/api/vouchers/redeem', { code: unknown })).status, 404);
		const v = (await root('POST', `/api/systems/${SYSTEM}/vouchers`, { roles: ['viewer'] })).body;
		assert.equal((await vpi(creds[3].cookie, 'POST', '/me/redeem', { code: v.code })).status, 200);
		assert.equal((await vpi(creds[3].cookie, 'POST', '/me/redeem', { code: v.code })).status, 409);
		const failures = (await root('GET', `/api/vouchers/${v.code}/failures`)).body.failures;
		assert.deepEqual(
			failures.map((f) => [f.email, f.known, f.systemId, f.via, f.status]),
			[[OTHER, true, SYSTEM, 'page', 409]]
		);
		const latest = (await root('GET', '/api/redeem-failures')).body.failures;
		assert.ok(latest.some((f) => f.code === unknown && !f.known && f.email === USER && f.status === 404), JSON.stringify(latest.slice(0, 3)));
		const panel = (await vpi(creds[0].cookie, 'GET', `/vouchers/${v.code}/redemptions`)).body;
		assert.equal(panel.redemptions.length, 1);
		assert.equal(panel.failures.length, 1);
		assert.equal((await user('GET', '/api/redeem-failures')).status, 403);
		assert.equal((await user('GET', `/api/vouchers/${v.code}/failures`)).status, 403);
		assert.equal((await vpi(creds[2].cookie, 'GET', '/redeem-failures')).status, 403);
	});

	it('answers browsers from listed origins on /api (H3, H4)', { skip: !CORS_ORIGIN && 'RBACR_E2E_CORS_ORIGIN is unset' }, async () => {
		const { token } = creds[2];
		const me = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}`, origin: CORS_ORIGIN } });
		assert.equal(me.status, 200);
		assert.equal(me.headers.get('access-control-allow-origin'), CORS_ORIGIN);
		assert.match(me.headers.get('vary'), /Origin/);
		// Errors too, so the app can read them; an ID-token-shaped forgery is just a 401.
		const forged = await fetch(`${BASE}/api/me`, { headers: { authorization: 'Bearer eyJhbGciOiJub25lIn0.eyJlbWFpbCI6InhAeC54In0.', origin: CORS_ORIGIN } });
		assert.equal(forged.status, 401);
		assert.equal(forged.headers.get('access-control-allow-origin'), CORS_ORIGIN);
		const evil = await fetch(`${BASE}/api/me`, { headers: { authorization: `Bearer ${token}`, origin: 'https://evil.example' } });
		assert.equal(evil.status, 200);
		assert.equal(evil.headers.get('access-control-allow-origin'), null);
		const ask = (path, method) =>
			fetch(`${BASE}${path}`, { method: 'OPTIONS', headers: { origin: CORS_ORIGIN, 'access-control-request-method': method, 'access-control-request-headers': 'authorization' } });
		const ok = await ask(`/api/systems/${SYSTEM}/status`, 'GET');
		assert.equal(ok.status, 204);
		assert.equal(ok.headers.get('access-control-allow-origin'), CORS_ORIGIN);
		const refused = await ask(`/api/systems/${SYSTEM}/grants`, 'POST');
		assert.equal(refused.status, 403);
		assert.equal(refused.headers.get('access-control-allow-origin'), null);
	});

	it('lets roots delete systems', async () => {
		assert.equal((await root('DELETE', `/api/systems/${SYSTEM}`)).status, 204);
		assert.equal((await user('GET', '/api/me')).body.roles[SYSTEM], undefined);
	});
});
