import { RBACR_ORIGIN_SECRET } from '$app/env/private';
import { api, clientAddress, grantJson, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The first grant, as clients of one role per voucher expect, and all of them in `grants` (V4). */
export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const grants = (await rbac.redeemVoucher(actor.email, str(body.code, 'code'), 'api', actor.systems, clientAddress(event, !!RBACR_ORIGIN_SECRET))).map(grantJson);
		return { ...grants[0], grants };
	});
