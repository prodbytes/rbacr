import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { TTL_ATTRIBUTE, type Table } from './dynamo';

export const SESSION_COOKIE = 'rbacr_session';
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** How long a session record is kept after the session expires (RBACR_SESSION_RETENTION_DAYS). */
export const DEFAULT_SESSION_RETENTION_DAYS = 365;
const DAY_MS = 24 * 60 * 60 * 1000;

function randomToken(): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

/** Only a SHA-256 of the token is stored, so a database leak does not leak live sessions. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Buffer.from(digest).toString('hex');
}

/**
 * A session item in the sessions table: PK `SESSION#<sha256>`. Ended sessions
 * stay, marked or expired (L1), until DynamoDB's TTL purges them the
 * retention period after they expire (S3).
 */
const sessionKey = (hash: string) => ({ PK: `SESSION#${hash}`, SK: 'META' });

export class Sessions {
	constructor(
		/** The sessions table, not the main one. */
		private readonly table: Table,
		private readonly retentionDays: number = DEFAULT_SESSION_RETENTION_DAYS,
		private readonly now: () => Date = () => new Date()
	) {}

	async create(email: string): Promise<{ token: string; expiresAt: Date }> {
		const token = randomToken();
		const now = this.now();
		const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
		await this.table.doc.send(
			new PutCommand({
				TableName: this.table.name,
				Item: {
					...sessionKey(await hashToken(token)),
					email,
					createdAt: now.toISOString(),
					expiresAt: expiresAt.toISOString(),
					[TTL_ATTRIBUTE]: Math.ceil((expiresAt.getTime() + this.retentionDays * DAY_MS) / 1000)
				}
			})
		);
		return { token, expiresAt };
	}

	/** Returns the session's e-mail, or null when the token is unknown, signed out or expired. */
	async validate(token: string): Promise<string | null> {
		const { Item } = await this.table.doc.send(
			new GetCommand({ TableName: this.table.name, Key: sessionKey(await hashToken(token)) })
		);
		if (!Item || Item.revokedAt || new Date(Item.expiresAt as string) <= this.now()) return null;
		return Item.email as string;
	}

	/** Signs a session out (S3): marks it revoked, by its owner, instead of deleting it (L1). */
	async revoke(token: string): Promise<void> {
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: sessionKey(await hashToken(token)),
					UpdateExpression: 'SET revokedAt = if_not_exists(revokedAt, :now), revokedBy = if_not_exists(revokedBy, email)',
					ConditionExpression: 'attribute_exists(PK)',
					ExpressionAttributeValues: { ':now': this.now().toISOString() }
				})
			);
		} catch (err) {
			if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
		}
	}
}
