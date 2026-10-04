import { json } from '@sveltejs/kit';
import { api, grantJson, readJson, str } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Global grants (roots only): a role in every system whose catalog has it. */
export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({ grants: (await rbac.listGlobalGrants(actor)).map(grantJson) }));

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const grant = await rbac.grantGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee'));
		return json(grantJson(grant), { status: 201 });
	});

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		await rbac.revokeGlobal(actor, str(body.role, 'role'), str(body.grantee, 'grantee'));
		return new Response(null, { status: 204 });
	});
