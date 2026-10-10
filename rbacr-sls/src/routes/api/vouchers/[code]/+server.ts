import { api, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/** Disables a voucher (it stays listed for auditing). */
export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const voucher = await rbac.disableVoucher(actor, event.params.code);
		return voucherJson(voucher, voucherStatus(voucher, new Date()));
	});
