import { beforeEach, describe, expect, it } from 'vitest';
import type { Table } from './dynamo';
import { RbacError } from './rbac';
import { hashToken } from './session';
import { createTestTable, scanAll } from './testing/dynamodb';
import { ApiTokens } from './tokens';

const ANA = 'ana@example.com';
const BOB = 'bob@example.com';

let table: Table;
let clock: Date;
let tokens: ApiTokens;

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
	tokens = new ApiTokens(table, () => clock);
});

describe('personal API tokens', () => {
	it('are shown once and stored only as a hash', async () => {
		const { token, apiToken } = await tokens.create(ANA, { name: ' billing sync ', expiresInDays: 30 });
		expect(token).toMatch(/^rbacr_[A-Za-z0-9_-]{43}$/);
		expect(apiToken).toMatchObject({
			name: 'billing sync',
			prefix: token.slice(0, 12),
			createdAt: clock,
			expiresAt: new Date('2026-02-09T12:00:00Z'),
			lastUsedAt: null,
			revokedAt: null
		});
		expect(await tokens.list(ANA)).toEqual([apiToken]);
		expect(await tokens.list(BOB)).toEqual([]);
		const items = await scanAll(table);
		expect(items.map((it) => it.PK)).toEqual([`TOKEN#${await hashToken(token)}`]);
		expect(JSON.stringify(items)).not.toContain(token);
	});

	it('authenticate as their owner, recording the last use', async () => {
		const { token } = await tokens.create(ANA, { name: 'cli' });
		expect(await tokens.authenticate(token)).toBe(ANA);
		expect((await tokens.list(ANA))[0].lastUsedAt).toEqual(clock);
		expect(await tokens.authenticate(token + 'x')).toBeNull();
		expect(await tokens.authenticate('not-a-token')).toBeNull();
	});

	it('stop working when revoked, by their owner only', async () => {
		const { token, apiToken } = await tokens.create(ANA, { name: 'cli' });
		await expectError(tokens.revoke(BOB, apiToken.id), 404);
		expect((await tokens.revoke(ANA, apiToken.id)).revokedAt).toEqual(clock);
		expect(await tokens.authenticate(token)).toBeNull();
		await expectError(tokens.revoke(ANA, 'missing'), 404);
		// The token stays, marked (L1).
		expect((await scanAll(table)).find((it) => it.id === apiToken.id)).toMatchObject({ revokedBy: ANA });
	});

	it('stop working when expired', async () => {
		const { token } = await tokens.create(ANA, { name: 'cli', expiresInDays: 1 });
		clock = new Date(clock.getTime() + 86_400_000);
		expect(await tokens.authenticate(token)).toBeNull();
	});

	it('validate names and expiry, and cap active tokens', async () => {
		await expectError(tokens.create(ANA, { name: '  ' }), 400);
		await expectError(tokens.create(ANA, { name: 'x'.repeat(101) }), 400);
		for (const bad of [0, -1, 1.5, 3651]) await expectError(tokens.create(ANA, { name: 'x', expiresInDays: bad }), 400);
		for (let i = 0; i < 25; i++) await tokens.create(ANA, { name: `t${i}` });
		await expectError(tokens.create(ANA, { name: 'one too many' }), 409);
		expect((await tokens.create(BOB, { name: 'bob' })).apiToken.name).toBe('bob');
	});

	it('can be bootstrapped with a fixed value, once (T7)', async () => {
		const token = 'rbacr_' + 'a'.repeat(43);
		await tokens.bootstrap(ANA, token);
		expect(await tokens.authenticate(token)).toBe(ANA);
		const [listed] = await tokens.list(ANA);
		expect(listed).toMatchObject({ name: 'bootstrap', prefix: token.slice(0, 12), expiresAt: null, revokedAt: null });
		// Again (every start): nothing changes, and a revoked token stays revoked.
		await tokens.revoke(ANA, listed.id);
		await tokens.bootstrap(ANA, token);
		expect(await tokens.list(ANA)).toHaveLength(1);
		expect(await tokens.authenticate(token)).toBeNull();
		for (const bad of ['', 'rbacr_short', 'x'.repeat(50), `rbacr_${'a'.repeat(40)}!`]) {
			await expect(tokens.bootstrap(BOB, bad)).rejects.toThrow(/bootstrap token/);
		}
		expect(await tokens.list(BOB)).toEqual([]);
	});
});
