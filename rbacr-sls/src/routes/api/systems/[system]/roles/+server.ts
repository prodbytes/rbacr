import { api, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		await rbac.addRole(actor, event.params.system, str(body.role, 'role'));
		return rbac.getSystem(actor, event.params.system);
	});
