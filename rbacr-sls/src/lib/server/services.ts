import {
	RBACR_DYNAMODB_ENDPOINT,
	RBACR_DYNAMODB_TABLE,
	RBACR_GOOGLE_CLIENT_ID,
	RBACR_GOOGLE_CLIENT_SECRET,
	RBACR_PUBLIC_ORIGIN,
	RBACR_ROOT_LIST,
	RBACR_STRIPE_API_KEY,
	RBACR_STRIPE_WEBHOOK_SECRET
} from '$app/env/private';
import { createTable, ensureTable, type Table } from './dynamo';
import { Allowlist } from './identity';
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
		// Locally (DynamoDB Local) the app creates its table; in AWS infra/tables.yaml does.
		if (RBACR_DYNAMODB_ENDPOINT) await ensureTable(table);
		return {
			table,
			rbac: new Rbac(table, Allowlist.parse(RBACR_ROOT_LIST)),
			sessions: new Sessions(table),
			tokens: new ApiTokens(table)
		};
	})().catch((err) => {
		services = undefined; // retry on the next request instead of caching the failure
		throw err;
	});
	return services;
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
