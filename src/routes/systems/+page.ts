import { vpiLoad } from '#lib/vpi.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) =>
	vpiLoad<{ systems: { id: string; name: string; roles: string[] }[]; root: boolean }>(fetch, '/systems');
