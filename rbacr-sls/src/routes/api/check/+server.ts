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
		const { allowed, expiresAt } = await rbac.checkRole(actor, email, systemId, role);
		// How long a "yes" may be cached (C3a): until the grants giving it end.
		const ttl = expiresAt ? Math.max(0, Math.floor((expiresAt.getTime() - Date.now()) / 1000)) : null;
		return { email: email.toLowerCase(), systemId, role: role.toLowerCase(), allowed, expiresAt: expiresAt?.toISOString() ?? null, ttl };
	});
