import {
	RBACR_DATABASE_URL,
	RBACR_GOOGLE_CLIENT_ID,
	RBACR_GOOGLE_CLIENT_SECRET,
	RBACR_PUBLIC_ORIGIN,
	RBACR_ROOT_LIST
} from '$app/env/private';
import { createPostgresDb, type Db } from './db';
import { Allowlist } from './identity';
import { Rbac } from './rbac';
import { migrate } from './schema';
import { Sessions } from './session';
import { ApiTokens } from './tokens';

export interface Services {
	db: Db;
	rbac: Rbac;
	sessions: Sessions;
	tokens: ApiTokens;
}

let services: Promise<Services> | undefined;

/** Lazily connects and migrates once per process (i.e. once per Lambda cold start). */
export function getServices(): Promise<Services> {
	services ??= (async () => {
		if (!RBACR_DATABASE_URL) throw new Error('RBACR_DATABASE_URL is not set');
		const db = createPostgresDb(RBACR_DATABASE_URL);
		await migrate(db);
		return { db, rbac: new Rbac(db, Allowlist.parse(RBACR_ROOT_LIST)), sessions: new Sessions(db), tokens: new ApiTokens(db) };
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
