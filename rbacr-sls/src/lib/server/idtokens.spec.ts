import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	GOOGLE_JWKS_URL,
	GoogleIdTokens,
	IdTokens,
	looksLikeJwt,
	parseAudiences,
	parseTrustedIssuers,
	trustedIssuerTokens
} from './idtokens';

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

	it('backs off for a minute after a failed refresh, and bounds each fetch with a timeout', async () => {
		const token = await sign(k1, valid({ exp: nowSeconds + 3 * 3600 }));
		expect(await verifier.verify(token)).toBe('ana@example.com');
		expect(fetchFn.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
		const fetches = fetchFn.mock.calls.length;
		clock += 2 * 3600_000;
		fetchFn.mockRejectedValue(new Error('offline'));
		const log = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (let i = 0; i < 5; i++) expect(await verifier.verify(token)).toBe('ana@example.com');
		expect(fetchFn.mock.calls.length).toBe(fetches + 1);
		clock += 61_000;
		await verifier.verify(token);
		expect(fetchFn.mock.calls.length).toBe(fetches + 2);
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

// Trusted issuers (I7-I9): Presence's own session tokens, for example.
const ISS = 'https://presence.nu01.com/api/auth';
const ISS_JWKS = 'https://presence.nu01.com/api/auth/.well-known/jwks.json';
const RC_ISS = 'https://rc.presence.nu01.com/api/auth';
const RC_JWKS = 'https://rc.presence.nu01.com/api/auth/.well-known/jwks.json';

const session = (extra: Record<string, unknown> = {}) => ({
	iss: ISS,
	aud: 'presence',
	sub: 'user-1',
	email: 'Ana@Example.com',
	email_verified: true,
	iat: nowSeconds - 60,
	exp: nowSeconds + 840,
	...extra
});

describe('trusted issuers', () => {
	let issuerKeys: Record<string, KeyPair[]>;
	let issuerFetch: ReturnType<typeof vi.fn>;
	let tokens: IdTokens;

	beforeEach(() => {
		issuerKeys = { [GOOGLE_JWKS_URL]: [k1], [ISS_JWKS]: [k2], [RC_JWKS]: [other] };
		issuerFetch = vi.fn(async (url: string) => {
			const keys = issuerKeys[url];
			if (!keys) throw new Error(`unexpected fetch of ${url}`);
			return new Response(JSON.stringify({ keys: keys.map((k) => k.jwk) }), { headers: { 'cache-control': 'max-age=600' } });
		});
		const f = issuerFetch as unknown as typeof fetch;
		const issuers = parseTrustedIssuers(
			JSON.stringify([
				{ issuer: ISS, jwks: ISS_JWKS, audiences: ['presence'] },
				{ issuer: RC_ISS, jwks: RC_JWKS, audiences: ['presence', 'presence-web'] }
			])
		);
		tokens = new IdTokens([new GoogleIdTokens([AUD], f, () => clock), ...issuers.map((i) => trustedIssuerTokens(i, f, () => clock))]);
	});

	it('carries the systems an issuer is limited to with the identity (I10)', async () => {
		const f = issuerFetch as unknown as typeof fetch;
		const [limited] = parseTrustedIssuers(JSON.stringify([{ issuer: ISS, jwks: ISS_JWKS, audiences: ['presence'], systems: ['presence', 'presence'] }]));
		expect(limited.systems).toEqual(['presence']);
		const scoped = new IdTokens([new GoogleIdTokens([AUD], f, () => clock), trustedIssuerTokens(limited, f, () => clock)]);
		expect(await scoped.verifyIdentity(await sign(k2, session()))).toEqual({ email: 'ana@example.com', systems: ['presence'] });
		expect(await scoped.verifyIdentity(await sign(k1, valid()))).toEqual({ email: 'ana@example.com', systems: null });
		expect(await scoped.verifyIdentity(await sign(other, session()))).toBeNull();
	});

	it("accepts each issuer's tokens, signed by its own keys, as the lower-cased e-mail", async () => {
		expect(await tokens.verify(await sign(k2, session()))).toBe('ana@example.com');
		expect(await tokens.verify(await sign(other, session({ iss: RC_ISS, aud: 'presence-web' })))).toBe('ana@example.com');
		expect(await tokens.verify(await sign(k1, valid()))).toBe('ana@example.com'); // Google's, unchanged
		expect(issuerFetch.mock.calls.map(([url]) => url).sort()).toEqual([GOOGLE_JWKS_URL, ISS_JWKS, RC_JWKS].sort());
	});

	it("refuses a token signed with another issuer's key, or claiming another issuer", async () => {
		// Google's key (k1) signing an ISS token; ISS's key (k2) signing a Google token.
		expect(await tokens.verify(await sign(k1, session(), { kid: 'k2' }))).toBeNull();
		expect(await tokens.verify(await sign(k2, valid(), { kid: 'k1' }))).toBeNull();
		// The RC issuer's key, claiming the production issuer (same kid as Google's k1, too).
		expect(await tokens.verify(await sign(other, session()))).toBeNull();
	});

	it('refuses issuers that are not configured, without fetching', async () => {
		for (const iss of ['https://evil.example', `${ISS}/`, ISS.toUpperCase(), 'presence']) {
			expect(await tokens.verify(await sign(k2, session({ iss })))).toBeNull();
		}
		expect(await tokens.verify(await sign(k2, session({ iss: undefined })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ iss: [ISS] })))).toBeNull();
		expect(issuerFetch).not.toHaveBeenCalled();
	});

	it('refuses another audience, several, or one of another issuer', async () => {
		expect(await tokens.verify(await sign(k2, session({ aud: 'someone-else' })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ aud: ['presence'] })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ aud: ['presence', 'other'] })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ aud: 'presence-web' })))).toBeNull(); // RC's only
		expect(await tokens.verify(await sign(k2, session({ aud: AUD })))).toBeNull(); // Google's
	});

	it('refuses expired and future tokens, allowing 60 s of clock skew', async () => {
		expect(await tokens.verify(await sign(k2, session({ exp: nowSeconds - 30 })))).toBe('ana@example.com');
		expect(await tokens.verify(await sign(k2, session({ exp: nowSeconds - 61 })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ exp: undefined })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ iat: nowSeconds + 120 })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ nbf: nowSeconds + 120 })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ nbf: nowSeconds + 30 })))).toBe('ana@example.com');
	});

	it('refuses alg none, HS256 (with the public key as secret) and critical headers', async () => {
		const claims = b64(session());
		expect(await tokens.verify(`${b64({ alg: 'none', kid: 'k2' })}.${claims}.`)).toBeNull();
		expect(await tokens.verify(`${b64({ alg: 'none', kid: 'k2' })}.${claims}.AA`)).toBeNull();
		const input = `${b64({ alg: 'HS256', kid: 'k2' })}.${claims}`;
		const hmac = await crypto.subtle.importKey('raw', new TextEncoder().encode(JSON.stringify(k2.jwk)), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
		const mac = Buffer.from(await crypto.subtle.sign('HMAC', hmac, new TextEncoder().encode(input))).toString('base64url');
		expect(await tokens.verify(`${input}.${mac}`)).toBeNull();
		expect(await tokens.verify(await sign(k2, session(), { alg: 'HS256' }))).toBeNull();
		expect(await tokens.verify(await sign(k2, session(), { crit: ['exp'] }))).toBeNull();
		expect(await tokens.verify(await sign(k2, session(), { kid: undefined }))).toBeNull();
	});

	it("accepts email_verified true or \"true\" only, and needs a valid e-mail", async () => {
		expect(await tokens.verify(await sign(k2, session({ email_verified: 'true' })))).toBe('ana@example.com');
		for (const email_verified of [false, 'false', 'TRUE', 1, undefined]) {
			expect(await tokens.verify(await sign(k2, session({ email_verified })))).toBeNull();
		}
		expect(await tokens.verify(await sign(k2, session({ email: undefined })))).toBeNull();
		expect(await tokens.verify(await sign(k2, session({ email: 'not an address' })))).toBeNull();
	});

	it("refetches an issuer's keys on an unknown kid at most once a minute", async () => {
		expect(await tokens.verify(await sign(k2, session()))).toBe('ana@example.com');
		expect(issuerFetch).toHaveBeenCalledTimes(1);
		// A made-up kid right after: no new fetch.
		expect(await tokens.verify(await sign(k2, session(), { kid: 'made-up' }))).toBeNull();
		expect(issuerFetch).toHaveBeenCalledTimes(1);
		// The issuer rotates; a minute later its new kid fetches once.
		const rotated = { ...k1, jwk: { ...k1.jwk, kid: 'k3' } };
		issuerKeys[ISS_JWKS] = [k2, rotated];
		clock += 61_000;
		expect(await tokens.verify(await sign(rotated, session()))).toBe('ana@example.com');
		expect(await tokens.verify(await sign(k2, session(), { kid: 'made-up-2' }))).toBeNull();
		expect(issuerFetch).toHaveBeenCalledTimes(2);
		// Keys expire after their max-age (600 s), capped at a day.
		clock += 600_000;
		expect(await tokens.verify(await sign(k2, session({ exp: clock / 1000 + 600 })))).toBe('ana@example.com');
		expect(issuerFetch).toHaveBeenCalledTimes(3);
	});

	it("throws when an issuer's keys can't be fetched and none are cached", async () => {
		issuerFetch.mockResolvedValueOnce(new Response('nope', { status: 502 }));
		await expect(tokens.verify(await sign(k2, session()))).rejects.toThrow(/presence\.nu01\.com.*502/);
		expect(await tokens.verify(await sign(k2, session()))).toBe('ana@example.com');
	});

	it('refuses everything when only trusted issuers are configured and the token is Google\'s', async () => {
		const only = new IdTokens(parseTrustedIssuers(`[{"issuer":"${ISS}","jwks":"${ISS_JWKS}","audiences":["presence"]}]`).map((i) => trustedIssuerTokens(i, issuerFetch as unknown as typeof fetch, () => clock)));
		expect(await only.verify(await sign(k1, valid()))).toBeNull();
		expect(await only.verify(await sign(k2, session()))).toBe('ana@example.com');
	});
});

describe('parseTrustedIssuers', () => {
	const entry = { issuer: ISS, jwks: ISS_JWKS, audiences: ['presence'] };
	const parse = (value: unknown) => parseTrustedIssuers(JSON.stringify(value));

	it('takes an optional, non-empty list of system ids (I10)', () => {
		const base = { issuer: 'https://a.example/auth', jwks: 'https://a.example/jwks.json', audiences: ['a'] };
		expect(parseTrustedIssuers(JSON.stringify([base]))[0].systems).toBeUndefined();
		expect(parseTrustedIssuers(JSON.stringify([{ ...base, systems: ['tabscan', 'presence'] }]))[0].systems).toEqual(['presence', 'tabscan']);
		for (const systems of [[], 'presence', ['Presence'], ['a b'], [1]]) {
			expect(() => parseTrustedIssuers(JSON.stringify([{ ...base, systems }]))).toThrow(/systems/);
		}
	});

	it('parses the JSON list; empty or unset is none', () => {
		expect(parseTrustedIssuers(undefined)).toEqual([]);
		expect(parseTrustedIssuers('')).toEqual([]);
		expect(parseTrustedIssuers('  ')).toEqual([]);
		expect(parse([])).toEqual([]);
		expect(parse([entry, { issuer: RC_ISS, jwks: RC_JWKS, audiences: ['presence', 'presence'] }])).toEqual([
			entry,
			{ issuer: RC_ISS, jwks: RC_JWKS, audiences: ['presence'] }
		]);
	});

	it('refuses invalid configuration', () => {
		for (const raw of ['not json', '{"issuer":"x"}', '"x"', '[1]', '[null]', '[[]]']) {
			expect(() => parseTrustedIssuers(raw), raw).toThrow();
		}
		expect(() => parse([{ ...entry, jwks: 'http://presence.nu01.com/jwks.json' }])).toThrow(/https/);
		expect(() => parse([{ ...entry, jwks: 'https://user:pw@presence.nu01.com/jwks.json' }])).toThrow(/https/);
		expect(() => parse([{ ...entry, jwks: 'not a url' }])).toThrow(/https/);
		expect(() => parse([{ ...entry, jwks: undefined }])).toThrow(/https/);
		expect(() => parse([{ ...entry, audiences: [] }])).toThrow(/audiences/);
		expect(() => parse([{ ...entry, audiences: 'presence' }])).toThrow(/audiences/);
		expect(() => parse([{ ...entry, audiences: [''] }])).toThrow(/audience/);
		expect(() => parse([{ ...entry, audiences: [7] }])).toThrow(/audience/);
		expect(() => parse([{ ...entry, audiences: undefined }])).toThrow(/audiences/);
		expect(() => parse([entry, { ...entry, audiences: ['other'] }])).toThrow(/duplicate/);
		expect(() => parse([{ ...entry, issuer: 'https://accounts.google.com' }])).toThrow(/Google/);
		expect(() => parse([{ ...entry, issuer: 'accounts.google.com' }])).toThrow(/Google/);
		expect(() => parse([{ ...entry, issuer: '' }])).toThrow(/issuer/);
		expect(() => parse([{ ...entry, issuer: 'has space' }])).toThrow(/issuer/);
		expect(() => parse([{ ...entry, audience: ['presence'] }])).toThrow(/unknown key/);
	});
});
