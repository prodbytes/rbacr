import { describe, expect, it, vi } from 'vitest';
import { authorizationUrl, codeChallenge, fetchVerifiedEmail } from './google';

const config = { clientId: 'cid', clientSecret: 'secret', redirectUri: 'https://app.test/login/google/callback' };

describe('authorizationUrl', () => {
	it('requests the e-mail scope with state and a PKCE S256 challenge', async () => {
		const url = await authorizationUrl(config, 'st', 'verifier');
		expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
		const p = url.searchParams;
		expect(p.get('client_id')).toBe('cid');
		expect(p.get('redirect_uri')).toBe(config.redirectUri);
		expect(p.get('scope')).toBe('openid email');
		expect(p.get('state')).toBe('st');
		expect(p.get('code_challenge_method')).toBe('S256');
		expect(p.get('code_challenge')).toBe(await codeChallenge('verifier'));
		expect(p.has('client_secret')).toBe(false);
	});
});

function fakeGoogle(userinfo: object, tokenStatus = 200) {
	return vi.fn(async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes('/token')) {
			return new Response(JSON.stringify({ access_token: 'at' }), { status: tokenStatus });
		}
		return new Response(JSON.stringify(userinfo));
	}) as unknown as typeof fetch & ReturnType<typeof vi.fn>;
}

describe('fetchVerifiedEmail', () => {
	it('exchanges the code with the verifier and returns the lower-cased e-mail', async () => {
		const f = fakeGoogle({ email: 'Ana@Example.com', email_verified: true });
		expect(await fetchVerifiedEmail(config, 'code', 'ver', f)).toBe('ana@example.com');
		const body = new URLSearchParams(String(f.mock.calls[0][1]?.body));
		expect(body.get('code')).toBe('code');
		expect(body.get('code_verifier')).toBe('ver');
		expect(f.mock.calls[1][1]?.headers).toEqual({ authorization: 'Bearer at' });
	});

	it('rejects unverified e-mails', async () => {
		const f = fakeGoogle({ email: 'ana@example.com', email_verified: false });
		await expect(fetchVerifiedEmail(config, 'c', 'v', f)).rejects.toThrow(/verified/);
	});

	it('fails when the token exchange fails', async () => {
		const f = fakeGoogle({}, 400);
		await expect(fetchVerifiedEmail(config, 'c', 'v', f)).rejects.toThrow(/token exchange/);
	});
});
