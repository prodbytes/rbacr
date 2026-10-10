import {
	RBACR_BOOTSTRAP_EMAIL,
	RBACR_BOOTSTRAP_TOKEN,
	RBACR_CORS_ORIGINS,
	RBACR_DYNAMODB_ENDPOINT,
	RBACR_DYNAMODB_SESSIONS_TABLE,
	RBACR_DYNAMODB_TABLE,
	RBACR_GOOGLE_AUDIENCES,
	RBACR_GOOGLE_CLIENT_ID,
	RBACR_GOOGLE_CLIENT_SECRET,
	RBACR_PUBLIC_ORIGIN,
	RBACR_ROOT_LIST,
	RBACR_SESSION_RETENTION_DAYS,
	RBACR_STRIPE_API_KEY,
	RBACR_STRIPE_WEBHOOK_SECRET
} from '$app/env/private';
import { parseCorsOrigins } from './cors';
import { createTable, ensureTable, type Table } from './dynamo';
import { GoogleIdTokens, parseAudiences } from './idtokens';
import { Allowlist, normalizeEmail } from './identity';
import { Rbac } from './rbac';
import { Sessions } from './session';
import { ApiTokens } from './tokens';

export interface Services {
	table: Table;
	rbac: Rbac;
	sessions: Sessions;
	tokens: ApiTokens;
}

let services: Promise<Services> | undefined;

/** Created once per process (i.e. once per Lambda cold start). */
export function getServices(): Promise<Services> {
	services ??= (async () => {
		if (!RBACR_DYNAMODB_TABLE) throw new Error('RBACR_DYNAMODB_TABLE is not set');
		const table = createTable(RBACR_DYNAMODB_TABLE, RBACR_DYNAMODB_ENDPOINT);
		const sessionsTable = createTable(RBACR_DYNAMODB_SESSIONS_TABLE ?? `${RBACR_DYNAMODB_TABLE}-sessions`, RBACR_DYNAMODB_ENDPOINT);
		// Locally (DynamoDB Local) the app creates its tables; in AWS infra/tables.yaml does.
		if (RBACR_DYNAMODB_ENDPOINT) await Promise.all([ensureTable(table), ensureTable(sessionsTable, 'sessions')]);
		const tokens = new ApiTokens(table);
		if (RBACR_BOOTSTRAP_TOKEN) await bootstrapToken(tokens, RBACR_BOOTSTRAP_TOKEN);
		return {
			table,
			rbac: new Rbac(table, Allowlist.parse(RBACR_ROOT_LIST)),
			sessions: new Sessions(sessionsTable, RBACR_SESSION_RETENTION_DAYS),
			tokens
		};
	})().catch((err) => {
		services = undefined; // retry on the next request instead of caching the failure
		throw err;
	});
	return services;
}

/** T7: a fixed token for local development, never in AWS (no DynamoDB endpoint override there). */
async function bootstrapToken(tokens: ApiTokens, token: string): Promise<void> {
	if (!RBACR_DYNAMODB_ENDPOINT) throw new Error('RBACR_BOOTSTRAP_TOKEN is only allowed with RBACR_DYNAMODB_ENDPOINT (DynamoDB Local)');
	const email = normalizeEmail(RBACR_BOOTSTRAP_EMAIL ?? '');
	if (!email) throw new Error('RBACR_BOOTSTRAP_TOKEN needs RBACR_BOOTSTRAP_EMAIL, a valid e-mail address');
	await tokens.bootstrap(email, token);
}

export function googleCredentials(): { clientId: string; clientSecret: string } | null {
	if (!RBACR_GOOGLE_CLIENT_ID || !RBACR_GOOGLE_CLIENT_SECRET) return null;
	return { clientId: RBACR_GOOGLE_CLIENT_ID, clientSecret: RBACR_GOOGLE_CLIENT_SECRET };
}

/** Google's redirect URI: on the public origin (RBACR_PUBLIC_ORIGIN) when behind a proxy. */
export function googleRedirectUri(url: URL): string {
	return `${RBACR_PUBLIC_ORIGIN ?? url.origin}/login/google/callback`;
}

export interface StripeSync {
	webhookSecret: string;
	apiKey: string;
}

/** The paid-subscription sync's settings, or null when it is off. */
export function stripeSync(): StripeSync | null {
	if (!RBACR_STRIPE_WEBHOOK_SECRET || !RBACR_STRIPE_API_KEY) return null;
	return {
		webhookSecret: RBACR_STRIPE_WEBHOOK_SECRET,
		apiKey: RBACR_STRIPE_API_KEY
	};
}

let idTokens: GoogleIdTokens | null | undefined;

/** The verifier of apps' Google ID tokens (I1), or null when RBACR_GOOGLE_AUDIENCES is empty. Its key cache lives per process. */
export function googleIdTokens(): GoogleIdTokens | null {
	if (idTokens === undefined) {
		const audiences = parseAudiences(RBACR_GOOGLE_AUDIENCES);
		idTokens = audiences.length ? new GoogleIdTokens(audiences) : null;
	}
	return idTokens;
}

let cors: string[] | undefined;

/** The origins allowed to call /api from a browser (H3); empty: no CORS. */
export function corsOrigins(): readonly string[] {
	cors ??= parseCorsOrigins(RBACR_CORS_ORIGINS);
	return cors;
}
