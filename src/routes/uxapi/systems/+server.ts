import { json } from '@sveltejs/kit';
import { readJson, str, ux } from '#lib/server/http.js';
import { RbacError } from '#lib/server/rbac.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => ({ systems: await rbac.listSystems(actor), root: actor.root }));

export const POST: RequestHandler = (event) =>
	ux(event, async ({ rbac, actor }) => {
		const body = await readJson(event.request);
		const roles = typeof body.roles === 'string' ? body.roles.split(/[\s,]+/).filter(Boolean) : [];
		if (body.roles !== undefined && typeof body.roles !== 'string') throw new RbacError(400, '"roles" must be a string');
		const system = await rbac.createSystem(actor, {
			id: str(body.id, 'id'),
			name: typeof body.name === 'string' ? body.name : undefined,
			roles
		});
		return json(system, { status: 201 });
	});
