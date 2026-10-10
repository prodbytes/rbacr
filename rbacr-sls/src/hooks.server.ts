import { timingSafeEqual } from 'node:crypto';
import type { Handle } from '@sveltejs/kit/hooks';
import { dev } from '$app/env';
import { RBACR_ORIGIN_SECRET, RBACR_PUBLIC_ORIGIN } from '$app/env/private';
import { addCorsHeaders, allowedOrigin, isPreflight, preflight } from '#lib/server/cors.js';
import { isCrossSiteForm } from '#lib/server/csrf.js';
import { looksLikeJwt } from '#lib/server/idtokens.js';
import { appMayCall } from '#lib/server/rbac.js';
import { corsOrigins, getServices, googleIdTokens } from '#lib/server/services.js';
import { SESSION_COOKIE } from '#lib/server/session.js';
import { TOKEN_PREFIX } from '#lib/server/tokens.js';
import { rejectNonFrontend } from '#lib/server/vpiguard.js';

const ORIGIN_SECRET_HEADER = 'x-rbacr-origin-secret';

function fromOrigin(request: Request): boolean {
	if (!RBACR_ORIGIN_SECRET) return true;
	const given = Buffer.from(request.headers.get(ORIGIN_SECRET_HEADER) ?? '');
	const expected = Buffer.from(RBACR_ORIGIN_SECRET);
	return given.length === expected.length && timingSafeEqual(given, expected);
}

export const handle: Handle = async ({ event, resolve }) => {
	// Behind CloudFront, requests that skip it (straight to the Lambda URL) are
	// refused. Sub-requests are SvelteKit's in-process fetches while rendering a
	// page that already passed this check.
	if (!event.isSubRequest && !fromOrigin(event.request)) return new Response('Forbidden', { status: 403 });
	const path = event.url.pathname;
	const own = [event.url.origin, ...(RBACR_PUBLIC_ORIGIN ? [RBACR_PUBLIC_ORIGIN] : [])];
	// H2, in production builds only, like the SvelteKit check it replaces.
	if (!dev && !event.isSubRequest && isCrossSiteForm(event.request, path, own)) {
		return new Response(`Cross-site ${event.request.method} form submissions are forbidden`, { status: 403 });
	}
	const vpi = path === '/vpi' || path.startsWith('/vpi/');
	if (vpi) {
		const reason = rejectNonFrontend(event.request, event.isSubRequest, own);
		if (reason) {
			return Response.json({ error: `/vpi is only for the rbacr frontend (${reason}); use /api with an API token` }, { status: 403 });
		}
	}
	event.locals.email = null;
	event.locals.app = false;
	const api = path === '/api' || path.startsWith('/api/');
	// H3: CORS on /api for the listed web origins only; /vpi never gets it (A3).
	const cors = api ? corsOrigins() : [];
	const origin = cors.length ? allowedOrigin(event.request, cors) : null;
	const withCors = (response: Response) => {
		if (cors.length) addCorsHeaders(response.headers, origin);
		return response;
	};
	if (api) {
		// H4: preflights are answered for the self-service routes (I4) only.
		if (cors.length && isPreflight(event.request)) return preflight(event.request, origin, (method) => appMayCall(method, path));
		// The external API takes personal API tokens (T3) and, when configured,
		// apps' Google ID tokens (I1-I3), never the session; it refuses
		// everything else before routing, unknown paths included.
		const [scheme, bearer] = (event.request.headers.get('authorization') ?? '').trim().split(/\s+/);
		if (scheme?.toLowerCase() === 'bearer' && bearer) {
			const idTokens = bearer.startsWith(TOKEN_PREFIX) ? null : googleIdTokens();
			if (idTokens && looksLikeJwt(bearer)) {
				try {
					event.locals.email = await idTokens.verify(bearer);
				} catch (err) {
					console.error("Can't check Google ID tokens:", (err as Error).message);
					return withCors(
						Response.json({ error: "rbacr can't check Google ID tokens right now" }, { status: 503, headers: { 'cache-control': 'no-store' } })
					);
				}
				event.locals.app = event.locals.email !== null;
			} else {
				const { tokens } = await getServices();
				event.locals.email = await tokens.authenticate(bearer);
			}
		}
		if (!event.locals.email) {
			return withCors(
				Response.json(
					{ error: 'A valid API token is required' },
					{ status: 401, headers: { 'www-authenticate': 'Bearer', 'cache-control': 'no-store' } }
				)
			);
		}
		// I4, I5: an ID token reaches the self-service routes only, whoever it names.
		if (event.locals.app && !appMayCall(event.request.method, path)) {
			return withCors(
				Response.json(
					{ error: "A Google ID token only reaches rbacr's self-service routes; use a personal API token" },
					{ status: 403, headers: { 'cache-control': 'no-store' } }
				)
			);
		}
	}
	const token = api ? undefined : event.cookies.get(SESSION_COOKIE);
	if (token) {
		const { sessions } = await getServices();
		event.locals.email = await sessions.validate(token);
		if (!event.locals.email) event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}
	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	if (vpi || api) response.headers.set('cache-control', 'no-store');
	return api ? withCors(response) : response;
};
