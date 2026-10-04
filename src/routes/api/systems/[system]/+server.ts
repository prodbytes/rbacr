import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, ({ rbac, actor }) => rbac.getSystem(actor, event.params.system));

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.deleteSystem(actor, event.params.system);
		return new Response(null, { status: 204 });
	});
