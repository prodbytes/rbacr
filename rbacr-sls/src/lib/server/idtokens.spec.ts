import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { GOOGLE_JWKS_URL, GoogleIdTokens, looksLikeJwt, parseAudiences } from './idtokens';

const AUD = 'web-client.apps.googleusercontent.com';
const NOW = Date.parse('2026-10-10T12:00:00Z');
const nowSeconds = NOW / 1000;

type KeyPair = { privateKey: CryptoKey; jwk: JsonWebKey & { kid: string } };

async function rsaKey(kid: string): Promise<KeyPair> {
	const pair = (await crypto.subtle.generateKey(
		{ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
		true,
		['sign', 'verify']
	)) as CryptoKeyPair;
	const { n, e, kty } = await crypto.subtle.exportKey('jwk', pair.publicKey);
	return { privateKey: pair.privateKey, jwk: { kty, n, e, kid, alg: 'RS256', use: 'sig' } };
}

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

async function sign(key: KeyPair, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
	const input = `${b64({ alg: 'RS256', kid: key.jwk.kid, typ: 'JWT', ...header })}.${b64(claims)}`;
	const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key.privateKey, new TextEncoder().encode(input));
	return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

const valid = (extra: Record<string, unknown> = {}) => ({
	iss: 'https://accounts.google.com',
	aud: AUD,
	azp: 'android-client.apps.googleusercontent.com',
	sub: '1234567890',
	email: 'Ana@Example.com',
	email_verified: true,
	iat: nowSeconds - 60,
	exp: nowSeconds + 3540,
	...extra
});

let k1: KeyPair;
let k2: KeyPair;
let other: KeyPair;
let published: KeyPair[];
let fetchFn: ReturnType<typeof vi.fn>;
let clock: number;
let verifier: GoogleIdTokens;

beforeAll(async () => {
	[k1, k2, other] = await Promise.all([rsaKey('k1'), rsaKey('k2'), rsaKey('k1')]);
});

beforeEach(() => {
	published = [k1];
	clock = NOW;
	fetchFn = vi.fn(async (url: string) => {
		expect(url).toBe(GOOGLE_JWKS_URL);
		return new Response(JSON.stringify({ keys: published.map((k) => k.jwk) }), {
			headers: { 'content-type': 'application/json', 'cache-control': 'public, max-age=3600, must-revalidate, no-transform' }
		});
	});
	verifier = new GoogleIdTokens([AUD, 'ios-client.apps.googleusercontent.com'], fetchFn as unknown as typeof fetch, () => clock);
});

describe('GoogleIdTokens.verify', () => {
	it("accepts a valid token and answers its lower-cased e-mail", async () => {
		expect(await verifier.verify(await sign(k1, valid()))).toBe('ana@example.com');
		expect(await verifier.verify(await sign(k1, valid({ iss: 'accounts.google.com' })))).toBe('ana@example.com');
		expect(await verifier.verify(await sign(k1, valid({ aud: 'ios-client.apps.googleusercontent.com' })))).toBe('ana@example.com');
	});

	it('refuses a bad signature', async () => {
		// Same kid, another key: what a forger without Google's key can do.
		expect(await verifier.verify(await sign(other, valid()))).toBeNull();
		const [h, , s] = (await sign(k1, valid())).split('.');
		expect(await verifier.verify(`${h}.${b64(valid({ email: 'root@corp.com' }))}.${s}`)).toBeNull();
	});

	it('refuses other algorithms, unsigned tokens and critical headers', async () => {
		const claims = b64(valid());
		expect(await verifier.verify(`${b64({ alg: 'none', kid: 'k1' })}.${claims}.`)).toBeNull();
		expect(await verifier.verify(`${b64({ alg: 'none', kid: 'k1' })}.${claims}.AA`)).toBeNull();
		expect(await verifier.verify(await sign(k1, valid(), { alg: 'HS256' }))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid(), { crit: ['exp'] }))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid(), { kid: 7 }))).toBeNull();
	});

	it('refuses another audience, or several', async () => {
		expect(await verifier.verify(await sign(k1, valid({ aud: 'someone-else.apps.googleusercontent.com' })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ aud: [AUD] })))).toBeNull();
	});

	it('refuses another issuer', async () => {
		expect(await verifier.verify(await sign(k1, valid({ iss: 'https://evil.example' })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ iss: undefined })))).toBeNull();
	});

	it('refuses expired tokens, allowing 60 s of clock skew', async () => {
		expect(await verifier.verify(await sign(k1, valid({ exp: nowSeconds - 30 })))).toBe('ana@example.com');
		expect(await verifier.verify(await sign(k1, valid({ exp: nowSeconds - 61 })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ exp: undefined })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ exp: String(nowSeconds + 60) })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ iat: nowSeconds + 120 })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ nbf: nowSeconds + 120 })))).toBeNull();
	});

	it('refuses unverified and missing e-mail addresses', async () => {
		expect(await verifier.verify(await sign(k1, valid({ email_verified: false })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ email_verified: undefined })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ email: undefined })))).toBeNull();
		expect(await verifier.verify(await sign(k1, valid({ email: 'not an address' })))).toBeNull();
	});

	it('refuses garbage without fetching keys', async () => {
		for (const token of ['', 'rbacr_abc', 'a.b', 'a.b.c', `${'a'.repeat(5000)}.b.c`, '!!.??.**']) {
			expect(await verifier.verify(token)).toBeNull();
		}
		expect(fetchFn).not.toHaveBeenCalled();
	});
});

describe('Google key cache', () => {
	it('keeps keys for their max-age, then refetches', async () => {
		const token = await sign(k1, valid({ exp: nowSeconds + 3 * 3600 }));
		await verifier.verify(token);
		clock += 3599_000;
		await verifier.verify(token);
		expect(fetchFn).toHaveBeenCalledTimes(1);
		clock += 2_000;
		expect(await verifier.verify(token)).toBe('ana@example.com');
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('refetches on an unknown kid (Google rotated its keys), at most once a minute', async () => {
		expect(await verifier.verify(await sign(k1, valid()))).toBe('ana@example.com');
		published = [k1, k2];
		clock += 61_000;
		expect(await verifier.verify(await sign(k2, valid()))).toBe('ana@example.com');
		expect(fetchFn).toHaveBeenCalledTimes(2);
		// A made-up kid right after: no new fetch.
		expect(await verifier.verify(await sign(k2, valid(), { kid: 'made-up' }))).toBeNull();
		expect(fetchFn).toHaveBeenCalledTimes(2);
	});

	it('shares one fetch between concurrent requests', async () => {
		const token = await sign(k1, valid());
		expect(await Promise.all([verifier.verify(token), verifier.verify(token), verifier.verify(token)])).toEqual(
			Array(3).fill('ana@example.com')
		);
		expect(fetchFn).toHaveBeenCalledTimes(1);
	});

	it("throws when Google's keys can't be fetched, and keeps stale ones when it has some", async () => {
		const token = await sign(k1, valid({ exp: nowSeconds + 3 * 3600 }));
		fetchFn.mockResolvedValueOnce(new Response('nope', { status: 500 }));
		await expect(verifier.verify(token)).rejects.toThrow(/500/);
		expect(await verifier.verify(token)).toBe('ana@example.com');
		clock += 2 * 3600_000;
		fetchFn.mockRejectedValueOnce(new Error('offline'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(await verifier.verify(token)).toBe('ana@example.com');
		expect(log).toHaveBeenCalled();
		expect(String(log.mock.calls[0])).not.toContain(token);
		log.mockRestore();
	});
});

describe('parseAudiences and looksLikeJwt', () => {
	it('parses comma-separated client ids and refuses junk', () => {
		expect(parseAudiences(undefined)).toEqual([]);
		expect(parseAudiences('')).toEqual([]);
		expect(parseAudiences(' a-1.apps.googleusercontent.com, b.apps.googleusercontent.com ,a-1.apps.googleusercontent.com')).toEqual([
			'a-1.apps.googleusercontent.com',
			'b.apps.googleusercontent.com'
		]);
		expect(() => parseAudiences('ok.apps.googleusercontent.com,bad/id')).toThrow(/bad\/id/);
		expect(() => new GoogleIdTokens([])).toThrow();
	});

	it('tells JWTs from personal tokens', () => {
		expect(looksLikeJwt('eyJh.eyJi.c2ln')).toBe(true);
		expect(looksLikeJwt('rbacr_abc')).toBe(false);
	});
});
