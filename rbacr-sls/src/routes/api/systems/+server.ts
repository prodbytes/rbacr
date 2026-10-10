import { json } from '@sveltejs/kit';
import { api, readJson, str } from '#lib/server/http.js';
import { RbacError } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => ({ systems: await rbac.listSystems(actor) }));

export const POST: RequestHandler = (event) =>
	api(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		if (body.roles !== undefined && !(Array.isArray(body.roles) && body.roles.every((r) => typeof r === 'string'))) {
			throw new RbacError(400, '"roles" must be an array of strings');
		}
		const system = await rbac.createSystem(actor, {
			id: str(body.id, 'id'),
			name: typeof body.name === 'string' ? body.name : undefined,
			roles: body.roles as string[] | undefined
		});
		return json(system, { status: 201 });
	});
