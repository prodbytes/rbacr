import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({
		email: actor.email,
		// On the root list, even through an app's ID token, which has no root powers (I5).
		root: rbac.isRoot(actor.email),
		globalRoles: await rbac.globalRolesOf(actor.email),
		roles: await rbac.rolesOf(actor.email)
	}));
