import { RBACR_PUBLIC_ORIGIN, RBACR_VERSION } from '$app/env/private';
import { vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** What the settings page shows: the running version, the API's address and the signed-in account. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ actor }) => ({
		version: RBACR_VERSION,
		apiBase: `${RBACR_PUBLIC_ORIGIN ?? event.url.origin}/api`,
		email: actor.email,
		root: actor.root
	}));
