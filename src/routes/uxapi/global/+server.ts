import { grantJson, ux, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/** Everything the global page shows (roots only). */
export const GET: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const now = new Date();
		return {
			grants: (await rbac.listGlobalGrants(actor)).map(grantJson),
			vouchers: (await rbac.listGlobalVouchers(actor)).map((v) => voucherJson(v, voucherStatus(v, now)))
		};
	});
