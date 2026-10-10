import { PutCommand } from '@aws-sdk/lib-dynamodb';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Table } from './dynamo';
import { Allowlist } from './identity';
import { Rbac, RbacError, voucherStatus, type Actor } from './rbac';
import { ANIMALS, quarterOf } from '../vouchers';
import { createTestTable, scanAll } from './testing/dynamodb';

const ROOT = 'root@corp.com';
const USER = 'user@partner.com';
const OTHER = 'other@partner.com';

let table: Table;
let clock: Date;
let rbac: Rbac;
let root: Actor;
let user: Actor;

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
	table = await createTestTable();
	clock = new Date('2026-01-10T12:00:00Z');
	rbac = new Rbac(table, Allowlist.parse('corp.com'), () => clock);
	root = await rbac.actor(ROOT);
	user = await rbac.actor(USER);
	await rbac.createSystem(root, { id: 'billing', name: 'Billing', roles: ['viewer', 'editor'] });
	await rbac.createSystem(root, { id: 'crm' });
});

describe('roots', () => {
	it('are recognised from the allow list, by domain', async () => {
		expect(root).toEqual({ email: ROOT, root: true });
		expect((await rbac.actor('someone@corp.com')).root).toBe(true);
		expect(user).toEqual({ email: USER, root: false });
	});

	it('hold the single global root role; nobody else does', async () => {
		expect(await rbac.globalRolesOf(ROOT)).toEqual(['root']);
		expect(await rbac.globalRolesOf(USER)).toEqual([]);
	});

	it('come only from the allow list: addresses and whole domains', async () => {
		const list = new Rbac(table, Allowlist.parse('@nu01.com, boss@partner.com'), () => clock);
		expect((await list.actor('anyone@nu01.com')).root).toBe(true);
		expect((await list.actor('boss@partner.com')).root).toBe(true);
		expect(await list.globalRolesOf('boss@partner.com')).toEqual(['root']);
		for (const email of [USER, 'x@sub.nu01.com', 'nu01.com@evil.com']) {
			expect((await list.actor(email)).root).toBe(false);
			expect(await list.globalRolesOf(email)).toEqual([]);
		}
		expect(list.rootList(await list.actor('boss@partner.com'))).toEqual(['@nu01.com', 'boss@partner.com']);
		expect(() => list.rootList(user)).toThrow(/Only roots/);
	});

	it('cannot be made any other way', async () => {
		await expectError(rbac.grantGlobal(root, 'root', USER), 400, /reserved/);
		await expectError(rbac.grantGlobal(root, 'root', 'partner.com'), 400, /reserved/);
		await expectError(rbac.createVoucher(root, { systemId: null, roles: ['root'] }), 400, /reserved/);
		await expectError(rbac.addRole(root, 'billing', 'root'), 400, /reserved/);
		await expectError(rbac.grant(root, 'billing', 'root', USER), 404);
		// Even a root grant written straight into the table is ignored.
		for (const grantee of [USER, '@partner.com']) {
			await table.doc.send(
				new PutCommand({
					TableName: table.name,
					Item: {
						PK: 'GLOBAL',
						SK: `GRANT#root#${grantee}`,
						GSI1PK: `GRANTEE#${grantee}`,
						GSI1SK: 'GLOBAL#root',
						role: 'root',
						grantee,
						grantedBy: 'forged',
						grantedAt: clock.toISOString()
					}
				})
			);
		}
		expect((await rbac.actor(USER)).root).toBe(false);
		expect(await rbac.globalRolesOf(USER)).toEqual([]);
		expect(await rbac.hasRole(root, USER, null, 'root')).toBe(false);
		expect(await rbac.allRoles(root, USER)).toEqual({ globalRoles: [], roles: {} });
	});

	it('hold every role of every system', async () => {
		expect(await rbac.rolesOf(ROOT)).toEqual({ billing: ['editor', 'viewer'], crm: [] });
		expect(await rbac.hasRole(root, ROOT, 'billing', 'editor')).toBe(true);
	});

	it('can grant roles to individuals and domains', async () => {
		await rbac.grant(root, 'billing', 'viewer', 'partner.com');
		await rbac.grant(root, 'billing', 'editor', USER);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor', 'viewer'] });
		expect(await rbac.rolesOf(OTHER)).toEqual({ billing: ['viewer'] });
	});
});

describe('roles are registered data', () => {
	it('a system has only the roles registered for it', async () => {
		expect((await rbac.getSystem(root, 'billing')).roles).toEqual(['editor', 'viewer']);
		expect((await rbac.getSystem(root, 'crm')).roles).toEqual([]);
		expect((await rbac.getSystem(root, 'crm')).implies).toEqual({});
	});

	it('are added and removed by roots, any name but root', async () => {
		await rbac.addRole(root, 'crm', 'Sales');
		await rbac.addRole(root, 'crm', 'admin');
		expect((await rbac.getSystem(root, 'crm')).roles).toEqual(['admin', 'sales']);
		await expectError(rbac.addRole(root, 'crm', 'sales'), 409);
		await rbac.removeRole(root, 'crm', 'admin');
		expect((await rbac.getSystem(root, 'crm')).roles).toEqual(['sales']);
		await expectError(rbac.createSystem(root, { id: 'crm' }), 409);
		await expectError(rbac.createSystem(root, { id: 'Bad Id!' }), 400);
		await expectError(rbac.addRole(root, 'crm', 'Root'), 400, /reserved/);
		await expectError(rbac.createSystem(root, { id: 'x', roles: ['root'] }), 400, /reserved/);
	});

	it('a role named admin is an ordinary role with no powers', async () => {
		await rbac.addRole(root, 'crm', 'admin');
		await rbac.grant(root, 'crm', 'admin', USER);
		const admin = await rbac.actor(USER);
		expect(admin).toEqual({ email: USER, root: false });
		expect(await rbac.rolesOf(USER)).toEqual({ crm: ['admin'] });
		expect(await rbac.listSystems(admin)).toEqual([]);
		await expectError(rbac.getSystem(admin, 'crm'), 403);
		await expectError(rbac.grant(admin, 'crm', 'admin', OTHER), 403);
		await expectError(rbac.createVoucher(admin, { systemId: 'crm', roles: ['admin'] }), 403);
		await expectError(rbac.hasRole(admin, OTHER, 'crm', 'admin'), 403);
	});

	it('removing a role removes its grants', async () => {
		await rbac.grant(root, 'billing', 'editor', USER);
		await rbac.removeRole(root, 'billing', 'editor');
		expect(await rbac.rolesOf(USER)).toEqual({});
	});
});

describe('management is for roots only', () => {
	it('everyone else sees only their own roles and manages nothing', async () => {
		await rbac.grant(root, 'billing', 'editor', USER);
		expect(await rbac.listSystems(user)).toEqual([]);
		await expectError(rbac.getSystem(user, 'billing'), 403);
		await expectError(rbac.createSystem(user, { id: 'x' }), 403);
		await expectError(rbac.deleteSystem(user, 'billing'), 403);
		await expectError(rbac.addRole(user, 'billing', 'x'), 403);
		await expectError(rbac.removeRole(user, 'billing', 'viewer'), 403);
		await expectError(rbac.setImplications(user, 'billing', 'editor', ['viewer']), 403);
		await expectError(rbac.grant(user, 'billing', 'viewer', OTHER), 403);
		await expectError(rbac.revoke(user, 'billing', 'editor', USER), 403);
		await expectError(rbac.listGrants(user, 'billing'), 403);
		await expectError(rbac.createVoucher(user, { systemId: 'billing', roles: ['viewer'] }), 403);
		await expectError(rbac.listVouchers(user, 'billing'), 403);
		await expectError(rbac.grantGlobal(user, 'viewer', OTHER), 403);
		await expectError(rbac.listGlobalGrants(user), 403);
		await expectError(rbac.listGlobalVouchers(user), 403);
	});

	it('roots cannot grant roles missing from the catalog', async () => {
		await expectError(rbac.grant(root, 'billing', 'ghost', USER), 404);
	});
});

describe('role implications are registered data', () => {
	beforeEach(async () => {
		// The example: admin implies premium and free, premium implies free, free implies nothing.
		await rbac.createSystem(root, { id: 'presence', roles: ['admin', 'free', 'premium'] });
		await rbac.setImplications(root, 'presence', 'premium', ['free']);
		await rbac.setImplications(root, 'presence', 'admin', ['free', 'premium']);
	});

	it('a new system or role implies nothing until a root registers it', async () => {
		expect((await rbac.getSystem(root, 'billing')).implies).toEqual({});
		await rbac.addRole(root, 'presence', 'gold');
		expect((await rbac.getSystem(root, 'presence')).implies).toEqual({
			admin: ['free', 'premium'],
			premium: ['free']
		});
		await rbac.grant(root, 'presence', 'admin', USER);
		expect(await rbac.rolesIn(root, USER, 'presence')).toEqual(['admin', 'free', 'premium']);
	});

	it('give the implied roles, transitively; free implies nothing', async () => {
		await rbac.grant(root, 'presence', 'premium', USER);
		await rbac.grant(root, 'presence', 'free', OTHER);
		await rbac.grant(root, 'presence', 'admin', 'boss@partner.com');
		expect(await rbac.rolesOf(USER)).toEqual({ presence: ['free', 'premium'] });
		expect(await rbac.rolesOf(OTHER)).toEqual({ presence: ['free'] });
		expect(await rbac.rolesOf('boss@partner.com')).toEqual({ presence: ['admin', 'free', 'premium'] });
		expect(await rbac.hasRole(root, USER, 'presence', 'free')).toBe(true);
		expect(await rbac.hasRole(root, USER, 'presence', 'admin')).toBe(false);
		expect(await rbac.hasRole(root, OTHER, 'presence', 'premium')).toBe(false);
	});

	it('come with grants returned by the API', async () => {
		expect((await rbac.grant(root, 'presence', 'premium', USER)).impliedRoles).toEqual(['free']);
		expect((await rbac.grant(root, 'presence', 'free', USER)).impliedRoles).toEqual([]);
		expect((await rbac.grant(root, 'presence', 'admin', OTHER)).impliedRoles).toEqual(['free', 'premium']);
		const listed = await rbac.listGrants(root, 'presence');
		expect(listed.find((g) => g.role === 'premium')?.impliedRoles).toEqual(['free']);
		const v = await rbac.createVoucher(root, { systemId: 'presence', roles: ['premium'] });
		expect((await rbac.redeemVoucher('new@partner.com', v.code))[0].impliedRoles).toEqual(['free']);
		await rbac.addRole(root, 'billing', 'premium');
		const global = await rbac.grantGlobal(root, 'premium', 'g@partner.com');
		expect(global.impliedRoles).toEqual([]);
		expect(global.impliedRolesBySystem).toEqual({ billing: [], presence: ['free'] });
		expect((await rbac.listGlobalGrants(root))[0].impliedRolesBySystem).toEqual({ billing: [], presence: ['free'] });
	});

	it('apply to global grants in each system that defines the role', async () => {
		await rbac.addRole(root, 'billing', 'premium');
		await rbac.grantGlobal(root, 'premium', USER);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['premium'], presence: ['free', 'premium'] });
	});

	it('are replaced as a whole, and go away with the role', async () => {
		await rbac.grant(root, 'presence', 'premium', USER);
		await rbac.setImplications(root, 'presence', 'premium', []);
		expect(await rbac.rolesOf(USER)).toEqual({ presence: ['premium'] });
		await rbac.setImplications(root, 'presence', 'premium', ['free']);
		await rbac.removeRole(root, 'presence', 'free');
		expect((await rbac.getSystem(root, 'presence')).implies).toEqual({ admin: ['premium'] });
	});

	it('refuse cycles, self-implication and unknown roles', async () => {
		await expectError(rbac.setImplications(root, 'presence', 'free', ['premium']), 400, /itself/);
		await expectError(rbac.setImplications(root, 'presence', 'free', ['admin']), 400, /itself/);
		await expectError(rbac.setImplications(root, 'presence', 'free', ['free']), 400, /itself/);
		await expectError(rbac.setImplications(root, 'presence', 'free', ['ghost']), 404);
		await expectError(rbac.setImplications(root, 'presence', 'ghost', ['free']), 404);
		await expectError(rbac.setImplications(root, 'nope', 'free', []), 404);
	});
});

describe('roles for everyone', () => {
	it('are held by every identity, with what they imply, until turned off (R9)', async () => {
		await rbac.setImplications(root, 'billing', 'editor', ['viewer']);
		const system = await rbac.configureRole(root, 'billing', 'editor', { everyone: true });
		expect(system.everyone).toEqual(['editor']);
		expect(await rbac.rolesOf('anyone@nowhere.org')).toEqual({ billing: ['editor', 'viewer'] });
		expect(await rbac.hasRole(root, 'anyone@nowhere.org', 'billing', 'viewer')).toBe(true);
		// Shown as the role's property, not as a grant; idempotent.
		expect(await rbac.listGrants(root, 'billing')).toEqual([]);
		expect((await rbac.setEveryone(root, 'billing', 'editor', true)).everyone).toEqual(['editor']);

		expect((await rbac.configureRole(root, 'billing', 'editor', { everyone: false })).everyone).toEqual([]);
		expect(await rbac.rolesOf('anyone@nowhere.org')).toEqual({});
		await rbac.setEveryone(root, 'billing', 'editor', false);
	});

	it('end with their role, and only roots set them (R9, L3, P1)', async () => {
		await expectError(rbac.setEveryone(user, 'billing', 'viewer', true), 403);
		await expectError(rbac.setEveryone(root, 'billing', 'nope', true), 404);
		await rbac.setEveryone(root, 'billing', 'viewer', true);
		await rbac.removeRole(root, 'billing', 'viewer');
		expect(await rbac.rolesOf(USER)).toEqual({});
		// Re-added, the role starts without the property (L4).
		await rbac.addRole(root, 'billing', 'viewer');
		expect((await rbac.getSystem(root, 'billing')).everyone).toEqual([]);
		expect(await rbac.rolesOf(USER)).toEqual({});
	});

	it('need a setting to change (R7, R9)', async () => {
		await expectError(rbac.configureRole(root, 'billing', 'viewer', {}), 400);
	});
});

describe('maintenance mode', () => {
	it('gives nobody any role in the system, roots included, until turned off (R11)', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER);
		await rbac.grantGlobal(root, 'editor', OTHER);
		expect((await rbac.getSystem(root, 'billing')).maintenance).toBe(false);

		const on = await rbac.configureSystem(root, 'billing', { maintenance: true });
		expect(on.maintenance).toBe(true);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: [] });
		expect(await rbac.rolesIn(root, OTHER, 'billing')).toEqual([]);
		expect(await rbac.rolesOf(ROOT)).toMatchObject({ billing: [] });
		for (const email of [USER, OTHER, ROOT]) {
			expect(await rbac.checkRole(root, email, 'billing', 'viewer')).toEqual({ allowed: false, expiresAt: null });
		}
		// Unknown roles are still 404; grants and global roles are kept.
		await expectError(rbac.checkRole(root, USER, 'billing', 'nope'), 404);
		expect((await rbac.listGrants(root, 'billing')).map((g) => g.grantee)).toEqual([USER]);
		expect(await rbac.globalRolesOf(OTHER)).toEqual(['editor']);

		await rbac.configureSystem(root, 'billing', { maintenance: false });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] });
		expect(await rbac.hasRole(root, ROOT, 'billing', 'editor')).toBe(true);
	});

	it('shows in the system status, which anyone may read (R12)', async () => {
		await rbac.configureSystem(root, 'billing', { url: 'https://billing.example.com' });
		expect(await rbac.systemStatus('billing')).toEqual({
			id: 'billing',
			name: 'Billing',
			url: 'https://billing.example.com',
			maintenance: false
		});
		await rbac.configureSystem(root, 'billing', { maintenance: true });
		expect((await rbac.systemStatus('billing')).maintenance).toBe(true);
		expect(await rbac.systemStatus('crm')).toEqual({ id: 'crm', name: 'crm', url: null, maintenance: false });
		await expectError(rbac.systemStatus('nope'), 404);
		await rbac.deleteSystem(root, 'crm');
		await expectError(rbac.systemStatus('crm'), 404);
	});

	it('is set by roots only, on systems that exist (R11, P1)', async () => {
		await expectError(rbac.setMaintenance(user, 'billing', true), 403);
		await expectError(rbac.setMaintenance(root, 'nope', true), 404);
	});
});

describe('system URLs', () => {
	it('are http or https, cleared with null, and readable by anyone (R10)', async () => {
		const set = await rbac.configureSystem(root, 'billing', { url: ' https://billing.example.com/app ' });
		expect(set.url).toBe('https://billing.example.com/app');
		expect(await rbac.systemUrls(['billing', 'crm', 'nope'])).toEqual({ billing: 'https://billing.example.com/app' });
		for (const bad of ['javascript:alert(1)', 'data:text/html,x', '/relative', 'not a url', `https://x.com/${'a'.repeat(2100)}`]) {
			await expectError(rbac.setSystemUrl(root, 'billing', bad), 400);
		}
		await expectError(rbac.setSystemUrl(user, 'billing', 'https://x.com'), 403);
		await expectError(rbac.setSystemUrl(root, 'nope', 'https://x.com'), 404);
		expect((await rbac.configureSystem(root, 'billing', { url: null })).url).toBeNull();
		await expectError(rbac.configureSystem(root, 'billing', {}), 400);
	});
});

describe('vouchers', () => {
	it('get a default code: the quarter and three animals (V2)', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		expect(v.code).toMatch(/^2026Q1(-[A-Z]{2,8}){3}$/);
		expect(v.code.split('-').slice(1).every((a) => ANIMALS.includes(a))).toBe(true);
		expect(quarterOf(new Date('2026-11-30T23:59:59Z'))).toEqual({
			label: '2026Q4',
			start: new Date('2026-10-01T00:00:00Z'),
			end: new Date('2027-01-01T00:00:00Z')
		});
	});

	it('take a custom code, matched ignoring case and separators (V2)', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'], code: ' spring  sale_2026 ' });
		expect(v.code).toBe('SPRING-SALE-2026');
		const [grant] = await rbac.redeemVoucher(USER, 'springsale2026');
		expect(grant.voucherCode).toBe('SPRING-SALE-2026');
		await expectError(rbac.createVoucher(root, { systemId: null, roles: ['viewer'], code: 'Spring-Sale 2026' }), 409, /already exists/);
		await expectError(rbac.createVoucher(root, { systemId: null, roles: ['viewer'], code: 'a-b-c' }), 400, /6 to 40/);
		expect((await rbac.disableVoucher(root, 'spring sale 2026')).disabledBy).toBe(ROOT);
	});

	it('grant several roles at once, all or nothing (V1, V4)', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer', 'editor', 'viewer'] });
		expect(v.roles).toEqual(['editor', 'viewer']);
		expect(v.role).toBe('editor');
		const grants = await rbac.redeemVoucher(USER, v.code);
		expect(grants.map((g) => g.role)).toEqual(['editor', 'viewer']);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor', 'viewer'] });
		await expectError(rbac.createVoucher(root, { systemId: 'billing', roles: [] }), 400, /at least one/);
		await expectError(rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer', 'nope'] }), 404, /"nope"/);
		// Removing any of its roles disables the voucher (L3).
		await rbac.removeRole(root, 'billing', 'editor');
		expect((await rbac.listVouchers(root, 'billing')).find((x) => x.code === v.code)?.disabledAt).not.toBeNull();
	});

	it('made before custom codes still redeem and disable, and keep their codes taken (V2)', async () => {
		await table.doc.send(
			new PutCommand({
				TableName: table.name,
				Item: {
					PK: 'VOUCHER#ABCD-EFGH-JKLM-NPQR',
					SK: 'META',
					GSI1PK: 'VOUCHERS#billing',
					GSI1SK: '2025-12-01T00:00:00.000Z#ABCD-EFGH-JKLM-NPQR',
					code: 'ABCD-EFGH-JKLM-NPQR',
					systemId: 'billing',
					role: 'viewer',
					discountPercent: 100,
					uses: 0,
					createdBy: ROOT,
					createdAt: '2025-12-01T00:00:00.000Z'
				}
			})
		);
		expect((await rbac.listVouchers(root, 'billing'))[0].roles).toEqual(['viewer']);
		await expectError(rbac.createVoucher(root, { systemId: null, roles: ['viewer'], code: 'abcdefghjklmnpqr' }), 409);
		const [grant] = await rbac.redeemVoucher(USER, 'abcd efgh jklm npqr');
		expect(grant.role).toBe('viewer');
		expect((await rbac.disableVoucher(root, 'ABCDEFGHJKLMNPQR')).code).toBe('ABCD-EFGH-JKLM-NPQR');
	});

	it('grant their role to whoever redeems them', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		const [grant] = await rbac.redeemVoucher(USER, v.code.toLowerCase());
		expect(grant).toMatchObject({ systemId: 'billing', role: 'viewer', grantee: USER, voucherCode: v.code });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] });
	});

	it('can be redeemed once per identity', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		await rbac.redeemVoucher(USER, v.code);
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /already/);
		expect((await rbac.listVouchers(root, 'billing')).find((x) => x.code === v.code)?.uses).toBe(1);
	});

	it('respect the usage count', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'], maxUses: 2 });
		await rbac.redeemVoucher('a@x.com', v.code);
		await rbac.redeemVoucher('b@x.com', v.code);
		await expectError(rbac.redeemVoucher('c@x.com', v.code), 409, /no uses left/);
	});

	it('respect the start and end dates', async () => {
		const v = await rbac.createVoucher(root, {
			systemId: 'billing',
			roles: ['viewer'],
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
		const base = { systemId: 'billing', roles: ['viewer'] };
		await expectError(rbac.createVoucher(root, { ...base, maxUses: 0 }), 400);
		await expectError(rbac.createVoucher(root, { ...base, maxUses: 1.5 }), 400);
		await expectError(
			rbac.createVoucher(root, { ...base, startsAt: new Date('2026-02-01'), endsAt: new Date('2026-01-01') }),
			400
		);
		await expectError(rbac.createVoucher(root, { ...base, startsAt: new Date('nope') }), 400);
	});

	it('can be disabled by roots only', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		await expectError(rbac.disableVoucher(user, v.code), 403);
		const disabled = await rbac.disableVoucher(root, v.code);
		expect(voucherStatus(disabled, clock)).toBe('disabled');
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /disabled/);
		await expectError(rbac.disableVoucher(root, 'AAAA-BBBB-CCCC-DDDD'), 404);
	});

	it('unknown codes are not found', async () => {
		await expectError(rbac.redeemVoucher(USER, 'AAAA-BBBB-CCCC-DDDD'), 404);
	});
});

describe('global vouchers and grants', () => {
	it('only roots create them, never for root', async () => {
		await expectError(rbac.createVoucher(user, { systemId: null, roles: ['viewer'] }), 403);
		await expectError(rbac.createVoucher(root, { systemId: null, roles: ['root'] }), 400, /reserved/);
	});

	it('grant the role in every system that defines it, including later ones', async () => {
		const v = await rbac.createVoucher(root, { systemId: null, roles: ['viewer'] });
		expect(v).toMatchObject({ systemId: null, role: 'viewer', discountPercent: 100 });
		const [grant] = await rbac.redeemVoucher(USER, v.code);
		expect(grant).toMatchObject({ systemId: null, role: 'viewer', grantee: USER, voucherCode: v.code });
		expect(await rbac.globalRolesOf(USER)).toEqual(['viewer']);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] }); // crm has no viewer role
		await rbac.createSystem(root, { id: 'later', roles: ['viewer'] });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'], later: ['viewer'] });
		expect((await rbac.listGlobalVouchers(root)).map((x) => x.code)).toEqual([v.code]);
	});

	it('can be granted and revoked directly by roots, also to domains', async () => {
		await rbac.grantGlobal(root, 'editor', 'partner.com');
		expect(await rbac.rolesOf('anyone@partner.com')).toEqual({ billing: ['editor'] });
		expect((await rbac.listGlobalGrants(root)).map((g) => g.grantee)).toEqual(['@partner.com']);
		await rbac.revokeGlobal(root, 'editor', '@partner.com');
		expect(await rbac.globalRolesOf('anyone@partner.com')).toEqual([]);
		await expectError(rbac.revokeGlobal(root, 'editor', '@partner.com'), 404);
	});

	it('are not listed with a system', async () => {
		await rbac.createVoucher(root, { systemId: null, roles: ['viewer'] });
		expect(await rbac.listVouchers(root, 'billing')).toEqual([]);
	});

	it('roots still report only the root global role', async () => {
		await rbac.grantGlobal(root, 'viewer', ROOT);
		expect(await rbac.globalRolesOf(ROOT)).toEqual(['root']);
	});
});

describe('subscription sync', () => {
	const tick = () => (clock = new Date(clock.getTime() + 1000));
	// The billing period around the test clock (2026-01-10).
	const period = { startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: new Date('2026-02-01T00:00:00Z') };
	const renewed = { startsAt: period.endsAt, endsAt: new Date('2026-03-01T00:00:00Z') };
	const outcomes = (r: { systemId: string | null; role: string; outcome: string }[]) =>
		r.map((o) => `${o.systemId}/${o.role}=${o.outcome}`).sort();

	beforeEach(async () => {
		await rbac.setSubscriberRole(root, 'billing', 'viewer');
	});

	it("is configured per system by roots, with a role from the system's catalog (Q2)", async () => {
		expect((await rbac.getSystem(root, 'billing')).subscriberRole).toBe('viewer');
		expect((await rbac.getSystem(root, 'crm')).subscriberRole).toBeNull();
		await expectError(rbac.setSubscriberRole(user, 'billing', 'editor'), 403);
		await expectError(rbac.setSubscriberRole(root, 'billing', 'ghost'), 404, /Role/);
		await expectError(rbac.setSubscriberRole(root, 'nope', 'viewer'), 404, /System/);
		await expectError(rbac.setSubscriberRole(root, 'nope', null), 404, /System/);
		expect((await rbac.setSubscriberRole(root, 'billing', 'Editor')).subscriberRole).toBe('editor');
		expect((await rbac.setSubscriberRole(root, 'billing', null)).subscriberRole).toBeNull();
	});

	it('is cleared when its role is removed (P2)', async () => {
		await rbac.removeRole(root, 'billing', 'viewer');
		expect((await rbac.getSystem(root, 'billing')).subscriberRole).toBeNull();
	});

	it("grants each system's subscriber role, and revokes it when they stop paying (Q2, Q3)", async () => {
		await rbac.addRole(root, 'crm', 'member');
		await rbac.setSubscriberRole(root, 'crm', 'member');
		expect(outcomes(await rbac.syncSubscriber('Sub@Partner.com', period))).toEqual([
			'billing/viewer=granted',
			'crm/member=granted'
		]);
		expect(await rbac.rolesOf('sub@partner.com')).toEqual({ billing: ['viewer'], crm: ['member'] });
		expect((await rbac.listGrants(root, 'billing'))[0]).toMatchObject({ grantee: 'sub@partner.com', grantedBy: 'stripe' });
		tick();
		expect(outcomes(await rbac.syncSubscriber('sub@partner.com', period))).toEqual([
			'billing/viewer=unchanged',
			'crm/member=unchanged'
		]);
		expect(outcomes(await rbac.syncSubscriber('sub@partner.com', null))).toEqual(['billing/viewer=revoked', 'crm/member=revoked']);
		expect(await rbac.rolesOf('sub@partner.com')).toEqual({});
		expect(await rbac.syncSubscriber('sub@partner.com', null)).toEqual([]);
	});

	it('makes the grant match the billing period, following renewals (Q2a)', async () => {
		await rbac.syncSubscriber(USER, period);
		expect((await rbac.listGrants(root, 'billing'))[0]).toMatchObject({ ...period, status: 'active' });
		// Without a renewal the role ends with the period, even if no event arrives.
		clock = period.endsAt;
		expect(await rbac.rolesOf(USER)).toEqual({});
		expect(outcomes(await rbac.syncSubscriber(USER, renewed))).toEqual(['billing/viewer=updated']);
		expect((await rbac.listGrants(root, 'billing'))[0]).toMatchObject({ ...renewed, grantedBy: 'stripe', status: 'active' });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] });
	});

	it('follows configuration changes, revoking grants of roles no longer configured', async () => {
		await rbac.syncSubscriber(USER, period);
		await rbac.setSubscriberRole(root, 'billing', 'editor');
		expect(outcomes(await rbac.syncSubscriber(USER, period))).toEqual(['billing/editor=granted', 'billing/viewer=revoked']);
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor'] });
		await rbac.setSubscriberRole(root, 'billing', null);
		expect(outcomes(await rbac.syncSubscriber(USER, period))).toEqual(['billing/editor=revoked']);
	});

	it("never changes or revokes a grant it didn't make, until that one expires (Q3)", async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: new Date('2026-01-20T00:00:00Z') });
		tick();
		expect(outcomes(await rbac.syncSubscriber(USER, period))).toEqual(['billing/viewer=unchanged']);
		expect(await rbac.syncSubscriber(USER, null)).toEqual([]);
		expect((await rbac.listGrants(root, 'billing'))[0].grantedBy).toBe(ROOT);
		clock = new Date('2026-01-25T00:00:00Z');
		expect(outcomes(await rbac.syncSubscriber(USER, period))).toEqual(['billing/viewer=granted']);
		expect((await rbac.listGrants(root, 'billing'))[0]).toMatchObject({ ...period, grantedBy: 'stripe' });
	});

	it('refuses invalid addresses', async () => {
		await expectError(rbac.syncSubscriber('not-an-address', period), 400);
	});
});

describe('grant validity', () => {
	const feb = new Date('2026-02-01T00:00:00Z');
	const mar = new Date('2026-03-01T00:00:00Z');

	it('defaults to immediately and forever (G1)', async () => {
		const g = await rbac.grant(root, 'billing', 'viewer', USER);
		expect(g).toMatchObject({ startsAt: null, endsAt: null, status: 'active' });
	});

	it('gives the role only from the start until the end, exclusive (G1)', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { startsAt: feb, endsAt: mar });
		await rbac.grantGlobal(root, 'editor', 'partner.com', { startsAt: feb });
		expect((await rbac.listGrants(root, 'billing'))[0].status).toBe('not-started');
		expect(await rbac.rolesOf(USER)).toEqual({});
		expect(await rbac.globalRolesOf(USER)).toEqual([]);
		expect(await rbac.hasRole(root, USER, 'billing', 'viewer')).toBe(false);
		clock = feb;
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor', 'viewer'] });
		expect(await rbac.globalRolesOf(USER)).toEqual(['editor']);
		clock = mar;
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['editor'] });
		expect(await rbac.hasRole(root, USER, 'billing', 'viewer')).toBe(false);
		// Expired grants stay listed until revoked.
		expect((await rbac.listGrants(root, 'billing'))[0].status).toBe('expired');
		await rbac.revoke(root, 'billing', 'viewer', USER);
	});

	it('is replaced by granting again with another validity; the same one is idempotent (G2)', async () => {
		const first = await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: feb });
		clock = new Date(clock.getTime() + 1000);
		expect((await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: feb })).grantedAt).toEqual(first.grantedAt);
		const changed = await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: mar });
		expect(changed).toMatchObject({ endsAt: mar, grantedAt: clock });
		expect(await rbac.listGrants(root, 'billing')).toHaveLength(1);
	});

	it('refuses invalid dates and an end before the start', async () => {
		await expectError(rbac.grant(root, 'billing', 'viewer', USER, { startsAt: mar, endsAt: feb }), 400, /after/);
		await expectError(rbac.grant(root, 'billing', 'viewer', USER, { startsAt: feb, endsAt: feb }), 400);
		await expectError(rbac.grantGlobal(root, 'viewer', USER, { endsAt: new Date('nope') }), 400, /date/);
	});

	it('voucher grants start now and never end, replacing a limited grant (G3)', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: new Date('2026-01-05T00:00:00Z') });
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		const [g] = await rbac.redeemVoucher(USER, v.code);
		expect(g).toMatchObject({ startsAt: null, endsAt: null, status: 'active', voucherCode: v.code });
		expect(await rbac.rolesOf(USER)).toEqual({ billing: ['viewer'] });
		// A grant that already gives the role forever is kept.
		await rbac.grant(root, 'billing', 'editor', OTHER);
		const v2 = await rbac.createVoucher(root, { systemId: 'billing', roles: ['editor'] });
		expect((await rbac.redeemVoucher(OTHER, v2.code))[0].grantedBy).toBe(ROOT);
	});
});

describe('voucher discounts', () => {
	it('default to 100% and must be a whole percentage', async () => {
		const base = { systemId: 'billing', roles: ['viewer'] };
		expect((await rbac.createVoucher(root, base)).discountPercent).toBe(100);
		expect((await rbac.createVoucher(root, { ...base, discountPercent: 0 })).discountPercent).toBe(0);
		for (const bad of [-1, 101, 12.5]) {
			await expectError(rbac.createVoucher(root, { ...base, discountPercent: bad }), 400, /discount/);
		}
	});

	it('below 100% require payment: 402 with the terms, nothing recorded', async () => {
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'], discountPercent: 50, maxUses: 1 });
		const err = await rbac.redeemVoucher(USER, v.code).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(RbacError);
		expect((err as RbacError).status).toBe(402);
		expect((err as RbacError).details?.payment).toEqual({
			code: v.code,
			systemId: 'billing',
			roles: ['viewer'],
			role: 'viewer',
			discountPercent: 50
		});
		expect(await rbac.rolesOf(USER)).toEqual({});
		expect((await rbac.listVouchers(root, 'billing')).find((x) => x.code === v.code)?.uses).toBe(0);
		expect(await scanAll(table).then((items) => items.some((it) => String(it.SK).startsWith('REDEEMED#')))).toBe(false);
	});

	it('expired paid vouchers report expiry, not payment', async () => {
		const v = await rbac.createVoucher(root, {
			systemId: null,
			roles: ['viewer'],
			discountPercent: 20,
			endsAt: new Date('2026-01-01T00:00:00Z')
		});
		await expectError(rbac.redeemVoucher(USER, v.code), 409, /expired/);
	});
});

describe('how long a role check holds (C3a)', () => {
	const feb = new Date('2026-02-01T00:00:00Z');
	const mar = new Date('2026-03-01T00:00:00Z');
	const check = (email: string, systemId: string | null, role: string) => rbac.checkRole(root, email, systemId, role);

	it('is the end of the grant giving the role; none for grants without an end or roots', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: feb });
		expect(await check(USER, 'billing', 'viewer')).toEqual({ allowed: true, expiresAt: feb });
		await rbac.grant(root, 'billing', 'editor', USER);
		expect(await check(USER, 'billing', 'editor')).toEqual({ allowed: true, expiresAt: null });
		expect(await check(ROOT, 'billing', 'viewer')).toEqual({ allowed: true, expiresAt: null });
		expect(await check(ROOT, null, 'root')).toEqual({ allowed: true, expiresAt: null });
	});

	it('is never given for a role not held', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { startsAt: feb });
		expect(await check(USER, 'billing', 'viewer')).toEqual({ allowed: false, expiresAt: null });
		expect(await check(USER, null, 'viewer')).toEqual({ allowed: false, expiresAt: null });
	});

	it('is the latest end among every grant that gives the role', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: feb });
		await rbac.grant(root, 'billing', 'viewer', 'partner.com', { endsAt: mar });
		expect((await check(USER, 'billing', 'viewer')).expiresAt).toEqual(mar);
		await rbac.grantGlobal(root, 'viewer', USER);
		expect((await check(USER, 'billing', 'viewer')).expiresAt).toBeNull();
	});

	it('follows implications and global grants', async () => {
		await rbac.setImplications(root, 'billing', 'editor', ['viewer']);
		await rbac.grant(root, 'billing', 'editor', USER, { endsAt: mar });
		await rbac.grant(root, 'billing', 'viewer', USER, { endsAt: feb });
		expect(await check(USER, 'billing', 'viewer')).toEqual({ allowed: true, expiresAt: mar });
		await rbac.grantGlobal(root, 'editor', OTHER, { endsAt: feb });
		expect(await check(OTHER, 'billing', 'viewer')).toEqual({ allowed: true, expiresAt: feb });
		expect(await check(OTHER, null, 'editor')).toEqual({ allowed: true, expiresAt: feb });
	});

	it('follows the billing period for subscribers', async () => {
		await rbac.setSubscriberRole(root, 'billing', 'viewer');
		await rbac.syncSubscriber(USER, { startsAt: new Date('2026-01-01T00:00:00Z'), endsAt: feb });
		expect(await check(USER, 'billing', 'viewer')).toEqual({ allowed: true, expiresAt: feb });
	});
});

describe('logical deletion (L1-L4)', () => {
	const later = () => (clock = new Date(clock.getTime() + 1000));
	const item = async (sk: string) => (await scanAll(table)).find((it) => it.SK === sk);
	const history = async (prefix: string) => (await scanAll(table)).filter((it) => String(it.SK).startsWith(`HIST#${prefix}`));

	it('deletes nothing: every record stays, marked with who deleted it and when (L1)', async () => {
		await rbac.setImplications(root, 'billing', 'editor', ['viewer']);
		await rbac.grant(root, 'billing', 'editor', USER);
		await rbac.grantGlobal(root, 'viewer', OTHER);
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['editor'] });
		await rbac.redeemVoucher('r@x.com', v.code);
		const before = (await scanAll(table)).length;
		later();
		await rbac.revokeGlobal(root, 'viewer', OTHER);
		await rbac.removeRole(root, 'billing', 'editor');
		await rbac.deleteSystem(root, 'billing');
		await rbac.deleteSystem(root, 'crm');
		expect((await scanAll(table)).length).toBe(before);
		const by = { at: clock.toISOString(), by: ROOT };
		expect(await item(`GRANT#editor#${USER}`)).toMatchObject({ revokedAt: by.at, revokedBy: by.by });
		expect(await item(`GRANT#viewer#${OTHER}`)).toMatchObject({ revokedAt: by.at, revokedBy: by.by });
		expect(await item('ROLE#editor')).toMatchObject({ removedAt: by.at, removedBy: by.by });
		expect(await item('IMPL#editor#viewer')).toMatchObject({ removedAt: by.at, removedBy: by.by });
		expect((await scanAll(table)).find((it) => it.PK === 'SYS#billing' && it.SK === 'META')).toMatchObject({
			deletedAt: by.at,
			deletedBy: by.by
		});
		expect(await item(`REDEEMED#r@x.com`)).toBeDefined();
	});

	it('hides what is deleted: no roles, not listed, not found (L2)', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER);
		await rbac.revoke(root, 'billing', 'viewer', USER);
		expect(await rbac.rolesOf(USER)).toEqual({});
		expect(await rbac.listGrants(root, 'billing')).toEqual([]);
		await expectError(rbac.revoke(root, 'billing', 'viewer', USER), 404);
		await rbac.addRole(root, 'billing', 'gold');
		await rbac.removeRole(root, 'billing', 'gold');
		await expectError(rbac.removeRole(root, 'billing', 'gold'), 404);
		await expectError(rbac.grant(root, 'billing', 'gold', USER), 404);
		await expectError(rbac.hasRole(root, USER, 'billing', 'gold'), 404);
		await rbac.deleteSystem(root, 'crm');
		expect((await rbac.listSystems(root)).map((s) => s.id)).toEqual(['billing']);
		await expectError(rbac.getSystem(root, 'crm'), 404);
		await expectError(rbac.deleteSystem(root, 'crm'), 404);
		await expectError(rbac.addRole(root, 'crm', 'x'), 404);
	});

	it('cascades: removing a role revokes its grants and disables its vouchers, by the same root (L3)', async () => {
		await rbac.grant(root, 'billing', 'editor', USER);
		await rbac.grantGlobal(root, 'editor', OTHER);
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['editor'] });
		later();
		await rbac.removeRole(root, 'billing', 'editor');
		const [disabled] = await rbac.listVouchers(root, 'billing');
		expect(disabled).toMatchObject({ code: v.code, disabledAt: clock, disabledBy: ROOT });
		// The global grant isn't the role's: it gives the role wherever it is defined.
		expect(await rbac.globalRolesOf(OTHER)).toEqual(['editor']);
		expect(await rbac.rolesOf(OTHER)).toEqual({});
	});

	it('keeps a deletion on record when its key is used again (L4)', async () => {
		await rbac.grant(root, 'billing', 'viewer', USER);
		later();
		await rbac.revoke(root, 'billing', 'viewer', USER);
		later();
		const again = await rbac.grant(root, 'billing', 'viewer', USER);
		expect(again).toMatchObject({ grantedAt: clock, status: 'active' });
		expect(await rbac.listGrants(root, 'billing')).toHaveLength(1);
		expect(await history(`GRANT#viewer#${USER}#`)).toEqual([expect.objectContaining({ revokedBy: ROOT, grantee: USER })]);
		// Redeeming a voucher over a revoked grant archives it too.
		await rbac.revoke(root, 'billing', 'viewer', USER);
		later();
		const v = await rbac.createVoucher(root, { systemId: 'billing', roles: ['viewer'] });
		await rbac.redeemVoucher(USER, v.code);
		expect(await history(`GRANT#viewer#${USER}#`)).toHaveLength(2);
	});

	it('lets removed roles, implications and deleted systems come back empty (L4)', async () => {
		await rbac.setImplications(root, 'billing', 'editor', ['viewer']);
		await rbac.setImplications(root, 'billing', 'editor', []);
		await rbac.setImplications(root, 'billing', 'editor', ['viewer']);
		expect((await rbac.getSystem(root, 'billing')).implies).toEqual({ editor: ['viewer'] });
		expect(await history('IMPL#editor#viewer#')).toHaveLength(1);
		await rbac.grant(root, 'billing', 'editor', USER);
		later();
		await rbac.removeRole(root, 'billing', 'editor');
		await rbac.addRole(root, 'billing', 'editor');
		expect((await rbac.getSystem(root, 'billing')).implies).toEqual({});
		expect(await rbac.rolesOf(USER)).toEqual({});
		later();
		await rbac.deleteSystem(root, 'billing');
		await rbac.createSystem(root, { id: 'billing', name: 'Billing 2', roles: ['editor'] });
		expect(await rbac.getSystem(root, 'billing')).toMatchObject({ name: 'Billing 2', roles: ['editor'], implies: {} });
		expect(await rbac.listGrants(root, 'billing')).toEqual([]);
		expect(await history('META#')).toEqual([expect.objectContaining({ name: 'Billing', deletedBy: ROOT })]);
		expect(await history('ROLE#editor#')).toHaveLength(2);
		await expectError(rbac.createSystem(root, { id: 'billing' }), 409);
	});

	it('records the subscription sync as who revoked its grants (L5)', async () => {
		await rbac.setSubscriberRole(root, 'billing', 'viewer');
		await rbac.syncSubscriber(USER, { startsAt: null, endsAt: new Date('2026-02-01T00:00:00Z') });
		await rbac.syncSubscriber(USER, null);
		expect(await item(`GRANT#viewer#${USER}`)).toMatchObject({ revokedBy: 'stripe', revokedAt: clock.toISOString() });
		await rbac.deleteSystem(root, 'billing');
		await rbac.createSystem(root, { id: 'billing', roles: ['viewer'] });
		// A deleted system's subscriber role no longer counts.
		expect(await rbac.syncSubscriber(USER, { startsAt: null, endsAt: new Date('2026-02-01T00:00:00Z') })).toEqual([]);
	});
});

describe('role queries (the external API)', () => {
	beforeEach(async () => {
		await rbac.grant(root, 'billing', 'viewer', USER);
		await rbac.grantGlobal(root, 'editor', OTHER);
	});

	it('check roles with the same rules as rolesOf', async () => {
		expect(await rbac.hasRole(root, USER, 'billing', 'viewer')).toBe(true);
		expect(await rbac.hasRole(root, ' User@Partner.com ', 'billing', 'Viewer')).toBe(true);
		expect(await rbac.hasRole(root, USER, 'billing', 'editor')).toBe(false);
		expect(await rbac.hasRole(root, OTHER, 'billing', 'editor')).toBe(true);
		expect(await rbac.hasRole(root, ROOT, 'billing', 'viewer')).toBe(true);
	});

	it('check global roles when no system is given', async () => {
		expect(await rbac.hasRole(root, ROOT, null, 'root')).toBe(true);
		expect(await rbac.hasRole(root, OTHER, null, 'editor')).toBe(true);
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
		expect(await rbac.allRoles(root, OTHER)).toEqual({ globalRoles: ['editor'], roles: { billing: ['editor'] } });
	});

	it('let anyone ask about themselves', async () => {
		expect(await rbac.hasRole(user, USER, 'billing', 'viewer')).toBe(true);
		expect(await rbac.hasRole(user, USER, null, 'root')).toBe(false);
		expect(await rbac.allRoles(user, USER)).toEqual({ globalRoles: [], roles: { billing: ['viewer'] } });
	});

	it("keep everyone but roots out of other people's roles", async () => {
		await expectError(rbac.hasRole(user, OTHER, 'billing', 'editor'), 403, /Only roots/);
		await expectError(rbac.rolesIn(user, OTHER, 'billing'), 403);
		await expectError(rbac.allRoles(user, ROOT), 403);
	});
});
