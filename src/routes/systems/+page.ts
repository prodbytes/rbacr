import { uxLoad } from '#lib/uxapi.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) =>
	uxLoad<{ systems: { id: string; name: string; roles: string[] }[]; root: boolean }>(fetch, '/systems');
