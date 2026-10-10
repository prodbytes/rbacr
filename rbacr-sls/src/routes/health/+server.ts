import { json } from '@sveltejs/kit';
import { dev } from '$app/env';
import { RBACR_VERSION } from '$app/env/private';
import { googleCredentials } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

/**
 * Health of the app and its configuration (SPEC "Outside both APIs"): the
 * Google OAuth client for sign-in (not required under `vite dev`, which has
 * the dev login). 503 when it's missing. Polled by the Route 53 health check
 * (infra/app.yaml). DynamoDB isn't checked: it is a managed, regional
 * service, and probing it would only add cost to every poll.
 */
export const GET: RequestHandler = () => {
	const checks = { google: googleCredentials() ? 'ok' : 'missing' };
	const ok = checks.google === 'ok' || dev;
	return json(
		{ ok, version: RBACR_VERSION, checks },
		{ status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
