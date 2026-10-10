import type { Cookies } from '@sveltejs/kit';
import { dev } from '$app/env';
import type { Services } from './services';
import { SESSION_COOKIE } from './session';

/** Holds `<state>.<pkce verifier>` between the Google redirect and the callback. */
export const OAUTH_COOKIE = 'rbacr_oauth';

/**
 * Starts a session for `email` and sets the session cookie. A root's
 * sign-in also runs the verification rules (N2); if they fail, the failure
 * is logged and the sign-in goes ahead.
 */
export async function signIn({ sessions, rbac }: Pick<Services, 'sessions' | 'rbac'>, cookies: Cookies, email: string): Promise<void> {
	const { token, expiresAt } = await sessions.create(email);
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: !dev,
		expires: expiresAt
	});
	if (!rbac.isRoot(email)) return;
	try {
		await rbac.verify(await rbac.actor(email));
	} catch (err) {
		console.error('Verification rules failed on sign-in', err);
	}
}
