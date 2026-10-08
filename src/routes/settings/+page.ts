import { vpiLoad } from '#lib/vpi.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) =>
	vpiLoad<{ version: string; apiBase: string; email: string; root: boolean }>(fetch, '/settings');
