import { api, readJson, systemSettings } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, ({ rbac, actor }) => rbac.getSystem(actor, event.params.system));

/** System settings (roots): `subscriberRole` (a catalog role, Q2) and/or `url` (R10); null clears either. */
export const PATCH: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) =>
		rbac.configureSystem(actor, event.params.system, systemSettings(await readJson(event.request)))
	);

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		await rbac.deleteSystem(actor, event.params.system);
		return new Response(null, { status: 204 });
	});
