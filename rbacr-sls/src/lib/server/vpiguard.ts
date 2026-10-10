/**
 * /vpi, the VPI (view programming interface), is the frontend's own API. A request is accepted only when it comes
 * from rbacr's pages:
 *   - SvelteKit's internal server-side fetch while rendering a page
 *     (event.isSubRequest: no HTTP involved), or
 *   - a browser fetch from one of rbacr's own pages: the custom header
 *     `x-rbacr-vpi: 1` (which no other origin can send without a CORS
 *     preflight, and rbacr never answers preflights), `Sec-Fetch-Site:
 *     same-origin` (set by the browser, unforgeable from page scripts), and,
 *     when present (always for writes), an `Origin` that is rbacr's own.
 * Combined with the HttpOnly session cookie this rejects other sites, scripts
 * in other origins and plain API clients. A non-browser client that copies a
 * user's session cookie and fakes these headers can't be told apart; that's
 * why /api never accepts the session cookie.
 */

export const VPI_HEADER = 'x-rbacr-vpi';

/** Why the request isn't from the frontend, or null when it is. */
export function rejectNonFrontend(request: Request, isSubRequest: boolean, ownOrigins: string[]): string | null {
	if (isSubRequest) return null;
	const headers = request.headers;
	if (headers.get(VPI_HEADER) !== '1') return 'missing frontend header';
	if (headers.get('sec-fetch-site') !== 'same-origin') return 'not a same-origin browser request';
	const origin = headers.get('origin');
	const write = !['GET', 'HEAD'].includes(request.method);
	if (origin === null ? write : !ownOrigins.includes(origin)) return 'foreign or missing origin';
	return null;
}
