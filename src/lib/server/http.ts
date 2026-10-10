import { json, type RequestEvent } from '@sveltejs/kit';
import { RbacError, type Actor, type GrantWithImplied, type Validity, type Voucher } from './rbac';
import { getServices, type Services } from './services';
import type { ApiToken } from './tokens';

export type Ctx = Services & { actor: Actor };

async function run(ctx: Ctx, fn: (ctx: Ctx) => Promise<unknown>): Promise<Response> {
	try {
		const result = await fn(ctx);
		if (result instanceof Response) return result;
		return result === undefined ? new Response(null, { status: 204 }) : json(result);
	} catch (err) {
		if (err instanceof RbacError) return json({ error: err.message, ...err.details }, { status: err.status });
		throw err;
	}
}

/**
 * The external API (/api): authenticated only by a personal API token,
 * `Authorization: Bearer rbacr_…`, acting as the person who created it.
 * hooks.server.ts has already checked the token (and refused the request
 * without a valid one); session cookies never count here.
 */
export async function api(event: RequestEvent, fn: (ctx: Ctx) => Promise<unknown>): Promise<Response> {
	const email = event.url.pathname.startsWith('/api/') ? event.locals.email : null;
	if (!email) {
		return json({ error: 'A valid API token is required' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
	}
	const services = await getServices();
	return run({ ...services, actor: await services.rbac.actor(email) }, fn);
}

/**
 * The VPI (/vpi, view programming interface), the frontend's own API:
 * authenticated only by the browser session cookie. hooks.server.ts has
 * already refused anything not coming from the frontend itself.
 */
export async function vpi(event: RequestEvent, fn: (ctx: Ctx) => Promise<unknown>): Promise<Response> {
	if (!event.locals.email) return json({ error: 'Not signed in' }, { status: 401 });
	const services = await getServices();
	return run({ ...services, actor: await services.rbac.actor(event.locals.email) }, fn);
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
	try {
		const body = await request.json();
		if (body && typeof body === 'object' && !Array.isArray(body)) return body;
	} catch {
		// fall through
	}
	throw new RbacError(400, 'Expected a JSON object body');
}

export function str(value: unknown, field: string): string {
	if (typeof value !== 'string' || !value.trim()) throw new RbacError(400, `"${field}" is required`);
	return value.trim();
}

/** Optional string; blank or missing means null. */
export function optStr(value: unknown, field: string): string | null {
	if (value === undefined || value === null || value === '') return null;
	if (typeof value !== 'string') throw new RbacError(400, `"${field}" must be a string`);
	return value.trim() || null;
}

export function strList(value: unknown, field: string): string[] {
	if (!(Array.isArray(value) && value.every((v) => typeof v === 'string'))) {
		throw new RbacError(400, `"${field}" must be an array of strings`);
	}
	return value;
}

/** Optional ISO date; blank or missing means "no limit". */
export function optDate(value: unknown, field: string): Date | null {
	if (value === undefined || value === null || value === '') return null;
	const date = new Date(String(value));
	if (Number.isNaN(date.getTime())) throw new RbacError(400, `"${field}" is not a valid date`);
	return date;
}

/** Optional positive integer; blank or missing means "unlimited". */
export function optInt(value: unknown, field: string): number | null {
	if (value === undefined || value === null || value === '') return null;
	const n = Number(value);
	if (!Number.isInteger(n)) throw new RbacError(400, `"${field}" must be an integer`);
	return n;
}

/** A grant's optional `startsAt` and `endsAt` (G1); blank or missing means immediately and forever. */
export function validity(body: Record<string, unknown>): Validity {
	return { startsAt: optDate(body.startsAt, 'startsAt'), endsAt: optDate(body.endsAt, 'endsAt') };
}

export const grantJson = (g: GrantWithImplied) => ({
	...g,
	grantedAt: g.grantedAt.toISOString(),
	startsAt: g.startsAt?.toISOString() ?? null,
	endsAt: g.endsAt?.toISOString() ?? null
});

export const voucherJson = (v: Voucher, status: string) => ({
	...v,
	status,
	startsAt: v.startsAt?.toISOString() ?? null,
	endsAt: v.endsAt?.toISOString() ?? null,
	createdAt: v.createdAt.toISOString(),
	disabledAt: v.disabledAt?.toISOString() ?? null
});

export const tokenJson = (t: ApiToken) => ({
	...t,
	createdAt: t.createdAt.toISOString(),
	expiresAt: t.expiresAt?.toISOString() ?? null,
	lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
	revokedAt: t.revokedAt?.toISOString() ?? null
});
