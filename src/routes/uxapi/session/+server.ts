import { json } from '@sveltejs/kit';
import { dev } from '$app/env';
import { RBACR_DEV_LOGIN } from '$app/env/private';
import { getServices } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

/** Who is signed in (null when nobody), for the layout. */
export const GET: RequestHandler = async ({ locals }) => {
	const devLogin = dev && RBACR_DEV_LOGIN;
	if (!locals.email) return json({ user: null, devLogin });
	const actor = await (await getServices()).rbac.actor(locals.email);
	return json({
		user: { email: actor.email, root: actor.root, manages: actor.root || actor.adminOf.length > 0 },
		devLogin
	});
};
