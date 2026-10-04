import { grantJson, ux, voucherJson } from '#lib/server/http.js';
import { ADMIN_ROLE, voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/** Everything the system page shows. */
export const GET: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const id = event.params.system;
		const system = await rbac.getSystem(actor, id);
		const now = new Date();
		return {
			system,
			grants: (await rbac.listGrants(actor, id)).map(grantJson),
			vouchers: (await rbac.listVouchers(actor, id)).map((v) => voucherJson(v, voucherStatus(v, now))),
			root: actor.root,
			// roles this actor may hand out (admins never see "admin")
			assignable: system.roles.filter((r) => actor.root || r !== ADMIN_ROLE)
		};
	});

export const DELETE: RequestHandler = (event) =>
	ux(event, ({ rbac, actor }) => rbac.deleteSystem(actor, event.params.system));
