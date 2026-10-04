import { timingSafeEqual } from 'node:crypto';
import type { Handle } from '@sveltejs/kit/hooks';
import { RBACR_ORIGIN_SECRET, RBACR_PUBLIC_ORIGIN } from '$app/env/private';
import { getServices } from '#lib/server/services.js';
import { SESSION_COOKIE } from '#lib/server/session.js';
import { rejectNonFrontend } from '#lib/server/uxguard.js';

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
	const uxapi = path === '/uxapi' || path.startsWith('/uxapi/');
	if (uxapi) {
		const own = [event.url.origin, ...(RBACR_PUBLIC_ORIGIN ? [RBACR_PUBLIC_ORIGIN] : [])];
		const reason = rejectNonFrontend(event.request, event.isSubRequest, own);
		if (reason) {
			return Response.json({ error: `/uxapi is only for the rbacr frontend (${reason}); use /api with an API token` }, { status: 403 });
		}
	}
	event.locals.email = null;
	// The external API authenticates with API tokens only; never look at the session there.
	const token = path === '/api' || path.startsWith('/api/') ? undefined : event.cookies.get(SESSION_COOKIE);
	if (token) {
		const { sessions } = await getServices();
		event.locals.email = await sessions.validate(token);
		if (!event.locals.email) event.cookies.delete(SESSION_COOKIE, { path: '/' });
	}
	const response = await resolve(event);
	response.headers.set('x-content-type-options', 'nosniff');
	response.headers.set('referrer-policy', 'same-origin');
	response.headers.set('x-frame-options', 'DENY');
	if (uxapi) response.headers.set('cache-control', 'no-store');
	return response;
};
