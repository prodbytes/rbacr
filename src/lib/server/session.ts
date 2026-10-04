import type { Db } from './db';

export const SESSION_COOKIE = 'rbacr_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function randomToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** Only a SHA-256 of the token is stored, so a database leak does not leak live sessions. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Buffer.from(digest).toString('hex');
}

export class Sessions {
	constructor(
		private readonly db: Db,
		private readonly now: () => Date = () => new Date()
	) {}

	async create(email: string): Promise<{ token: string; expiresAt: Date }> {
		const token = randomToken();
		const expiresAt = new Date(this.now().getTime() + SESSION_TTL_MS);
		await this.db.query('INSERT INTO sessions (token_hash, email, expires_at) VALUES ($1, $2, $3)', [
			await hashToken(token),
			email,
			expiresAt
		]);
		return { token, expiresAt };
	}

	/** Returns the session's e-mail, or null when the token is unknown or expired. */
	async validate(token: string): Promise<string | null> {
		const [row] = await this.db.query<{ email: string; expires_at: Date }>(
			'SELECT email, expires_at FROM sessions WHERE token_hash = $1',
			[await hashToken(token)]
		);
		if (!row) return null;
		if (new Date(row.expires_at) <= this.now()) {
			await this.delete(token);
			return null;
		}
		return row.email;
	}

	async delete(token: string): Promise<void> {
		await this.db.query('DELETE FROM sessions WHERE token_hash = $1', [await hashToken(token)]);
	}

	async purgeExpired(): Promise<void> {
		await this.db.query('DELETE FROM sessions WHERE expires_at <= $1', [this.now()]);
	}
}
