import { PGlite, type Transaction } from '@electric-sql/pglite';
import type { Db } from '../db';
import { migrate } from '../schema';

function wrap(pg: PGlite | Transaction, inTransaction: boolean): Db {
	return {
		async query<T>(text: string, params: unknown[] = []) {
			return (await pg.query<T>(text, params)).rows;
		},
		async exec(script: string) {
			await pg.exec(script);
		},
		async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
			if (inTransaction) return fn(this);
			return (pg as PGlite).transaction((tx) => fn(wrap(tx, true)));
		}
	};
}

/** A fresh, migrated in-memory Postgres for tests. */
export async function createTestDb(): Promise<Db> {
	const db = wrap(new PGlite(), false);
	await migrate(db);
	return db;
}
