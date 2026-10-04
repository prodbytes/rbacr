import type { Db } from './db';

/**
 * Ordered, append-only migrations. Never edit an applied entry; add a new one.
 */
export const MIGRATIONS: string[] = [
	`
	CREATE TABLE systems (
		id         text PRIMARY KEY,
		name       text NOT NULL,
		created_by text NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now()
	);

	CREATE TABLE roles (
		system_id  text NOT NULL REFERENCES systems(id) ON DELETE CASCADE,
		name       text NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (system_id, name)
	);

	-- grantee is an e-mail address or a domain written as '@example.com'
	CREATE TABLE grants (
		system_id    text NOT NULL,
		role         text NOT NULL,
		grantee      text NOT NULL,
		granted_by   text NOT NULL,
		granted_at   timestamptz NOT NULL DEFAULT now(),
		voucher_code text,
		PRIMARY KEY (system_id, role, grantee),
		FOREIGN KEY (system_id, role) REFERENCES roles(system_id, name) ON DELETE CASCADE
	);
	CREATE INDEX grants_grantee_idx ON grants (grantee);

	CREATE TABLE vouchers (
		code        text PRIMARY KEY,
		system_id   text NOT NULL,
		role        text NOT NULL,
		starts_at   timestamptz,
		ends_at     timestamptz,
		max_uses    integer CHECK (max_uses IS NULL OR max_uses > 0),
		uses        integer NOT NULL DEFAULT 0,
		created_by  text NOT NULL,
		created_at  timestamptz NOT NULL DEFAULT now(),
		disabled_at timestamptz,
		CHECK (starts_at IS NULL OR ends_at IS NULL OR starts_at < ends_at),
		FOREIGN KEY (system_id, role) REFERENCES roles(system_id, name) ON DELETE CASCADE
	);

	CREATE TABLE voucher_redemptions (
		code        text NOT NULL REFERENCES vouchers(code) ON DELETE CASCADE,
		email       text NOT NULL,
		redeemed_at timestamptz NOT NULL DEFAULT now(),
		PRIMARY KEY (code, email)
	);

	CREATE TABLE sessions (
		token_hash text PRIMARY KEY,
		email      text NOT NULL,
		created_at timestamptz NOT NULL DEFAULT now(),
		expires_at timestamptz NOT NULL
	);
	`,
	// 2: global vouchers and grants (system_id NULL), and voucher discounts.
	// The composite FK to roles isn't checked when system_id is NULL.
	`
	ALTER TABLE vouchers ALTER COLUMN system_id DROP NOT NULL;
	ALTER TABLE vouchers ADD COLUMN discount_percent integer NOT NULL DEFAULT 100
		CHECK (discount_percent BETWEEN 0 AND 100);

	-- The role in every system whose catalog has a role of that name.
	CREATE TABLE global_grants (
		role         text NOT NULL,
		grantee      text NOT NULL,
		granted_by   text NOT NULL,
		granted_at   timestamptz NOT NULL DEFAULT now(),
		voucher_code text,
		PRIMARY KEY (role, grantee)
	);
	CREATE INDEX global_grants_grantee_idx ON global_grants (grantee);
	`,
	// 3: API keys for clients querying roles. Only the token's SHA-256 is stored.
	`
	CREATE TABLE api_keys (
		id           text PRIMARY KEY,
		token_hash   text NOT NULL UNIQUE,
		prefix       text NOT NULL,
		name         text NOT NULL,
		-- NULL: the key may query every system
		system_id    text REFERENCES systems(id) ON DELETE CASCADE,
		created_by   text NOT NULL,
		created_at   timestamptz NOT NULL DEFAULT now(),
		last_used_at timestamptz,
		revoked_at   timestamptz
	);
	`,
	// 4: personal API tokens replace the system API keys of migration 3.
	`
	DROP TABLE api_keys;
	CREATE TABLE api_tokens (
		id           text PRIMARY KEY,
		token_hash   text NOT NULL UNIQUE,
		prefix       text NOT NULL,
		name         text NOT NULL,
		email        text NOT NULL,
		created_at   timestamptz NOT NULL DEFAULT now(),
		expires_at   timestamptz,
		last_used_at timestamptz,
		revoked_at   timestamptz
	);
	CREATE INDEX api_tokens_email_idx ON api_tokens (email);
	`
];

// Arbitrary constant identifying the migration advisory lock.
const MIGRATION_LOCK = 727_163_001;

/**
 * Applies pending migrations. Safe to call from many cold-starting Lambda
 * instances at once: the advisory lock serialises them.
 */
export async function migrate(db: Db): Promise<void> {
	await db.transaction(async (tx) => {
		await tx.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK]);
		await tx.query(
			`CREATE TABLE IF NOT EXISTS schema_migrations (
				version    integer PRIMARY KEY,
				applied_at timestamptz NOT NULL DEFAULT now()
			)`
		);
		const rows = await tx.query<{ v: number | null }>('SELECT max(version) AS v FROM schema_migrations');
		const current = rows[0]?.v ?? 0;
		for (let version = current + 1; version <= MIGRATIONS.length; version++) {
			await tx.exec(MIGRATIONS[version - 1]);
			await tx.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
		}
	});
}
