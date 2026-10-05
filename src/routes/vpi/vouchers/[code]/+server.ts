import { vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Disables a voucher (system or global). */
export const DELETE: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		await rbac.disableVoucher(actor, event.params.code);
	});
