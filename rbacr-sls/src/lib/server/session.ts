import { DeleteCommand, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { TTL_ATTRIBUTE, type Table } from './dynamo';

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

/** A session item: PK `SESSION#<sha256>`; DynamoDB's TTL removes it some time after expiry. */
const sessionKey = (hash: string) => ({ PK: `SESSION#${hash}`, SK: 'META' });

export class Sessions {
	constructor(
		private readonly table: Table,
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
					[TTL_ATTRIBUTE]: Math.ceil(expiresAt.getTime() / 1000)
				}
			})
		);
		return { token, expiresAt };
	}

	/** Returns the session's e-mail, or null when the token is unknown or expired. */
	async validate(token: string): Promise<string | null> {
		const { Item } = await this.table.doc.send(
			new GetCommand({ TableName: this.table.name, Key: sessionKey(await hashToken(token)) })
		);
		if (!Item) return null;
		// TTL deletion lags, so expiry is always checked here.
		if (new Date(Item.expiresAt as string) <= this.now()) {
			await this.delete(token);
			return null;
		}
		return Item.email as string;
	}

	async delete(token: string): Promise<void> {
		await this.table.doc.send(
			new DeleteCommand({ TableName: this.table.name, Key: sessionKey(await hashToken(token)) })
		);
	}
}
