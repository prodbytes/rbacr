import { grantJson, vpi, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/**
 * Everything the global page shows (roots only), including every role name
 * some system's catalog has, which its voucher form offers.
 */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const now = new Date();
		return {
			grants: (await rbac.listGlobalGrants(actor)).map(grantJson),
			vouchers: (await rbac.listGlobalVouchers(actor)).map((v) => voucherJson(v, voucherStatus(v, now))),
			roleNames: [...new Set((await rbac.listSystems(actor)).flatMap((s) => s.roles))].sort()
		};
	});
