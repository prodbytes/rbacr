import { redeemFailureJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The latest failed redeem attempts (V9), for the notifications page; roots only. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({ failures: (await rbac.listRedeemFailures(actor)).map(redeemFailureJson) }));
