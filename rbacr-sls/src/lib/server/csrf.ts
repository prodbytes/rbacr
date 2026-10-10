/**
 * Cross-site request forgery check (SPEC H2), in place of SvelteKit's own,
 * which is turned off (vite.config.ts) because it can't spare /api: it
 * refused every body-less DELETE from API clients, which send no Origin.
 * /api is exempt here: it takes bearer tokens only, never the session
 * cookie, so a forged browser request carries nothing to abuse.
 *
 * Everything else gets SvelteKit's rule: a form-like write (POST, PUT,
 * PATCH or DELETE with a form or plain-text body, or no content type, which
 * a browser can send cross-site without a preflight) must come from one of
 * rbacr's own origins.
 */

const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const FORM_TYPES = new Set([
	'application/x-www-form-urlencoded',
	'multipart/form-data',
	'text/plain',
	'application/x-sveltekit-formdata'
]);

/** Whether the request is a cross-site form submission to refuse. */
export function isCrossSiteForm(request: Request, path: string, ownOrigins: string[]): boolean {
	if (path === '/api' || path.startsWith('/api/')) return false;
	if (!WRITES.has(request.method)) return false;
	const type = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
	if (type && !FORM_TYPES.has(type)) return false;
	const origin = request.headers.get('origin');
	return origin === null || !ownOrigins.includes(origin);
}
