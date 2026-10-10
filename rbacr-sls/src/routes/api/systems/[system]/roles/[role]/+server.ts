import { api, readJson, roleSettings } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Role settings (roots): `implies` replaces the roles it implies (R7); `everyone` makes every identity hold it (R9). */
export const PUT: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return rbac.configureRole(actor, event.params.system, event.params.role, roleSettings(body));
	});

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.removeRole(actor, event.params.system, event.params.role);
		return new Response(null, { status: 204 });
	});
