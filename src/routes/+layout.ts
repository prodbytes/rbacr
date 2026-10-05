import { vpiFetch } from '#lib/vpi.js';
import type { LayoutLoad } from './$types';

export interface SessionUser {
	email: string;
	root: boolean;
	manages: boolean;
}

export const load: LayoutLoad = ({ fetch }) =>
	vpiFetch<{ user: SessionUser | null; devLogin: boolean }>(fetch, '/session');
