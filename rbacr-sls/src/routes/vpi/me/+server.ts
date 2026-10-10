import { vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const roles = await rbac.rolesOf(actor.email);
		return {
			email: actor.email,
			root: actor.root,
			globalRoles: await rbac.globalRolesOf(actor.email),
			roles,
			// The page links each role to its system (R10) and shows each system's card (R13).
			urls: await rbac.systemUrls(Object.keys(roles)),
			systems: await rbac.systemCards(Object.keys(roles))
		};
	});
