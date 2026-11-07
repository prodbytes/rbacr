import { TOKEN_PREFIX } from './tokens';

/** How a request said who it is (H7): never the token, the cookie or the address itself. */
export type Credential = 'token' | 'id-token' | 'session' | 'none';

export interface AccessEntry {
	method: string;
	/** The route's pattern (`/redeem/[code]`), never the path: paths can hold voucher codes. Null: no route. */
	route: string | null;
	status: number;
	ms: number;
	/** The viewer's IP (CloudFront's `x-rbacr-viewer-ip`), null when unknown. */
	ip: string | null;
	userAgent: string | null;
	/** The `Origin` header (a web app calling /api from the browser, H3), null when absent. */
	origin: string | null;
	/** The `Referer` header's origin (scheme and host only: its path can hold a voucher code), null when absent or not a URL. */
	referer: string | null;
	credential: Credential;
}

/** The longest user agent or origin kept, so a client can't fill the log. */
const MAX_HEADER = 160;

/** How the request authenticates, from its headers and cookie, without reading either's value. */
export function credentialOf(request: Request, hasSession: boolean): Credential {
	const [scheme, bearer] = (request.headers.get('authorization') ?? '').trim().split(/\s+/);
	if (scheme?.toLowerCase() === 'bearer' && bearer) return bearer.startsWith(TOKEN_PREFIX) ? 'token' : 'id-token';
	return hasSession ? 'session' : 'none';
}

/** The `Referer` header's origin, never its path or query; null when absent or not an absolute URL. */
export function refererOrigin(referer: string | null): string | null {
	if (!referer) return null;
	try {
		const { origin } = new URL(referer);
		return origin === 'null' ? null : origin;
	} catch {
		return null;
	}
}

/** One request's line in the function's log (H7): JSON, for CloudWatch Logs Insights. */
export function accessLine(entry: AccessEntry): string {
	const cut = (value: string | null) => (value ? value.slice(0, MAX_HEADER) : null);
	return JSON.stringify({ msg: 'request', ...entry, userAgent: cut(entry.userAgent), origin: cut(entry.origin), referer: cut(entry.referer) });
}
