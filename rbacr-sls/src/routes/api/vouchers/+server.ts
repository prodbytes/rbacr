import { json } from '@sveltejs/kit';
import { api, readJson, voucherInput, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

/** Global vouchers (roots only); system vouchers live under /api/systems/:id/vouchers. */
export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const now = new Date();
		return { vouchers: (await rbac.listGlobalVouchers(actor)).map((v) => voucherJson(v, voucherStatus(v, now))) };
	});

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const voucher = await rbac.createVoucher(actor, voucherInput(body, null));
		return json(voucherJson(voucher, voucherStatus(voucher, new Date())), { status: 201 });
	});
