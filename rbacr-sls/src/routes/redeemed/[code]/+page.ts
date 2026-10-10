import { vpiLoad } from '#lib/vpi.js';
import type { Card } from '#lib/SystemCard.svelte';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch, params }) =>
	vpiLoad<{
		redemption: { code: string; systemId: string | null; roles: string[]; redeemedAt: string };
		/** The systems the voucher's roles are in, with those roles (SPEC V8, R13). */
		systems: (Card & { roles: string[] })[];
	}>(fetch, `/me/redemptions/${encodeURIComponent(params.code)}`);
