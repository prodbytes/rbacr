import type { Db } from './db';
import { RbacError } from './rbac';
import { hashToken } from './session';

/**
 * Personal API tokens: how external callers authenticate to /api. A token
 * acts as the person who created it, with that person's current roles (root
 * status included), so revoking a person's roles also limits their tokens.
 * Only a SHA-256 of the token is stored; the token is shown once.
 */

export const TOKEN_PREFIX = 'rbacr_';
const NAME_MAX = 100;
const MAX_ACTIVE_TOKENS = 25;
const MAX_DAYS = 3650;

export interface ApiToken {
	id: string;
	name: string;
	/** The token's first characters, to recognise it. */
	prefix: string;
	createdAt: Date;
	/** null: never expires. */
	expiresAt: Date | null;
	lastUsedAt: Date | null;
	revokedAt: Date | null;
}

type Row = {
	id: string;
	name: string;
	prefix: string;
	created_at: Date;
	expires_at: Date | null;
	last_used_at: Date | null;
	revoked_at: Date | null;
};

const COLUMNS = 'id, name, prefix, created_at, expires_at, last_used_at, revoked_at';

const toToken = (r: Row): ApiToken => ({
	id: r.id,
	name: r.name,
	prefix: r.prefix,
	createdAt: new Date(r.created_at),
	expiresAt: r.expires_at && new Date(r.expires_at),
	lastUsedAt: r.last_used_at && new Date(r.last_used_at),
	revokedAt: r.revoked_at && new Date(r.revoked_at)
});

/** 256 random bits, e.g. `rbacr_q3V…`. */
export function generateToken(): string {
	return TOKEN_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export class ApiTokens {
	constructor(
		private readonly db: Db,
		private readonly now: () => Date = () => new Date()
	) {}

	/** Creates a token for `email`. The plain token is returned only here. */
	async create(email: string, input: { name: string; expiresInDays?: number | null }): Promise<{ token: string; apiToken: ApiToken }> {
		const name = input.name.trim();
		if (!name || name.length > NAME_MAX) throw new RbacError(400, `The token name must have 1-${NAME_MAX} characters`);
		const days = input.expiresInDays ?? null;
		if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)) {
			throw new RbacError(400, `Expiry must be a whole number of days from 1 to ${MAX_DAYS}, or empty for never`);
		}
		const now = this.now();
		const [{ n }] = await this.db.query<{ n: number }>(
			`SELECT count(*)::int AS n FROM api_tokens
			 WHERE email = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)`,
			[email, now]
		);
		if (n >= MAX_ACTIVE_TOKENS) throw new RbacError(409, `You can have at most ${MAX_ACTIVE_TOKENS} active tokens`);
		const token = generateToken();
		const expiresAt = days === null ? null : new Date(now.getTime() + days * 86_400_000);
		const [row] = await this.db.query<Row>(
			`INSERT INTO api_tokens (id, token_hash, prefix, name, email, created_at, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING ${COLUMNS}`,
			[crypto.randomUUID(), await hashToken(token), token.slice(0, 12), name, email, now, expiresAt]
		);
		return { token, apiToken: toToken(row) };
	}

	/** The person's tokens, newest first; revoked and expired ones stay listed. */
	async list(email: string): Promise<ApiToken[]> {
		const rows = await this.db.query<Row>(
			`SELECT ${COLUMNS} FROM api_tokens WHERE email = $1 ORDER BY created_at DESC, id`,
			[email]
		);
		return rows.map(toToken);
	}

	/** Revokes one of the person's own tokens for good. */
	async revoke(email: string, id: string): Promise<ApiToken> {
		const [row] = await this.db.query<Row>(
			`UPDATE api_tokens SET revoked_at = coalesce(revoked_at, $3)
			 WHERE id = $1 AND email = $2 RETURNING ${COLUMNS}`,
			[id, email, this.now()]
		);
		if (!row) throw new RbacError(404, 'Token not found');
		return toToken(row);
	}

	/** The e-mail a live token belongs to, or null (unknown, revoked or expired). Records its use. */
	async authenticate(token: string): Promise<string | null> {
		if (!token.startsWith(TOKEN_PREFIX)) return null;
		const now = this.now();
		const [row] = await this.db.query<{ email: string }>(
			`UPDATE api_tokens SET last_used_at = $2
			 WHERE token_hash = $1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > $2)
			 RETURNING email`,
			[await hashToken(token), now]
		);
		return row?.email ?? null;
	}
}
