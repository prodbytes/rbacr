import { tokenJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = (event) =>
	vpi(event, async ({ tokens, actor }) => tokenJson(await tokens.revoke(actor.email, event.params.id)));
