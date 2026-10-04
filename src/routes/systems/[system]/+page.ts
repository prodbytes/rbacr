import { uxLoad } from '#lib/uxapi.js';
import type { PageLoad } from './$types';

export interface Grant {
	systemId: string | null;
	role: string;
	grantee: string;
	grantedBy: string;
	grantedAt: string;
	voucherCode: string | null;
}

export interface Voucher {
	code: string;
	systemId: string | null;
	role: string;
	discountPercent: number;
	startsAt: string | null;
	endsAt: string | null;
	maxUses: number | null;
	uses: number;
	status: string;
	createdBy: string;
	createdAt: string;
	disabledAt: string | null;
}

export const load: PageLoad = ({ fetch, params }) =>
	uxLoad<{
		system: { id: string; name: string; roles: string[] };
		grants: Grant[];
		vouchers: Voucher[];
		root: boolean;
		assignable: string[];
	}>(fetch, `/systems/${encodeURIComponent(params.system)}`);
