import { api } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = (event) => api(event, ({ rbac, actor }) => rbac.me(actor));
