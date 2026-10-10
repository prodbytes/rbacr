import { json } from '@sveltejs/kit';
import { api, grantJson, readJson, str, validity } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({
		grants: (await rbac.listGrants(actor, event.params.system)).map(grantJson)
	}));

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const grant = await rbac.grant(actor, event.params.system, str(body.role, 'role'), str(body.grantee, 'grantee'), validity(body));
		return json(grantJson(grant), { status: 201 });
	});

export const DELETE: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		await rbac.revoke(actor, event.params.system, str(body.role, 'role'), str(body.grantee, 'grantee'));
		return new Response(null, { status: 204 });
	});
