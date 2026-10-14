import { normalizeEmail } from './identity';

/**
 * ID tokens of applications' users (SPEC I1-I9): an app that signs its users
 * in with Google, or with its own OIDC issuer trusted by RBACR_TRUSTED_ISSUERS,
 * sends their ID token as `Authorization: Bearer <JWT>` on the self-service
 * /api routes (I4). rbacr accepts it only when the issuer signed it (RS256, a
 * key from that issuer's JWKS), it was issued to one of that issuer's trusted
 * audiences, it hasn't expired and its e-mail address is verified. The
 * unverified `iss` only chooses which issuer's checks run; a token naming an
 * issuer that isn't configured is refused. Implemented on WebCrypto, with no
 * dependency. Tokens are never logged.
 */

export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
/** The `iss` values Google writes; never a trusted issuer's (I7). */
export const GOOGLE_ISSUERS: readonly string[] = ['accounts.google.com', 'https://accounts.google.com'];
/** Clock skew allowed on `exp`, `iat` and `nbf`, in seconds. */
export const CLOCK_SKEW_SECONDS = 60;
/** Longer bearer values are refused unparsed. Google's ID tokens are ~1 KB. */
const MAX_TOKEN_LENGTH = 4096;
/** How long keys are kept when the JWKS response has no usable max-age. */
const DEFAULT_KEYS_TTL_MS = 60 * 60 * 1000;
/** Upper bound on a max-age, so a bad header can't pin old keys for long. */
const MAX_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often (a forged kid can't make rbacr hammer the issuer). */
const MIN_REFETCH_INTERVAL_MS = 60 * 1000;
/** How long a JWKS fetch may take, so a hanging issuer can't hold requests until the Lambda times out. */
const FETCH_TIMEOUT_MS = 3000;

/** A client id as Google writes them, e.g. 1234-abc.apps.googleusercontent.com. */
const AUDIENCE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A trusted issuer's `iss` or audience: printable ASCII, no spaces. */
const TOKEN_STRING_RE = /^[\x21-\x7e]{1,512}$/;

/** Parses RBACR_GOOGLE_AUDIENCES, a comma-separated list of OAuth client ids; throws on an invalid entry. */
export function parseAudiences(raw: string | undefined): string[] {
	const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
	const invalid = entries.filter((a) => !AUDIENCE_RE.test(a));
	if (invalid.length) throw new Error(`invalid Google client id(s): ${invalid.join(', ')}`);
	return [...new Set(entries)];
}

/** An OIDC issuer rbacr trusts besides Google (I7). */
export interface TrustedIssuer {
	/** The exact `iss` its tokens carry. */
	issuer: string;
	/** Its JWKS, an https URL. */
	jwks: string;
	/** The `aud` values accepted from it. */
	audiences: string[];
	/** The only systems its tokens reach (I10); undefined: every system. */
	systems?: string[];
}

/** A verified ID token's identity, and the systems its issuer is limited to (I10; null: none). */
export interface AppIdentity {
	email: string;
	systems: readonly string[] | null;
}

/** A system id, as rbacr's catalog writes them. */
const SYSTEM_ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,62}$/;

/**
 * Parses RBACR_TRUSTED_ISSUERS (I7), a JSON array of
 * `{"issuer", "jwks", "audiences"}`; empty or unset is none. Throws on
 * anything else, so a bad value stops the app from starting.
 */
export function parseTrustedIssuers(raw: string | undefined): TrustedIssuer[] {
	if (!raw?.trim()) return [];
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error('must be a JSON array of {"issuer", "jwks", "audiences"} objects');
	}
	if (!Array.isArray(value)) throw new Error('must be a JSON array of {"issuer", "jwks", "audiences"} objects');
	const seen = new Set<string>();
	return value.map((entry, i) => {
		const where = `trusted issuer #${i + 1}`;
		if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where} must be an object`);
		const extra = Object.keys(entry).filter((k) => !['issuer', 'jwks', 'audiences', 'systems'].includes(k));
		if (extra.length) throw new Error(`${where} has unknown key(s): ${extra.join(', ')}`);
		const { issuer, jwks, audiences, systems } = entry as Record<string, unknown>;
		if (typeof issuer !== 'string' || !TOKEN_STRING_RE.test(issuer)) throw new Error(`${where}: issuer must be a non-empty string without spaces`);
		if (GOOGLE_ISSUERS.includes(issuer)) throw new Error(`${where}: ${issuer} is Google's issuer, configured by RBACR_GOOGLE_AUDIENCES`);
		if (seen.has(issuer)) throw new Error(`${where}: duplicate issuer ${issuer}`);
		seen.add(issuer);
		let url: URL;
		try {
			url = new URL(typeof jwks === 'string' ? jwks : '');
		} catch {
			throw new Error(`${where}: jwks must be an https URL`);
		}
		if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`${where}: jwks must be an https URL`);
		if (!Array.isArray(audiences) || !audiences.length) throw new Error(`${where}: audiences must be a non-empty array`);
		if (!audiences.every((a) => typeof a === 'string' && TOKEN_STRING_RE.test(a))) {
			throw new Error(`${where}: each audience must be a non-empty string without spaces`);
		}
		if (systems !== undefined && !(Array.isArray(systems) && systems.length && systems.every((s) => typeof s === 'string' && SYSTEM_ID_RE.test(s)))) {
			throw new Error(`${where}: systems must be a non-empty array of system ids`);
		}
		return {
			issuer,
			jwks: url.href,
			audiences: [...new Set(audiences as string[])],
			...(systems !== undefined && { systems: [...new Set(systems as string[])].sort() })
		};
	});
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

/** An issuer's RS256 signing keys, fetched from its JWKS and cached per process (I3). */
class JwksKeys {
	private keys = new Map<string, CryptoKey>();
	private keysExpireAt = 0;
	private lastFetchAt = -Infinity;
	private fetching: Promise<void> | null = null;

	constructor(
		private readonly url: string,
		/** Names the issuer in errors and logs. */
		private readonly label: string,
		private readonly fetchFn: typeof fetch,
		private readonly now: () => number
	) {}

	/** The key `kid`: from the cache while fresh; an unknown kid refetches (rate-limited). */
	async key(kid: string): Promise<CryptoKey | null> {
		const now = this.now();
		const stale = now >= this.keysExpireAt;
		if (stale || (!this.keys.has(kid) && now - this.lastFetchAt >= MIN_REFETCH_INTERVAL_MS)) {
			try {
				await this.refresh();
			} catch (err) {
				// Stale keys still verify tokens signed with them; with none, the caller learns rbacr can't check.
				if (!this.keys.size) throw err;
				console.error(`Refreshing ${this.label} ID token keys failed`, (err as Error).message);
				// Keep them a little longer rather than refetching on every request meanwhile.
				this.keysExpireAt = this.now() + MIN_REFETCH_INTERVAL_MS;
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
		const res = await this.fetchFn(this.url, {
			headers: { accept: 'application/json' },
			redirect: 'error',
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
		});
		if (!res.ok) throw new Error(`${this.label}'s ID token keys answered ${res.status}`);
		const body = (await res.json()) as { keys?: Jwk[] };
		if (!Array.isArray(body.keys)) throw new Error(`${this.label}'s ID token keys had no keys`);
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
		if (!keys.size) throw new Error(`${this.label}'s ID token keys had no usable RS256 key`);
		const ttl = Math.min(maxAge(res.headers.get('cache-control')) ?? DEFAULT_KEYS_TTL_MS, MAX_KEYS_TTL_MS);
		this.keys = keys;
		this.keysExpireAt = this.now() + ttl;
	}
}

/** Verifies one issuer's ID tokens (I2, I8): its JWKS, its `iss` values, its audiences. */
export class IdTokenVerifier {
	readonly issuers: ReadonlySet<string>;
	/** The only systems this issuer's tokens reach (I10); null: every system. */
	readonly systems: readonly string[] | null;
	private readonly audiences: ReadonlySet<string>;
	private readonly jwks: JwksKeys;

	constructor(
		config: { issuers: Iterable<string>; audiences: Iterable<string>; jwks: string; label: string; systems?: readonly string[] },
		fetchFn: typeof fetch = fetch,
		private readonly now: () => number = Date.now
	) {
		this.issuers = new Set(config.issuers);
		this.systems = config.systems ? [...config.systems] : null;
		this.audiences = new Set(config.audiences);
		if (!this.issuers.size) throw new Error(`${config.label} ID tokens need at least one issuer`);
		if (!this.audiences.size) throw new Error(`${config.label} ID tokens need at least one audience`);
		this.jwks = new JwksKeys(config.jwks, config.label, fetchFn, now);
	}

	/**
	 * The verified, lower-cased e-mail address of a valid ID token, or null for
	 * anything else (I2). Throws only when the issuer's keys can't be fetched.
	 */
	async verify(token: string): Promise<string | null> {
		if (!looksLikeJwt(token)) return null;
		const [h, p, s] = token.split('.');
		const header = decodeJson(h);
		const claims = decodeJson(p);
		if (!header || !claims) return null;
		if (header.alg !== 'RS256' || typeof header.kid !== 'string' || header.crit !== undefined) return null;
		// Before fetching keys: a token for another issuer never makes this one's JWKS be fetched.
		if (typeof claims.iss !== 'string' || !this.issuers.has(claims.iss)) return null;
		const key = await this.jwks.key(header.kid);
		if (!key) return null;
		const signature = Buffer.from(s, 'base64url');
		const signed = new TextEncoder().encode(`${h}.${p}`);
		if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signed))) return null;
		return this.emailOf(claims);
	}

	/** The claims checks (I2), after the signature. */
	private emailOf(claims: Record<string, unknown>): string | null {
		const nowSeconds = this.now() / 1000;
		if (typeof claims.iss !== 'string' || !this.issuers.has(claims.iss)) return null;
		if (typeof claims.aud !== 'string' || !this.audiences.has(claims.aud)) return null;
		if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) return null;
		if (claims.iat !== undefined && (typeof claims.iat !== 'number' || claims.iat - CLOCK_SKEW_SECONDS > nowSeconds)) return null;
		if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds)) return null;
		if (claims.email_verified !== true && claims.email_verified !== 'true') return null;
		if (typeof claims.email !== 'string') return null;
		return normalizeEmail(claims.email);
	}
}

/** Google's ID tokens (I1, I2): its JWKS and issuers, the RBACR_GOOGLE_AUDIENCES client ids. */
export class GoogleIdTokens extends IdTokenVerifier {
	constructor(audiences: Iterable<string>, fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
		super({ issuers: GOOGLE_ISSUERS, audiences, jwks: GOOGLE_JWKS_URL, label: 'Google' }, fetchFn, now);
	}
}

/** A trusted issuer's ID tokens (I7, I8). */
export function trustedIssuerTokens(issuer: TrustedIssuer, fetchFn: typeof fetch = fetch, now: () => number = Date.now) {
	return new IdTokenVerifier(
		{ issuers: [issuer.issuer], audiences: issuer.audiences, jwks: issuer.jwks, label: issuer.issuer, systems: issuer.systems },
		fetchFn,
		now
	);
}

/**
 * Every configured issuer's verifier, chosen by the token's unverified `iss`
 * (I8): the claim only picks which checks run, and the chosen verifier checks
 * it again after the signature. A token naming no configured issuer is refused
 * without fetching anything.
 */
export class IdTokens {
	private readonly byIssuer = new Map<string, IdTokenVerifier>();

	constructor(verifiers: Iterable<IdTokenVerifier>) {
		for (const verifier of verifiers) {
			for (const iss of verifier.issuers) {
				if (this.byIssuer.has(iss)) throw new Error(`issuer ${iss} is configured twice`);
				this.byIssuer.set(iss, verifier);
			}
		}
	}

	/** Whether any issuer is configured. */
	get size(): number {
		return this.byIssuer.size;
	}

	/** As IdTokenVerifier.verify, for whichever configured issuer the token names; null for any other. */
	async verify(token: string): Promise<string | null> {
		return (await this.verifyIdentity(token))?.email ?? null;
	}

	/** The verified identity, with the systems its issuer is limited to (I10), or null. */
	async verifyIdentity(token: string): Promise<AppIdentity | null> {
		if (!looksLikeJwt(token)) return null;
		const iss = decodeJson(token.split('.')[1])?.iss;
		const verifier = typeof iss === 'string' ? this.byIssuer.get(iss) : undefined;
		const email = verifier ? await verifier.verify(token) : null;
		return email && verifier ? { email, systems: verifier.systems } : null;
	}
}
