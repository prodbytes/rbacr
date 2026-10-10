import { grantJson, vpi, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/**
 * Everything the global page shows (roots only): every role name some
 * system's catalog has, which its grant form offers, and each system's
 * roles, which its voucher form offers (V1).
 */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const now = new Date();
		const systems = await rbac.listSystems(actor);
		return {
			grants: (await rbac.listGlobalGrants(actor)).map(grantJson),
			vouchers: (await rbac.listGlobalVouchers(actor)).map((v) => voucherJson(v, voucherStatus(v, now))),
			roleNames: [...new Set(systems.flatMap((s) => s.roles))].sort(),
			systems: systems.map(({ id, name, roles }) => ({ id, name, roles }))
		};
	});
