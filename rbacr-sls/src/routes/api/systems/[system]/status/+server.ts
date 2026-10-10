import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** A system's status (R12): `{ id, name, url, maintenance }`, for any token. */
export const GET: RequestHandler = (event) => api(event, ({ rbac }) => rbac.systemStatus(event.params.system));
