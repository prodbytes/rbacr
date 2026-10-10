import { redirect } from '@sveltejs/kit';
import { getServices } from '#lib/server/services.js';
import { SESSION_COOKIE } from '#lib/server/session.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	const token = cookies.get(SESSION_COOKIE);
	if (token) await (await getServices()).sessions.revoke(token);
	cookies.delete(SESSION_COOKIE, { path: '/' });
	redirect(303, '/');
};
