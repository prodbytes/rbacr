/**
 * CORS for /api (SPEC H3, H4), so web apps whose origin is listed in
 * RBACR_CORS_ORIGINS can call the self-service routes (I4) from the browser
 * with their user's Google ID token. Origins match exactly; others get no
 * CORS headers, so the browser keeps blocking them. No credentials: /api
 * takes bearer tokens only (A1), never cookies. /vpi never gets CORS (A3).
 */

const ALLOW_METHODS = 'GET, POST';
const ALLOW_HEADERS = 'Authorization, Content-Type';
/** Seconds a browser may cache a preflight answer. */
export const PREFLIGHT_MAX_AGE = 600;

/** Parses RBACR_CORS_ORIGINS, comma-separated bare http(s) origins; throws on an invalid entry. */
export function parseCorsOrigins(raw: string | undefined): string[] {
	const entries = (raw ?? '').split(/[\s,]+/).filter(Boolean);
	for (const entry of entries) {
		let url: URL;
		try {
			url = new URL(entry);
		} catch {
			throw new Error(`invalid CORS origin "${entry}"`);
		}
		if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.origin !== entry) {
			throw new Error(`a CORS origin must be a bare origin like https://app.example.com (got ${entry})`);
		}
	}
	return [...new Set(entries)];
}

/** The request's Origin when it is one of `allowed`, else null. */
export function allowedOrigin(request: Request, allowed: readonly string[]): string | null {
	const origin = request.headers.get('origin');
	return origin !== null && allowed.includes(origin) ? origin : null;
}

/** Adds the CORS response headers for `origin` (or only `Vary: Origin` when none is allowed). */
export function addCorsHeaders(headers: Headers, origin: string | null): void {
	headers.append('vary', 'Origin');
	if (!origin) return;
	headers.set('access-control-allow-origin', origin);
	headers.set('access-control-expose-headers', 'WWW-Authenticate');
}

/** Whether the request is a CORS preflight (an OPTIONS with Access-Control-Request-Method). */
export function isPreflight(request: Request): boolean {
	return request.method === 'OPTIONS' && request.headers.has('access-control-request-method');
}

/**
 * The answer to a preflight: 204 with the allow headers when the origin is
 * allowed and `routeAllows(method)` says the requested method may be sent to
 * this path; otherwise 403 without CORS headers, so the browser refuses.
 */
export function preflight(request: Request, origin: string | null, routeAllows: (method: string) => boolean): Response {
	const method = request.headers.get('access-control-request-method') ?? '';
	const headers = new Headers({ 'cache-control': 'no-store' });
	if (!origin || !routeAllows(method)) {
		headers.set('vary', 'Origin');
		return new Response(null, { status: 403, headers });
	}
	addCorsHeaders(headers, origin);
	headers.set('access-control-allow-methods', ALLOW_METHODS);
	headers.set('access-control-allow-headers', ALLOW_HEADERS);
	headers.set('access-control-max-age', String(PREFLIGHT_MAX_AGE));
	return new Response(null, { status: 204, headers });
}
