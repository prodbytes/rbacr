import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { RbacError } from './rbac';
import { hashToken } from './session';
import { createTestDb } from './testing/pglite';
import { ApiTokens } from './tokens';

const ANA = 'ana@example.com';
const BOB = 'bob@example.com';

let db: Db;
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
	db = await createTestDb();
	clock = new Date('2026-01-10T12:00:00Z');
	tokens = new ApiTokens(db, () => clock);
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
		const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM api_tokens');
		expect(rows).toEqual([{ token_hash: await hashToken(token) }]);
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
});
