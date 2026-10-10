import { PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { queryIndex, type Item, type Table } from './dynamo';
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
/** A bootstrap token (T7): the prefix and at least 32 base64url characters. */
export const BOOTSTRAP_TOKEN_RE = /^rbacr_[A-Za-z0-9_-]{32,}$/;

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

/**
 * A token item: PK `TOKEN#<sha256>` (so authenticating is one key lookup),
 * listed per person through GSI1 (`TOKENS#<email>`, newest last by
 * `<createdAt>#<id>`). Dates are ISO strings; absent means null.
 */
const tokenKey = (hash: string) => ({ PK: `TOKEN#${hash}`, SK: 'META' });

const toToken = (it: Item): ApiToken => ({
	id: it.id as string,
	name: it.name as string,
	prefix: it.prefix as string,
	createdAt: new Date(it.createdAt as string),
	expiresAt: it.expiresAt ? new Date(it.expiresAt as string) : null,
	lastUsedAt: it.lastUsedAt ? new Date(it.lastUsedAt as string) : null,
	revokedAt: it.revokedAt ? new Date(it.revokedAt as string) : null
});

/** 256 random bits, e.g. `rbacr_q3V…`. */
export function generateToken(): string {
	return TOKEN_PREFIX + Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
}

export class ApiTokens {
	constructor(
		private readonly table: Table,
		private readonly now: () => Date = () => new Date()
	) {}

	private items(email: string): Promise<Item[]> {
		return queryIndex(this.table, `TOKENS#${email}`, { newestFirst: true });
	}

	/** Creates a token for `email`. The plain token is returned only here. */
	async create(email: string, input: { name: string; expiresInDays?: number | null }): Promise<{ token: string; apiToken: ApiToken }> {
		const name = input.name.trim();
		if (!name || name.length > NAME_MAX) throw new RbacError(400, `The token name must have 1-${NAME_MAX} characters`);
		const days = input.expiresInDays ?? null;
		if (days !== null && (!Number.isInteger(days) || days < 1 || days > MAX_DAYS)) {
			throw new RbacError(400, `Expiry must be a whole number of days from 1 to ${MAX_DAYS}, or empty for never`);
		}
		const now = this.now();
		const active = (await this.items(email)).filter(
			(it) => !it.revokedAt && (!it.expiresAt || new Date(it.expiresAt as string) > now)
		);
		if (active.length >= MAX_ACTIVE_TOKENS) throw new RbacError(409, `You can have at most ${MAX_ACTIVE_TOKENS} active tokens`);
		const token = generateToken();
		const id = crypto.randomUUID();
		const item: Item = {
			...tokenKey(await hashToken(token)),
			GSI1PK: `TOKENS#${email}`,
			GSI1SK: `${now.toISOString()}#${id}`,
			id,
			prefix: token.slice(0, 12),
			name,
			email,
			createdAt: now.toISOString(),
			expiresAt: days === null ? undefined : new Date(now.getTime() + days * 86_400_000).toISOString()
		};
		await this.table.doc.send(
			new PutCommand({ TableName: this.table.name, Item: item, ConditionExpression: 'attribute_not_exists(PK)' })
		);
		return { token, apiToken: toToken(item) };
	}

	/**
	 * Makes `token`, chosen by the operator, a live token of `email` that never
	 * expires (T7). Idempotent: a token already stored, even revoked, is left as
	 * it is. Only for DynamoDB Local (services.ts), so apps developed against a
	 * local rbacr can use a fixed token without signing in.
	 */
	async bootstrap(email: string, token: string): Promise<void> {
		if (!BOOTSTRAP_TOKEN_RE.test(token)) throw new Error('The bootstrap token must be rbacr_ followed by at least 32 base64url characters');
		const now = this.now();
		const id = crypto.randomUUID();
		try {
			await this.table.doc.send(
				new PutCommand({
					TableName: this.table.name,
					Item: {
						...tokenKey(await hashToken(token)),
						GSI1PK: `TOKENS#${email}`,
						GSI1SK: `${now.toISOString()}#${id}`,
						id,
						prefix: token.slice(0, 12),
						name: 'bootstrap',
						email,
						createdAt: now.toISOString()
					},
					ConditionExpression: 'attribute_not_exists(PK)'
				})
			);
		} catch (err) {
			if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
		}
	}

	/** The person's tokens, newest first; revoked and expired ones stay listed. */
	async list(email: string): Promise<ApiToken[]> {
		return (await this.items(email)).map(toToken);
	}

	/** Revokes one of the person's own tokens for good; the token stays, marked (L1). */
	async revoke(email: string, id: string): Promise<ApiToken> {
		const found = (await this.items(email)).find((it) => it.id === id);
		if (!found) throw new RbacError(404, 'Token not found');
		const { Attributes } = await this.table.doc.send(
			new UpdateCommand({
				TableName: this.table.name,
				Key: { PK: found.PK, SK: found.SK },
				UpdateExpression: 'SET revokedAt = if_not_exists(revokedAt, :now), revokedBy = if_not_exists(revokedBy, :by)',
				ExpressionAttributeValues: { ':now': this.now().toISOString(), ':by': email },
				ReturnValues: 'ALL_NEW'
			})
		);
		return toToken(Attributes!);
	}

	/** The e-mail a live token belongs to, or null (unknown, revoked or expired). Records its use. */
	async authenticate(token: string): Promise<string | null> {
		if (!token.startsWith(TOKEN_PREFIX)) return null;
		const now = this.now().toISOString();
		try {
			const { Attributes } = await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: tokenKey(await hashToken(token)),
					UpdateExpression: 'SET lastUsedAt = :now',
					// ISO-8601 UTC strings compare in time order.
					ConditionExpression:
						'attribute_exists(PK) AND attribute_not_exists(revokedAt) AND (attribute_not_exists(expiresAt) OR expiresAt > :now)',
					ExpressionAttributeValues: { ':now': now },
					ReturnValues: 'ALL_NEW'
				})
			);
			return (Attributes?.email as string) ?? null;
		} catch (err) {
			if ((err as Error).name === 'ConditionalCheckFailedException') return null;
			throw err;
		}
	}
}
