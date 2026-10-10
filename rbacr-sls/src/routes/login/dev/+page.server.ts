import { error, fail, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { RBACR_DEV_LOGIN } from '$app/env/private';
import { signIn } from '#lib/server/auth.js';
import { normalizeEmail } from '#lib/server/identity.js';
import { getServices } from '#lib/server/services.js';
import type { Actions, PageServerLoad } from './$types';

/**
 * Password-less sign-in for local development. `dev` is a build-time
 * constant, so this route is a 404 in every production build regardless of
 * RBACR_DEV_LOGIN.
 */
function ensureEnabled() {
	if (!dev || !RBACR_DEV_LOGIN) error(404, 'Not found');
}

export const load: PageServerLoad = () => ensureEnabled();

export const actions: Actions = {
	default: async ({ request, cookies }) => {
		ensureEnabled();
		const email = normalizeEmail(String((await request.formData()).get('email') ?? ''));
		if (!email) return fail(400, { error: 'Enter a valid e-mail address' });
		await signIn(await getServices(), cookies, email);
		redirect(303, '/me');
	}
};
