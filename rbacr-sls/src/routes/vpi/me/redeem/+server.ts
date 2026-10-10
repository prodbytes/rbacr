import { readJson, str, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const grants = await rbac.redeemVoucher(actor.email, str((await readJson(event.request)).code, 'code'), 'page');
		// Each grant in its system; an older global voucher's roles in every system that has them.
		return { redeemed: grants.map((g) => (g.systemId ? `${g.systemId} / ${g.role}` : `${g.role} in all systems`)).join(', ') };
	});
