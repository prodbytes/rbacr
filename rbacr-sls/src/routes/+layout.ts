import { vpiFetch } from '#lib/vpi.js';
import type { LayoutLoad } from './$types';

export interface SessionUser {
	email: string;
	root: boolean;
	/** Open notifications (N1); always 0 for anyone but roots. */
	openNotifications: number;
}

export const load: LayoutLoad = ({ fetch }) =>
	vpiFetch<{ user: SessionUser | null; devLogin: boolean }>(fetch, '/session');
