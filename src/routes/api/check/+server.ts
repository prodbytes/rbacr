import { api, optStr, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/**
 * Does an identity hold a role (in a system, or globally without systemId)?
 * Anyone may ask about themselves, roots about anyone, admins about their
 * systems. POST keeps e-mail addresses out of URLs and logs.
 */
export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const email = str(body.email, 'email');
		const systemId = optStr(body.systemId, 'systemId');
		const role = str(body.role, 'role');
		const allowed = await rbac.hasRole(actor, email, systemId, role);
		return { email: email.toLowerCase(), systemId, role: role.toLowerCase(), allowed };
	});
