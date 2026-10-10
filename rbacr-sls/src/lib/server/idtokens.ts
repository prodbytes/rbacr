import { normalizeEmail } from './identity';

/**
 * Google ID tokens of applications' users (SPEC I1-I3): an app that signs its
 * users in with Google sends their ID token as `Authorization: Bearer <JWT>`
 * on the self-service /api routes (I4). rbacr accepts it only when Google
 * signed it (RS256, a key from Google's JWKS), it was issued to one of the
 * trusted OAuth clients (RBACR_GOOGLE_AUDIENCES), it hasn't expired and its
 * e-mail address is verified. Implemented on WebCrypto, with no dependency.
 * Tokens are never logged.
 */

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const ISSUERS = new Set(['accounts.google.com', 'https://accounts.google.com']);
/** Clock skew allowed on `exp`, `iat` and `nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;
/** Longer bearer values are refused unparsed. Google's ID tokens are ~1 KB. */
const MAX_TOKEN_LENGTH = 4096;
/** How long keys are kept when Google's response has no usable max-age. */
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
/** Upper bound on a max-age, so a bad header can't pin old keys for long. */
const MAX_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often (a forged kid can't make rbacr hammer Google). */
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;

/** A client id as Google writes them, e.g. 1234-abc.apps.googleusercontent.com. */
const AUDIENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Parses RBACR_GOOGLE_AUDIENCES, a comma-separated list of OAuth client ids; throws on an invalid entry. */
export function parseAudiences(raw: string | undefined): string[] {
	const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
	const invalid = entries.filter((a) => !AUDIENCE_RE.test(a));
	if (invalid.length) throw new Error(`invalid Google client id(s): ${invalid.join(', ')}`);
	return [...new Set(entries)];
}

/** Whether a bearer value has a JWT's shape (three base64url parts); `rbacr_` tokens never do. */
export function looksLikeJwt(bearer: string): boolean {
	return bearer.length <= MAX_TOKEN_LENGTH && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(bearer);
}

interface Jwk {
	kty?: string;
	kid?: string;
	alg?: string;
	use?: string;
	n?: string;
	e?: string;
}

function decodeJson(part: string): Record<string, unknown> | null {
	try {
		const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
		return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
	} catch {
		return null;
	}
}

/** max-age of a Cache-Control header, in ms, or null. */
function maxAge(header: string | null): number | null {
	const m = /(?:^|,)\s*max-age=(\d+)\s*(?:,|$)/i.exec(header ?? '');
	return m ? Number(m[1]) * 1000 : null;
}

export class GoogleIdTokens {
	private readonly audiences: ReadonlySet<string>;
	private keys = new Map<string, CryptoKey>();
	private keysExpireAt = 0;
	private lastFetchAt = -Infinity;
	private fetching: Promise<void> | null = null;

	constructor(
		audiences: Iterable<string>,
		private readonly fetchFn: typeof fetch = fetch,
		private readonly now: () => number = Date.now
	) {
		this.audiences = new Set(audiences);
		if (!this.audiences.size) throw new Error('GoogleIdTokens needs at least one audience');
	}

	/**
	 * The verified, lower-cased e-mail address of a valid ID token, or null for
	 * anything else (I2). Throws only when Google's keys can't be fetched.
	 */
	async verify(token: string): Promise<string | null> {
		if (!looksLikeJwt(token)) return null;
		const [h, p, s] = token.split('.');
		const header = decodeJson(h);
		const claims = decodeJson(p);
		if (!header || !claims) return null;
		if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) return null;
		const key = await this.key(header.kid);
		if (!key) return null;
		const signature = Buffer.from(s, 'base64url');
		const signed = new TextEncoder().encode(`${h}.${p}`);
		if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return null;
		return this.emailOf(claims);
	}

	/** The claims checks (I2), after the signature. */
	private emailOf(claims: Record<string, unknown>): string | null {
		const nowSeconds = this.now() / 1000;
		if (typeof claims.iss !== 'string' || !ISSUERS.has(claims.iss)) return null;
		if (typeof claims.aud !== 'string' || !this.audiences.has(claims.aud)) return null;
		if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return null;
		if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds)) return null;
		if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) return null;
		if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
		if (typeof claims.email !== 'string') return null;
		return normalizeEmail(claims.email);
	}

	/** Google's key `kid`: from the cache while fresh; an unknown kid refetches (rate-limited). */
	private async key(kid: string): Promise<CryptoKey | null> {
		const now = this.now();
		const stale = now >= this.keysExpireAt;
		if (stale || (!this.keys.has(kid) && now - this.lastFetchAt >= MIN_REFETCH_INTERVAL_MS)) {
			try {
				await this.refresh();
			} catch (err) {
				// Stale keys still verify tokens signed with them; with none, the caller learns rbacr can't check.
				if (!this.keys.size) throw err;
				console.error('Refreshing Google ID token keys failed', (err as Error).message);
			}
		}
		return this.keys.get(kid) ?? null;
	}

	/** One fetch at a time, shared by concurrent callers. */
	private refresh(): Promise<void> {
		this.fetching ??= this.load().finally(() => {
			this.fetching = null;
		});
		return this.fetching;
	}

	private async load(): Promise<void> {
		this.lastFetchAt = this.now();
		const res = await this.fetchFn(GOOGLE_JWKS_URL, { headers: { accept: 'application/json' } });
		if (!res.ok) throw new Error(`Google's ID token keys answered ${res.status}`);
		const body = (await res.json()) as { keys?: Jwk[] };
		if (!Array.isArray(body.keys)) throw new Error("Google's ID token keys had no keys");
		const keys = new Map<string, CryptoKey>();
		for (const jwk of body.keys) {
			if (jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || !jwk.n || !jwk.e) continue;
			if ((jwk.alg && jwk.alg !== 'RS256') || (jwk.use && jwk.use !== 'sig')) continue;
			try {
				const key = await crypto.subtle.importKey(
					'jwk',
					{ kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
					{ name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
					false,
					['verify']
				);
				keys.set(jwk.kid, key);
			} catch {
				// skip a key WebCrypto can't use
			}
		}
		if (!keys.size) throw new Error("Google's ID token keys had no usable RS256 key");
		const ttl = Math.min(maxAge(res.headers.get('cache-control')) ?? DEFAULT_KEYS_TTL_MS, MAX_KEYS_TTL_MS);
		this.keys = keys;
		this.keysExpireAt = this.now() + ttl;
	}
}
