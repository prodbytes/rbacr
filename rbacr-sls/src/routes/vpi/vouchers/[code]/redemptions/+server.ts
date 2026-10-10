import { vpi, redeemEventJson } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** A voucher's redemptions, each a RedeemEvent with all its details (V7), newest first; roots only. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({
		redemptions: (await rbac.listRedemptions(actor, event.params.code)).map(redeemEventJson)
	}));
