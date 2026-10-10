import { api, redeemFailureJson } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** A voucher's failed redeem attempts (V9), newest first; roots only. */
export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({
		failures: (await rbac.listRedeemFailures(actor, event.params.code)).map(redeemFailureJson)
	}));
