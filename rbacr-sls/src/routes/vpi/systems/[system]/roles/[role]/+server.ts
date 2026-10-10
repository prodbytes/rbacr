import { readJson, roleSettings, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const PUT: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return rbac.configureRole(actor, event.params.system, event.params.role, roleSettings(body));
	});

export const DELETE: RequestHandler = (event) =>
	vpi(event, ({ rbac, actor }) => rbac.removeRole(actor, event.params.system, event.params.role));
