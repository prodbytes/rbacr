import { vpi, redeemEventJson, redeemFailureJson } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** A voucher's redemptions (V7) and failed attempts (V9), each newest first; roots only. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({
		redemptions: (await rbac.listRedemptions(actor, event.params.code)).map(redeemEventJson),
		failures: (await rbac.listRedeemFailures(actor, event.params.code)).map(redeemFailureJson)
	}));
