import { error, redirect } from '@sveltejs/kit';
import { OAUTH_COOKIE, signIn } from '#lib/server/auth.js';
import { fetchVerifiedEmail } from '#lib/server/google.js';
import { getServices, googleCredentials, googleRedirectUri } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const creds = googleCredentials();
	if (!creds) error(503, 'Google sign-in is not configured');
	const [expectedState, verifier] = (cookies.get(OAUTH_COOKIE) ?? '').split('.');
	cookies.delete(OAUTH_COOKIE, { path: '/login/google' });
	const code = url.searchParams.get('code');
	if (!code || !expectedState || url.searchParams.get('state') !== expectedState) {
		error(400, 'Sign-in failed or expired, please try again');
	}
	let email: string;
	try {
		email = await fetchVerifiedEmail({ ...creds, redirectUri: googleRedirectUri(url) }, code, verifier);
	} catch (err) {
		console.error(err);
		error(401, 'Google sign-in failed');
	}
	await signIn((await getServices()).sessions, cookies, email);
	redirect(303, '/me');
};
