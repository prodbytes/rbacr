import { vpiLoad } from '#lib/vpi.js';
import type { Card } from '#lib/SystemCard.svelte';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) =>
	vpiLoad<{
			email: string;
			root: boolean;
			globalRoles: string[];
			roles: Record<string, string[]>;
			/** Each system's URL, for those that have one (SPEC R10). */
			urls: Record<string, string>;
			/** Each system's card (SPEC R13). */
			systems: Record<string, Card>;
		}>(fetch, '/me');
