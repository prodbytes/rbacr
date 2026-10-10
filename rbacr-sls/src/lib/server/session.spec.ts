import { beforeEach, describe, expect, it } from 'vitest';
import type { Table } from './dynamo';
import { SESSION_TTL_MS, Sessions, hashToken } from './session';
import { createTestTable, scanAll } from './testing/dynamodb';

let table: Table;
let clock: Date;
let sessions: Sessions;

beforeEach(async () => {
	table = await createTestTable('sessions');
	clock = new Date('2026-01-01T00:00:00Z');
	sessions = new Sessions(table, 365, () => clock);
});

describe('Sessions', () => {
	it('round-trips a session and stores only the token hash', async () => {
		const { token, expiresAt } = await sessions.create('ana@example.com');
		expect(expiresAt.getTime() - clock.getTime()).toBe(SESSION_TTL_MS);
		expect(await sessions.validate(token)).toBe('ana@example.com');
		const items = await scanAll(table);
		expect(items.map((it) => it.PK)).toEqual([`SESSION#${await hashToken(token)}`]);
		expect(JSON.stringify(items)).not.toContain(token);
		// DynamoDB's TTL purges the record a year (the default retention) after the session expires.
		expect(items[0].ttl).toBe(Math.ceil(expiresAt.getTime() / 1000) + 365 * 86_400);
	});

	it('keeps records for the configured retention (S3)', async () => {
		const { expiresAt } = await new Sessions(table, 7, () => clock).create('ana@example.com');
		expect((await scanAll(table))[0].ttl).toBe(Math.ceil(expiresAt.getTime() / 1000) + 7 * 86_400);
	});

	it('rejects unknown, signed-out and expired tokens, keeping their sessions (L1)', async () => {
		expect(await sessions.validate('nope')).toBeNull();
		const a = await sessions.create('a@example.com');
		clock = new Date(clock.getTime() + 1000);
		await sessions.revoke(a.token);
		expect(await sessions.validate(a.token)).toBeNull();
		const b = await sessions.create('b@example.com');
		clock = new Date(clock.getTime() + SESSION_TTL_MS);
		expect(await sessions.validate(b.token)).toBeNull();
		const items = await scanAll(table);
		expect(items).toHaveLength(2);
		expect(items.find((it) => it.email === 'a@example.com')).toMatchObject({
			revokedAt: '2026-01-01T00:00:01.000Z',
			revokedBy: 'a@example.com'
		});
	});
});
