import { readJson, strList, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return rbac.setImplications(actor, event.params.system, event.params.role, strList(body.implies, 'implies'));
	});

export const DELETE: RequestHandler = (event) =>
	vpi(event, ({ rbac, actor }) => rbac.removeRole(actor, event.params.system, event.params.role));
