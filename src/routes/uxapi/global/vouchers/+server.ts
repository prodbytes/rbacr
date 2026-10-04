import { optDate, optInt, readJson, str, ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const voucher = await rbac.createVoucher(actor, {
			systemId: null,
			role: str(body.role, 'role'),
			startsAt: optDate(body.startsAt, 'startsAt'),
			endsAt: optDate(body.endsAt, 'endsAt'),
			maxUses: optInt(body.maxUses, 'maxUses'),
			discountPercent: optInt(body.discountPercent, 'discountPercent')
		});
		return { code: voucher.code };
	});
