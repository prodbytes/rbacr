import { json } from '@sveltejs/kit';
import { api, readJson, voucherInput, voucherJson } from '#lib/server/http.js';
import { voucherStatus } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const now = new Date();
		const vouchers = await rbac.listVouchers(actor, event.params.system);
		return { vouchers: vouchers.map((v) => voucherJson(v, voucherStatus(v, now))) };
	});

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const voucher = await rbac.createVoucher(actor, voucherInput(body, event.params.system));
		return json(voucherJson(voucher, voucherStatus(voucher, new Date())), { status: 201 });
	});
