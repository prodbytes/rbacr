import { ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = (event) =>
	ux(event, ({ rbac, actor }) => rbac.removeRole(actor, event.params.system, event.params.role));
