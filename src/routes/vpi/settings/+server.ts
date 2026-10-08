import { RBACR_PUBLIC_ORIGIN, RBACR_VERSION } from '$app/env/private';
import { vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/**
 * What the settings page shows: the running version, the API's address, the
 * signed-in account and, for roots, the root allow list from the
 * configuration (RBACR_ROOT_LIST).
 */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({
		version: RBACR_VERSION,
		apiBase: `${RBACR_PUBLIC_ORIGIN ?? event.url.origin}/api`,
		email: actor.email,
		root: actor.root,
		rootList: actor.root ? rbac.rootList(actor) : null
	}));
