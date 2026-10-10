import { ownRedemptionJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The signed-in person's own redemption of a voucher and the systems it opens (V8). */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ownRedemptionJson(await rbac.ownRedemption(actor.email, event.params.code)));
