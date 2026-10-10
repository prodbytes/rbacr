/**
 * Google sign-in via the OAuth 2.0 authorization code flow with PKCE.
 * The identity comes from Google's userinfo endpoint, called with the access
 * token we just received from Google over TLS, so no ID-token signature
 * verification is needed.
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const USERINFO_URL = 'https://openidconnect.googleapis.com/v1/userinfo';

export interface GoogleConfig {
	clientId: string;
	clientSecret: string;
	redirectUri: string;
}

export function randomString(bytes = 32): string {
	return Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString('base64url');
}

export async function codeChallenge(verifier: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
	return Buffer.from(digest).toString('base64url');
}

export async function authorizationUrl(config: GoogleConfig, state: string, verifier: string): Promise<URL> {
	const url = new URL(AUTH_URL);
	url.search = new URLSearchParams({
		client_id: config.clientId,
		redirect_uri: config.redirectUri,
		response_type: 'code',
		scope: 'openid email',
		state,
		code_challenge: await codeChallenge(verifier),
		code_challenge_method: 'S256',
		prompt: 'select_account'
	}).toString();
	return url;
}

/** Exchanges the authorization code and returns the verified, lower-cased e-mail. */
export async function fetchVerifiedEmail(
	config: GoogleConfig,
	code: string,
	verifier: string,
	fetchFn: typeof fetch = fetch
): Promise<string> {
	const tokenRes = await fetchFn(TOKEN_URL, {
		method: 'POST',
		headers: { 'content-type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams({
			client_id: config.clientId,
			client_secret: config.clientSecret,
			code,
			code_verifier: verifier,
			grant_type: 'authorization_code',
			redirect_uri: config.redirectUri
		})
	});
	if (!tokenRes.ok) throw new Error(`Google token exchange failed (${tokenRes.status})`);
	const { access_token } = (await tokenRes.json()) as { access_token?: string };
	if (!access_token) throw new Error('Google token response had no access token');

	const infoRes = await fetchFn(USERINFO_URL, { headers: { authorization: `Bearer ${access_token}` } });
	if (!infoRes.ok) throw new Error(`Google userinfo request failed (${infoRes.status})`);
	const info = (await infoRes.json()) as { email?: string; email_verified?: boolean };
	if (!info.email || info.email_verified !== true) {
		throw new Error('Google account has no verified e-mail address');
	}
	return info.email.toLowerCase();
}
