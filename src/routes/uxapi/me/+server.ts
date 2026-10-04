import { ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => ({
		email: actor.email,
		root: actor.root,
		globalRoles: await rbac.globalRolesOf(actor.email),
		roles: await rbac.rolesOf(actor.email)
	}));
