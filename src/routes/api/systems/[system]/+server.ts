import { api, readJson, subscriberRole } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, ({ rbac, actor }) => rbac.getSystem(actor, event.params.system));

/** System configuration (roots): `{ subscriberRole }`, a catalog role or null (Q2). */
export const PATCH: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) =>
		rbac.setSubscriberRole(actor, event.params.system, subscriberRole(await readJson(event.request)))
	);

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.deleteSystem(actor, event.params.system);
		return new Response(null, { status: 204 });
	});
