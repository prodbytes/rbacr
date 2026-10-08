import { grantJson, vpi, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/** Everything the system page shows. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const id = event.params.system;
		const system = await rbac.getSystem(actor, id);
		const now = new Date();
		return {
			system,
			grants: (await rbac.listGrants(actor, id)).map(grantJson),
			vouchers: (await rbac.listVouchers(actor, id)).map((v) => voucherJson(v, voucherStatus(v, now))),
			root: actor.root
		};
	});

export const DELETE: RequestHandler = (event) =>
	vpi(event, ({ rbac, actor }) => rbac.deleteSystem(actor, event.params.system));
