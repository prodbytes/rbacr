import { readJson, str, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const grant = await rbac.redeemVoucher(actor.email, str((await readJson(event.request)).code, 'code'));
		return { redeemed: grant.systemId ? `${grant.systemId} / ${grant.role}` : `${grant.role} in all systems` };
	});
