import { error, redirect } from '@sveltejs/kit';
import { dev } from '$app/env';
import { OAUTH_COOKIE } from '#lib/server/auth.js';
import { authorizationUrl, randomString } from '#lib/server/google.js';
import { googleCredentials, googleRedirectUri } from '#lib/server/services.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const creds = googleCredentials();
	if (!creds) error(503, 'Google sign-in is not configured (RBACR_GOOGLE_CLIENT_ID / RBACR_GOOGLE_CLIENT_SECRET)');
	const state = randomString();
	const verifier = randomString();
	cookies.set(OAUTH_COOKIE, `${state}.${verifier}`, {
		path: '/login/google',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		maxAge: 600
	});
	const redirectUri = googleRedirectUri(url);
	redirect(302, await authorizationUrl({ ...creds, redirectUri }, state, verifier), {
		external: ['https://accounts.google.com']
	});
};
