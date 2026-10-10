import { readJson, voucherInput, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const voucher = await rbac.createVoucher(actor, voucherInput(body, null));
		return { code: voucher.code };
	});
