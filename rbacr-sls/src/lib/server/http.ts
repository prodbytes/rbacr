import { json, type RequestEvent } from '@sveltejs/kit';
import { RbacError, appMayCall, type Actor, type GrantWithImplied, type Notification, type OwnRedemption, type RedeemEvent, type RedeemFailure, type SystemRole, type SystemSettings, type Validity, type Voucher, type VoucherInput } from './rbac';
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
 * The external API (/api): authenticated by a personal API token,
 * `Authorization: Bearer rbacr_…`, acting as the person who created it, or
 * on the self-service routes by an app's Google ID token (I1-I5), acting as
 * its user without root powers. hooks.server.ts has already checked the
 * token (and refused the request without a valid one); session cookies never
 * count here.
 */
export async function api(event: RequestEvent, fn: (ctx: Ctx) => Promise<unknown>): Promise<Response> {
	const email = event.url.pathname.startsWith('/api/') ? event.locals.email : null;
	if (!email) {
		return json({ error: 'A valid API token is required' }, { status: 401, headers: { 'www-authenticate': 'Bearer' } });
	}
	const app = event.locals.app === true;
	// Also checked in hooks.server.ts; repeated so no route can be reached around it (I4).
	if (app && !appMayCall(event.request.method, event.url.pathname)) {
		return json({ error: "A Google ID token only reaches rbacr's self-service routes; use a personal API token" }, { status: 403 });
	}
	const services = await getServices();
	return run({ ...services, actor: await services.rbac.actor(email, { app }) }, fn);
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

/** A system's settings from a PATCH body: the fields present, null (or blank) clearing a role, URL or text (Q2, R10, R11, R13). */
export function systemSettings(body: Record<string, unknown>): SystemSettings {
	if ('maintenance' in body && typeof body.maintenance !== 'boolean') {
		throw new RbacError(400, '"maintenance" must be true or false');
	}
	return {
		...('subscriberRole' in body && { subscriberRole: optStr(body.subscriberRole, 'subscriberRole') }),
		...('url' in body && { url: optStr(body.url, 'url') }),
		...('maintenance' in body && { maintenance: body.maintenance as boolean }),
		...('description' in body && { description: optStr(body.description, 'description') }),
		...('screenshotUrl' in body && { screenshotUrl: optStr(body.screenshotUrl, 'screenshotUrl') })
	};
}

/** A role's settings from a PUT body: the fields present (R7, R9). */
export function roleSettings(body: Record<string, unknown>): { implies?: string[]; everyone?: boolean } {
	if ('everyone' in body && typeof body.everyone !== 'boolean') throw new RbacError(400, '"everyone" must be true or false');
	return {
		...('implies' in body && { implies: strList(body.implies, 'implies') }),
		...('everyone' in body && { everyone: body.everyone as boolean })
	};
}

/** A grant's optional `startsAt` and `endsAt` (G1); blank or missing means immediately and forever. */
export function validity(body: Record<string, unknown>): Validity {
	return { startsAt: optDate(body.startsAt, 'startsAt'), endsAt: optDate(body.endsAt, 'endsAt') };
}

/** A global voucher's `grants`: system roles, `[{ systemId, role }]` (V1). */
function systemRoles(value: unknown): SystemRole[] {
	if (!Array.isArray(value)) throw new RbacError(400, '"grants" must be an array of { systemId, role }');
	return value.map((g) => {
		if (!g || typeof g !== 'object') throw new RbacError(400, '"grants" must be an array of { systemId, role }');
		const { systemId, role } = g as Record<string, unknown>;
		return { systemId: str(systemId, 'grants[].systemId'), role: str(role, 'grants[].role') };
	});
}

/**
 * A voucher's terms from a request body (V1, V2): `roles`, or a single
 * `role` as older clients send it, or for a global voucher its system
 * roles as `grants`, and an optional `code`.
 */
export function voucherInput(body: Record<string, unknown>, systemId: string | null): VoucherInput {
	return {
		systemId,
		...(body.grants !== undefined
			? { roles: [], grants: systemRoles(body.grants) }
			: { roles: body.roles === undefined ? [str(body.role, 'role')] : strList(body.roles, 'roles') }),
		code: optStr(body.code, 'code'),
		startsAt: optDate(body.startsAt, 'startsAt'),
		endsAt: optDate(body.endsAt, 'endsAt'),
		maxUses: optInt(body.maxUses, 'maxUses'),
		discountPercent: optInt(body.discountPercent, 'discountPercent')
	};
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

/** A person's own redemption (V8): its RedeemEvent with ISO dates, and the systems its roles open. */
export const ownRedemptionJson = ({ redemption, systems }: OwnRedemption) => ({ redemption: redeemEventJson(redemption), systems });

/** A failed redeem attempt (V9) with ISO dates. */
export const redeemFailureJson = (f: RedeemFailure) => ({ ...f, attemptedAt: f.attemptedAt.toISOString() });

/** A RedeemEvent (V7) with ISO dates. */
export const redeemEventJson = (e: RedeemEvent) => ({
	...e,
	redeemedAt: e.redeemedAt.toISOString(),
	grants: e.grants.map((g) => ({
		...g,
		replaced: g.replaced && {
			...g.replaced,
			grantedAt: g.replaced.grantedAt.toISOString(),
			startsAt: g.replaced.startsAt?.toISOString() ?? null,
			endsAt: g.replaced.endsAt?.toISOString() ?? null
		}
	}))
});

/** A notification (N1) with ISO dates. */
export const notificationJson = (n: Notification) => ({
	...n,
	endsAt: n.endsAt.toISOString(),
	raisedAt: n.raisedAt.toISOString(),
	resolvedAt: n.resolvedAt?.toISOString() ?? null,
	dismissedAt: n.dismissedAt?.toISOString() ?? null
});

export const tokenJson = (t: ApiToken) => ({
	...t,
	createdAt: t.createdAt.toISOString(),
	expiresAt: t.expiresAt?.toISOString() ?? null,
	lastUsedAt: t.lastUsedAt?.toISOString() ?? null,
	revokedAt: t.revokedAt?.toISOString() ?? null
});
