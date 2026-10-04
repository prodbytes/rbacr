import { readJson, str, ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) =>
		rbac.addRole(actor, event.params.system, str((await readJson(event.request)).role, 'role'))
	);
