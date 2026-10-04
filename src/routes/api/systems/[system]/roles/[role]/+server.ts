import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.removeRole(actor, event.params.system, event.params.role);
		return new Response(null, { status: 204 });
	});
