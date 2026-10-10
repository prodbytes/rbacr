import { api, readJson, strList } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Sets the roles this role implies, replacing the previous ones. */
export const PUT: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return rbac.setImplications(actor, event.params.system, event.params.role, strList(body.implies, 'implies'));
	});

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.removeRole(actor, event.params.system, event.params.role);
		return new Response(null, { status: 204 });
	});
