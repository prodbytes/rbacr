import { json } from '@sveltejs/kit';
import { api, optDate, optInt, readJson, str, voucherJson } from '#lib/server/http.js';
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
		const voucher = await rbac.createVoucher(actor, {
			systemId: event.params.system,
			role: str(body.role, 'role'),
			startsAt: optDate(body.startsAt, 'startsAt'),
			endsAt: optDate(body.endsAt, 'endsAt'),
			maxUses: optInt(body.maxUses, 'maxUses'),
			discountPercent: optInt(body.discountPercent, 'discountPercent')
		});
		return json(voucherJson(voucher, voucherStatus(voucher, new Date())), { status: 201 });
	});
