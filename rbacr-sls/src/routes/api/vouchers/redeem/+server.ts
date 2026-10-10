import { api, grantJson, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return grantJson(await rbac.redeemVoucher(actor.email, str(body.code, 'code')));
	});
