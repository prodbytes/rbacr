import { json } from '@sveltejs/kit';
import { dev } from '$app/env';
import { RBACR_DYNAMODB_ENDPOINT, RBACR_VERSION } from '$app/env/private';
import { googleCredentials } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

/**
 * Health of the app and its configuration (SPEC "Outside both APIs"): the
 * Google OAuth client for sign-in (not required under `vite dev`, which has
 * the dev login, nor on DynamoDB Local, where apps use a bootstrap token).
 * 503 when it's missing. Polled by the Route 53 health check
 * (infra/app.yaml). DynamoDB isn't checked: it is a managed, regional
 * service, and probing it would only add cost to every poll.
 */
export const GET: RequestHandler = () => {
	const checks = { google: googleCredentials() ? 'ok' : 'missing' };
	const ok = checks.google === 'ok' || dev || !!RBACR_DYNAMODB_ENDPOINT;
	return json(
		{ ok, version: RBACR_VERSION, checks },
		{ status: ok ? 200 : 503, headers: { 'cache-control': 'no-store' } }
	);
};
