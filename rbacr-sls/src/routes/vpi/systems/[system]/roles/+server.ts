import { readJson, str, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) =>
		rbac.addRole(actor, event.params.system, str((await readJson(event.request)).role, 'role'))
	);
