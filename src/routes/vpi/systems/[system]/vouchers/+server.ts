import { optDate, optInt, readJson, str, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const voucher = await rbac.createVoucher(actor, {
			systemId: event.params.system,
			role: str(body.role, 'role'),
			startsAt: optDate(body.startsAt, 'startsAt'),
			endsAt: optDate(body.endsAt, 'endsAt'),
			maxUses: optInt(body.maxUses, 'maxUses'),
			discountPercent: optInt(body.discountPercent, 'discountPercent')
		});
		return { code: voucher.code };
	});
