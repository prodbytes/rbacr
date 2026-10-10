import { notificationJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Dismisses a notification for every root (N4). */
export const DELETE: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => notificationJson(await rbac.dismissNotification(actor, event.params.id)));
