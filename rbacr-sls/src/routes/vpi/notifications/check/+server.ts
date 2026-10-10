import { notificationJson, vpi } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** Runs the verification rules now (N2), as a root's sign-in does, and answers the notifications. */
export const POST: RequestHandler = (event) =>
	vpi(event, async ({ rbac, actor }) => ({ notifications: (await rbac.verify(actor)).map(notificationJson) }));
