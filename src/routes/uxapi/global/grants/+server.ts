import { grantJson, readJson, str, ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		return grantJson(await rbac.grantGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee')));
	});

export const DELETE: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		await rbac.revokeGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee'));
	});
