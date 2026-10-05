import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/env';
import { SESSION_COOKIE, type Sessions } from './session';

/** Holds `<state>.<pkce verifier>` between the Google redirect and the callback. */
export const OAUTH_COOKIE = 'rbacr_oauth';

/** Starts a session for `email` and sets the session cookie. */
export async function signIn(sessions: Sessions, cookies: Cookies, email: string): Promise<void> {
	const { token, expiresAt } = await sessions.create(email);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		expires: expiresAt
	});
}
