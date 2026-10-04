import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { Allowlist } from './identity';
import {
	ADMIN_ROLE,
	Rbac,
	RbacError,
	canAssign,
	generateVoucherCode,
	normalizeVoucherCode,
	voucherStatus,
	type Actor
} from './rbac';
import { createTestDb } from './testing/pglite';

const ROOT = 'root@corp.com';
const ADMIN = 'admin@partner.com';
const USER = 'user@partner.com';

let db: Db;
let clock: Date;
let rbac: Rbac;
let root: Actor;

async function expectError(promise: Promise<unknown>, status: number, message?: RegExp) {
	const err = await promise.then(
		() => null,
		(e: unknown) => e
	);
	expect(err).toBeInstanceOf(RbacError);
	expect((err as RbacError).status).toBe(status);
	if (message) expect((err as RbacError).message).toMatch(message);
}

beforeEach(async () => {
	db = await createTestDb();
	clock = new Date('2026-01-10T12:00:00Z');
	rbac = new Rbac(db, Allowlist.parse('corp.com'), () => clock);
	root = await rbac.actor(ROOT);
	await rbac.createSystem(root, { id: 'billing', name: 'Billing', roles: ['viewer', 'editor'] });
	await rbac.createSystem(root, { id: 'crm' });
	await rbac.grant(root, 'billing', ADMIN_ROLE, ADMIN);
});

describe('roots', () => {
	it('are recognised from the allow list, by domain', async () => {
		expect(root.root).toBe(true);
		expect((await rbac.actor('someone@corp.com')).root).toBe(true);
		expect((await rbac.actor(USER)).root).toBe(false);
	});

	it('hold the single global root role; nobody else does', async () => {
		expect(await rbac.globalRolesOf(ROOT)).toEqual(['root']);
		expect(await rbac.globalRolesOf(ADMIN)).toEqual([]);
		expect(await rbac.globalRolesOf(USER)).toEqual([]);
	});

	it('hold every role of every system', async () => {
		expect(await rbac.rolesOf(ROOT)).toEqual({
			billing: ['admin', 'editor', 'viewer'],
			crm: ['admin']
		});
	});

	it('can grant roles to individuals and domains', async () => {
		await rbac.grant(root, 'billing', 'viewer', 'partner.com');
		await rbac.grant(root, 'crm', ADMIN_ROLE, USER);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'], crm: ['admin'] });
		expect(await rbac.rolesOf('other@partner.com')).toEqual({ billing: ['viewer'] });
	});

	it('manage the system and role catalog', async () => {
		await rbac.addRole(root, 'crm', 'Sales');
		expect((await rbac.getSystem(root, 'crm')).roles).toEqual(['admin', 'sales']);
		await expectError(rbac.addRole(root, 'crm', 'sales'), 409);
		await expectError(rbac.createSystem(root, { id: 'crm' }), 409);
		await expectError(rbac.createSystem(root, { id: 'Bad Id!' }), 400);
		await expectError(rbac.removeRole(root, 'crm', ADMIN_ROLE), 400);
	});

	it('cannot define a system role named root', async () => {
		await expectError(rbac.addRole(root, 'crm', 'Root'), 400, /reserved/);
		await expectError(rbac.createSystem(root, { id: 'x', roles: ['root'] }), 400, /reserved/);
	});

	it('removing a role removes its grants', async () => {
		await rbac.grant(root, 'billing', 'editor', USER);
		await rbac.removeRole(root, 'billing', 'editor');
		expect(await rbac.rolesOf(USER)).toEqual({});
	});
});

describe('admins', () => {
	let admin: Actor;
	beforeEach(async () => {
		admin = await rbac.actor(ADMIN);
	});

	it('are admins of the systems where they hold the admin role', () => {
		expect(admin).toEqual({ email: ADMIN, root: false, adminOf: ['billing'] });
	});

	it('see and manage only their systems', async () => {
		expect((await rbac.listSystems(admin)).map((s) => s.id)).toEqual(['billing']);
		await expectError(rbac.getSystem(admin, 'crm'), 403);
		await expectError(rbac.grant(admin, 'crm', ADMIN_ROLE, USER), 403);
	});

	it('can grant and revoke non-admin roles to individuals', async () => {
		await rbac.grant(admin, 'billing', 'editor', USER);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor'] });
		await rbac.revoke(admin, 'billing', 'editor', USER);
		expect(await rbac.rolesOf(USER)).toEqual({});
	});

	it('cannot propagate the admin role', async () => {
		await expectError(rbac.grant(admin, 'billing', ADMIN_ROLE, USER), 403, /Only roots/);
		await expectError(rbac.revoke(admin, 'billing', ADMIN_ROLE, ADMIN), 403);
		await expectError(rbac.createVoucher(admin, { systemId: 'billing', role: ADMIN_ROLE }), 403);
	});

	it('cannot grant to whole domains', async () => {
		await expectError(rbac.grant(admin, 'billing', 'viewer', 'gmail.com'), 403, /domains/);
	});

	it('cannot change the role catalog or create systems', async () => {
		await expectError(rbac.addRole(admin, 'billing', 'x'), 403);
		await expectError(rbac.createSystem(admin, { id: 'x' }), 403);
	});

	it('cannot grant roles missing from the catalog', async () => {
		await expectError(rbac.grant(admin, 'billing', 'ghost', USER), 404);
	});
});

describe('regular users', () => {
	it('see only their own roles and manage nothing', async () => {
		const user = await rbac.actor(USER);
		expect(await rbac.rolesOf(USER)).toEqual({});
		expect(await rbac.listSystems(user)).toEqual([]);
		await expectError(rbac.grant(user, 'billing', 'viewer', 'x@y.com'), 403);
		await expectError(rbac.createVoucher(user, { systemId: 'billing', role: 'viewer' }), 403);
		await expectError(rbac.listGrants(user, 'billing'), 403);
	});
});

describe('canAssign', () => {
	const admin: Actor = { email: ADMIN, root: false, adminOf: ['billing'] };
	it('encodes the propagation rules', () => {
		expect(canAssign({ email: ROOT, root: true, adminOf: [] }, 'any', ADMIN_ROLE, '@x.com')).toBe(true);
		expect(canAssign(admin, 'billing', 'viewer', USER)).toBe(true);
		expect(canAssign(admin, 'billing', 'viewer', null)).toBe(true);
		expect(canAssign(admin, 'billing', ADMIN_ROLE, null)).toBe(false);
		expect(canAssign(admin, 'billing', 'viewer', '@x.com')).toBe(false);
		expect(canAssign(admin, 'crm', 'viewer', USER)).toBe(false);
	});
});

describe('vouchers', () => {
	it('codes are random, grouped and normalised on input', () => {
		const code = generateVoucherCode();
		expect(code).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
		expect(generateVoucherCode()).not.toBe(code);
		expect(normalizeVoucherCode(code.toLowerCase().replaceAll('-', ' '))).toBe(code);
	});

	it('grant their role to whoever redeems them', async () => {
		const admin = await rbac.actor(ADMIN);
		const v = await rbac.createVoucher(admin, { systemId: 'billing', role: 'viewer' });
		const grant = await rbac.redeemVoucher(USER, v.code.toLowerCase());
		expect(grant).toMatchObject({ systemId: 'billing', role: 'viewer', grantee: USER, voucherCode: v.code });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] });
	});

	it('root admin vouchers make the redeemer an admin', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'crm', role: ADMIN_ROLE });
		await rbac.redeemVoucher(USER, v.code);
		expect((await rbac.actor(USER)).adminOf).toEqual(['crm']);
	});

	it('can be redeemed once per identity', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', role: 'viewer' });
		await rbac.redeemVoucher(USER, v.code);
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /already/);
		const [row] = await db.query<{ uses: number }>('SELECT uses FROM vouchers WHERE code = $1', [v.code]);
		expect(row.uses).toBe(1);
	});

	it('respect the usage count', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', role: 'viewer', maxUses: 2 });
		await rbac.redeemVoucher('a@x.com', v.code);
		await rbac.redeemVoucher('b@x.com', v.code);
		await expectError(rbac.redeemVoucher('c@x.com', v.code), 409, /no uses left/);
	});

	it('respect the start and end dates', async () => {
		const v = await rbac.createVoucher(root, {
			systemId: 'billing',
			role: 'viewer',
			startsAt: new Date('2026-02-01T00:00:00Z'),
			endsAt: new Date('2026-03-01T00:00:00Z')
		});
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /not valid yet/);
		clock = new Date('2026-03-01T00:00:00Z');
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /expired/);
		clock = new Date('2026-02-15T00:00:00Z');
		await rbac.redeemVoucher(USER, v.code);
	});

	it('reject invalid limits', async () => {
		const base = { systemId: 'billing', role: 'viewer' };
		await expectError(rbac.createVoucher(root, { ...base, maxUses: 0 }), 400);
		await expectError(rbac.createVoucher(root, { ...base, maxUses: 1.5 }), 400);
		await expectError(
			rbac.createVoucher(root, { ...base, startsAt: new Date('2026-02-01'), endsAt: new Date('2026-01-01') }),
			400
		);
		await expectError(rbac.createVoucher(root, { ...base, startsAt: new Date('nope') }), 400);
	});

	it('can be disabled by their managers', async () => {
		const admin = await rbac.actor(ADMIN);
		const v = await rbac.createVoucher(admin, { systemId: 'billing', role: 'viewer' });
		const disabled = await rbac.disableVoucher(admin, v.code);
		expect(voucherStatus(disabled, clock)).toBe('disabled');
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /disabled/);
		await expectError(rbac.disableVoucher(await rbac.actor(USER), v.code), 404);
	});

	it('admin vouchers are hidden from and untouchable by admins', async () => {
		const admin = await rbac.actor(ADMIN);
		const adminVoucher = await rbac.createVoucher(root, { systemId: 'billing', role: ADMIN_ROLE });
		await rbac.createVoucher(admin, { systemId: 'billing', role: 'viewer' });
		expect((await rbac.listVouchers(admin, 'billing')).map((v) => v.role)).toEqual(['viewer']);
		expect(await rbac.listVouchers(root, 'billing')).toHaveLength(2);
		await expectError(rbac.disableVoucher(admin, adminVoucher.code), 404);
	});

	it('unknown codes are not found', async () => {
		await expectError(rbac.redeemVoucher(USER, 'AAAA-BBBB-CCCC-DDDD'), 404);
	});
});

describe('global vouchers and grants', () => {
	it('only roots create them', async () => {
		const admin = await rbac.actor(ADMIN);
		const user = await rbac.actor(USER);
		await expectError(rbac.createVoucher(admin, { systemId: null, role: 'viewer' }), 403, /global/);
		await expectError(rbac.createVoucher(user, { systemId: null, role: 'viewer' }), 403);
		await expectError(rbac.grantGlobal(admin, 'viewer', USER), 403);
		await expectError(rbac.listGlobalVouchers(admin), 403);
		await expectError(rbac.listGlobalGrants(admin), 403);
		await expectError(rbac.createVoucher(root, { systemId: null, role: 'root' }), 400, /reserved/);
	});

	it('grant the role in every system that defines it, including later ones', async () => {
		const v = await rbac.createVoucher(root, { systemId: null, role: 'viewer' });
		expect(v).toMatchObject({ systemId: null, role: 'viewer', discountPercent: 100 });
		const grant = await rbac.redeemVoucher(USER, v.code);
		expect(grant).toMatchObject({ systemId: null, role: 'viewer', grantee: USER, voucherCode: v.code });
		expect(await rbac.globalRolesOf(USER)).toEqual(['viewer']);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] }); // crm has no viewer role
		await rbac.createSystem(root, { id: 'later', roles: ['viewer'] });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'], later: ['viewer'] });
		expect((await rbac.listGlobalVouchers(root)).map((x) => x.code)).toEqual([v.code]);
	});

	it('can be granted and revoked directly by roots, also to domains', async () => {
		await rbac.grantGlobal(root, 'admin', 'partner.com');
		expect((await rbac.actor('anyone@partner.com')).adminOf).toEqual(['billing', 'crm']);
		expect((await rbac.listGlobalGrants(root)).map((g) => g.grantee)).toEqual(['@partner.com']);
		await rbac.revokeGlobal(root, 'admin', '@partner.com');
		expect(await rbac.globalRolesOf('anyone@partner.com')).toEqual([]);
		await expectError(rbac.revokeGlobal(root, 'admin', '@partner.com'), 404);
	});

	it('are hidden from and untouchable by admins', async () => {
		const v = await rbac.createVoucher(root, { systemId: null, role: 'viewer' });
		await expectError(rbac.disableVoucher(await rbac.actor(ADMIN), v.code), 404);
		expect(await rbac.listVouchers(root, 'billing')).toEqual([]);
	});

	it('roots still report only the root global role', async () => {
		await rbac.grantGlobal(root, 'viewer', ROOT);
		expect(await rbac.globalRolesOf(ROOT)).toEqual(['root']);
	});
});

describe('voucher discounts', () => {
	it('default to 100% and must be a whole percentage', async () => {
		const base = { systemId: 'billing', role: 'viewer' };
		expect((await rbac.createVoucher(root, base)).discountPercent).toBe(100);
		expect((await rbac.createVoucher(root, { ...base, discountPercent: 0 })).discountPercent).toBe(0);
		for (const bad of [-1, 101, 12.5]) {
			await expectError(rbac.createVoucher(root, { ...base, discountPercent: bad }), 400, /discount/);
		}
	});

	it('below 100% require payment: 402 with the terms, nothing recorded', async () => {
		const admin = await rbac.actor(ADMIN);
		const v = await rbac.createVoucher(admin, { systemId: 'billing', role: 'viewer', discountPercent: 50, maxUses: 1 });
		const err = await rbac.redeemVoucher(USER, v.code).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RbacError);
		expect((err as RbacError).status).toBe(402);
		expect((err as RbacError).details?.payment).toEqual({
			code: v.code,
			systemId: 'billing',
			role: 'viewer',
			discountPercent: 50
		});
		expect(await rbac.rolesOf(USER)).toEqual({});
		const [row] = await db.query<{ uses: number }>('SELECT uses FROM vouchers WHERE code = $1', [v.code]);
		expect(row.uses).toBe(0);
	});

	it('expired paid vouchers report expiry, not payment', async () => {
		const v = await rbac.createVoucher(root, {
			systemId: null,
			role: 'viewer',
			discountPercent: 20,
			endsAt: new Date('2026-01-01T00:00:00Z')
		});
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /expired/);
	});
});

describe('role queries (the external API)', () => {
	let admin: Actor;
	let user: Actor;

	beforeEach(async () => {
		await rbac.grant(root, 'billing', 'viewer', USER);
		await rbac.grantGlobal(root, 'editor', 'other@partner.com');
		admin = await rbac.actor(ADMIN);
		user = await rbac.actor(USER);
	});

	it('check roles with the same rules as rolesOf', async () => {
		expect(await rbac.hasRole(root, USER, 'billing', 'viewer')).toBe(true);
		expect(await rbac.hasRole(root, ' User@Partner.com ', 'billing', 'Viewer')).toBe(true);
		expect(await rbac.hasRole(root, USER, 'billing', 'editor')).toBe(false);
		expect(await rbac.hasRole(root, ADMIN, 'billing', ADMIN_ROLE)).toBe(true);
		expect(await rbac.hasRole(root, 'other@partner.com', 'billing', 'editor')).toBe(true);
		expect(await rbac.hasRole(root, ROOT, 'crm', ADMIN_ROLE)).toBe(true);
	});

	it('check global roles when no system is given', async () => {
		expect(await rbac.hasRole(root, ROOT, null, 'root')).toBe(true);
		expect(await rbac.hasRole(root, 'other@partner.com', null, 'editor')).toBe(true);
		expect(await rbac.hasRole(root, USER, null, 'editor')).toBe(false);
	});

	it('report unknown systems and roles, and bad addresses', async () => {
		await expectError(rbac.hasRole(root, USER, 'nope', 'viewer'), 404, /System/);
		await expectError(rbac.hasRole(root, USER, 'billing', 'nope'), 404, /Role/);
		await expectError(rbac.hasRole(root, 'partner.com', 'billing', 'viewer'), 400);
	});

	it('list roles', async () => {
		expect(await rbac.rolesIn(root, USER, 'billing')).toEqual(['viewer']);
		expect(await rbac.rolesIn(root, USER, 'crm')).toEqual([]);
		expect(await rbac.allRoles(root, 'other@partner.com')).toEqual({
			globalRoles: ['editor'],
			roles: { billing: ['editor'] }
		});
	});

	it('let anyone ask about themselves', async () => {
		expect(await rbac.hasRole(user, USER, 'billing', 'viewer')).toBe(true);
		expect(await rbac.hasRole(user, USER, null, 'root')).toBe(false);
		expect(await rbac.allRoles(user, USER)).toEqual({ globalRoles: [], roles: { billing: ['viewer'] } });
	});

	it('let admins ask about anyone, but only in their systems', async () => {
		expect(await rbac.hasRole(admin, USER, 'billing', 'viewer')).toBe(true);
		expect(await rbac.rolesIn(admin, USER, 'billing')).toEqual(['viewer']);
		await expectError(rbac.hasRole(admin, USER, 'crm', 'admin'), 403, /administer/);
		await expectError(rbac.hasRole(admin, USER, null, 'editor'), 403, /global/);
		await expectError(rbac.allRoles(admin, USER), 403);
	});

	it("keep regular users out of other people's roles", async () => {
		await expectError(rbac.hasRole(user, ADMIN, 'billing', 'admin'), 403);
		await expectError(rbac.rolesIn(user, ADMIN, 'billing'), 403);
		await expectError(rbac.allRoles(user, ROOT), 403);
	});
});
