import { grantJson, readJson, str, validity, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return grantJson(await rbac.grantGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee'), validity(body)));
	});

export const DELETE: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		await rbac.revokeGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee'));
	});
