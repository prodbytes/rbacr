import { json } from '@sveltejs/kit';
import { api, optDate, optInt, readJson, str, voucherJson } from '#lib/server/http.js';
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
		const voucher = await rbac.createVoucher(actor, {
			systemId: null,
			role: str(body.role, 'role'),
			startsAt: optDate(body.startsAt, 'startsAt'),
			endsAt: optDate(body.endsAt, 'endsAt'),
			maxUses: optInt(body.maxUses, 'maxUses'),
			discountPercent: optInt(body.discountPercent, 'discountPercent')
		});
		return json(voucherJson(voucher, voucherStatus(voucher, new Date())), { status: 201 });
	});
