import { readJson, str, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const grants = await rbac.redeemVoucher(actor.email, str((await readJson(event.request)).code, 'code'), 'page');
		const roles = grants.map((g) => g.role).join(', ');
		return { redeemed: grants[0].systemId ? `${grants[0].systemId} / ${roles}` : `${roles} in all systems` };
	});
