import { json } from '@sveltejs/kit';
import { dev } from '$app/env';
import { RBACR_VERSION } from '$app/env/private';
import { getServices, googleCredentials } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

/** How long the database may take to answer before it counts as down. */
const DATABASE_TIMEOUT_MS = 3000;

type Check = 'ok' | 'error' | 'missing';

async function database(): Promise<Check> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`no answer within ${DATABASE_TIMEOUT_MS} ms`)), DATABASE_TIMEOUT_MS);
	});
	try {
		// Connects and migrates on first use, then a round trip.
		await Promise.race([getServices().then(({ db }) => db.query('SELECT 1')), timeout]);
		return 'ok';
	} catch (err) {
		console.error('health: database check failed:', err);
		return 'error';
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Health of the app and what it needs to serve (SPEC "Outside both APIs"):
 * the database, and the Google OAuth client for sign-in (not required under
 * `vite dev`, which has the dev login). 503 when a required check fails.
 * Polled by the Route 53 health check (infra/app.yaml); reveals only check
 * names and states, never error details.
 */
export const GET: RequestHandler = async () => {
	const checks: Record<string, Check> = {
		database: await database(),
		google: googleCredentials() ? 'ok' : 'missing'
	};
	const ok = checks.database === 'ok' && (checks.google === 'ok' || dev);
	return json(
		{ ok, version: RBACR_VERSION, checks },
		{ status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
