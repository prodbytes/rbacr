import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({
		email: actor.email,
		root: actor.root,
		adminOf: actor.adminOf,
		globalRoles: await rbac.globalRolesOf(actor.email),
		roles: await rbac.rolesOf(actor.email)
	}));
