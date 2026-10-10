import { notificationJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The roots' notifications (N1), open ones first. */
export const GET: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({ notifications: (await rbac.listNotifications(actor)).map(notificationJson) }));
