import { beforeEach, describe, expect, it } from 'vitest';
import type { Db } from './db';
import { SESSION_TTL_MS, Sessions, hashToken } from './session';
import { createTestDb } from './testing/pglite';

let db: Db;
let clock: Date;
let sessions: Sessions;

beforeEach(async () => {
	db = await createTestDb();
	clock = new Date('2026-01-01T00:00:00Z');
	sessions = new Sessions(db, () => clock);
});

describe('Sessions', () => {
	it('round-trips a session and stores only the token hash', async () => {
		const { token, expiresAt } = await sessions.create('ana@example.com');
		expect(expiresAt.getTime() - clock.getTime()).toBe(SESSION_TTL_MS);
		expect(await sessions.validate(token)).toBe('ana@example.com');
		const rows = await db.query<{ token_hash: string }>('SELECT token_hash FROM sessions');
		expect(rows).toEqual([{ token_hash: await hashToken(token) }]);
		expect(rows[0].token_hash).not.toContain(token);
	});

	it('rejects unknown, deleted and expired tokens', async () => {
		expect(await sessions.validate('nope')).toBeNull();
		const a = await sessions.create('a@example.com');
		await sessions.delete(a.token);
		expect(await sessions.validate(a.token)).toBeNull();
		const b = await sessions.create('b@example.com');
		clock = new Date(clock.getTime() + SESSION_TTL_MS);
		expect(await sessions.validate(b.token)).toBeNull();
	});
});
