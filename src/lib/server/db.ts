import postgres from 'postgres';

/**
 * Minimal database interface so the same SQL runs against postgres.js in
 * production and PGlite (in-process Postgres) in tests.
 */
export interface Db {
	query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>;
	/** Runs a multi-statement script without parameters (simple query protocol). */
	exec(script: string): Promise<void>;
	transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R>;
}

type Sql = postgres.Sql | postgres.TransactionSql;

function wrapPostgres(sql: Sql, inTransaction: boolean): Db {
	return {
		async query<T>(text: string, params: unknown[] = []) {
			return (await sql.unsafe(text, params as postgres.ParameterOrJSON<never>[])) as unknown as T[];
		},
		async exec(script: string) {
			await sql.unsafe(script).simple();
		},
		async transaction<R>(fn: (tx: Db) => Promise<R>): Promise<R> {
			if (inTransaction) return fn(this);
			return (await (sql as postgres.Sql).begin((tx) => fn(wrapPostgres(tx, true)))) as R;
		}
	};
}

export function createPostgresDb(url: string): Db {
	// Lambda serves one request per instance at a time, so a single connection
	// per instance is enough and keeps the database's connection count low.
	const onLambda = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);
	const sql = postgres(url, {
		max: onLambda ? 1 : 10,
		idle_timeout: onLambda ? 60 : 0,
		onnotice: () => {}
	});
	return wrapPostgres(sql, false);
}
