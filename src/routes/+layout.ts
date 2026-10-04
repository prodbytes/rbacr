import { uxFetch } from '#lib/uxapi.js';
import type { LayoutLoad } from './$types';

export interface SessionUser {
	email: string;
	root: boolean;
	manages: boolean;
}

export const load: LayoutLoad = ({ fetch }) =>
	uxFetch<{ user: SessionUser | null; devLogin: boolean }>(fetch, '/session');
