import { api, redeemFailureJson } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The latest failed redeem attempts of every voucher, unknown codes included (V9), newest first; roots only. */
export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({ failures: (await rbac.listRedeemFailures(actor)).map(redeemFailureJson) }));
