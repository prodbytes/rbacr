/**
 * Where to go after signing in (SPEC S5): a path on rbacr itself, carried
 * as `?next=` through the sign-in page and the Google round trip. Anything
 * that could leave the site (another origin, `//host`, `/\host`, a scheme)
 * falls back to the default, so the parameter can't be an open redirect.
 */

export const DEFAULT_NEXT = '/me';

/** Longest `next` kept; longer ones fall back to the default. */
const MAX_NEXT_LENGTH = 512;

export function safeNext(raw: string | null | undefined): string {
	if (!raw || raw.length > MAX_NEXT_LENGTH) return DEFAULT_NEXT;
	// One leading slash, then no slash or backslash: a path, never "//host" or "/\host".
	if (!/^\/(?![/\\])/.test(raw)) return DEFAULT_NEXT;
	// No backslashes or control characters anywhere: browsers rewrite them unpredictably.
	if (/[\\\u0000-\u001f\u007f]/.test(raw)) return DEFAULT_NEXT;
	// What a browser would make of it must still be on this site.
	const base = 'https://rbacr.invalid';
	const url = new URL(raw, base);
	return url.origin === base ? url.pathname + url.search + url.hash : DEFAULT_NEXT;
}

/** The redeem page's path for a voucher code (V8). */
export const redeemPath = (code: string) => `/redeem/${encodeURIComponent(code)}`;
