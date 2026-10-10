import { vpiLoad } from '#lib/vpi.js';
import type { Token } from '#lib/ApiTokens.svelte';
import type { Grant, Voucher } from '../systems/[system]/+page.js';
import type { PageLoad } from './$types';

export interface GlobalData {
	grants: Grant[];
	vouchers: Voucher[];
	roleNames: string[];
	/** Each system with its roles, for the voucher form (SPEC V1). */
	systems: { id: string; name: string; roles: string[] }[];
}

/** Everyone's own API tokens; for roots, also global grants and vouchers (null otherwise). */
export const load: PageLoad = async ({ fetch, parent }) => {
	const { user } = await parent();
	const [{ tokens }, global] = await Promise.all([
		vpiLoad<{ tokens: Token[] }>(fetch, '/tokens'),
		user?.root ? vpiLoad<GlobalData>(fetch, '/global') : null
	]);
	return { tokens, global };
};
