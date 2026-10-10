import { api, optStr, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** An identity's roles in one system, or (without systemId) everywhere plus its global roles. */
export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const email = str(body.email, 'email').toLowerCase();
		const systemId = optStr(body.systemId, 'systemId');
		if (systemId !== null) return { email, systemId, roles: await rbac.rolesIn(actor, email, systemId) };
		return { email, ...(await rbac.allRoles(actor, email)) };
	});
