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
	credential: Credential;
}

/** The longest user agent kept, so a client can't fill the log. */
const MAX_USER_AGENT = 160;

/** How the request authenticates, from its headers and cookie, without reading either's value. */
export function credentialOf(request: Request, hasSession: boolean): Credential {
	const [scheme, bearer] = (request.headers.get('authorization') ?? '').trim().split(/\s+/);
	if (scheme?.toLowerCase() === 'bearer' && bearer) return bearer.startsWith(TOKEN_PREFIX) ? 'token' : 'id-token';
	return hasSession ? 'session' : 'none';
}

/** One request's line in the function's log (H7): JSON, for CloudWatch Logs Insights. */
export function accessLine(entry: AccessEntry): string {
	const userAgent = entry.userAgent ? entry.userAgent.slice(0, MAX_USER_AGENT) : null;
	return JSON.stringify({ msg: 'request', ...entry, userAgent });
}
