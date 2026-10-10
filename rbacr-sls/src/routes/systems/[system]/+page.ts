import { vpiLoad } from '#lib/vpi.js';
import type { PageLoad } from './$types';

export interface Grant {
	systemId: string | null;
	role: string;
	grantee: string;
	grantedBy: string;
	grantedAt: string;
	/** Validity (G1): null start means immediately, null end means forever. */
	startsAt: string | null;
	endsAt: string | null;
	status: 'active' | 'not-started' | 'expired';
	voucherCode: string | null;
	/** Roles the granted role implies in this system. */
	impliedRoles: string[];
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
	vpiLoad<{
		system: { id: string; name: string; roles: string[]; implies: Record<string, string[]>; subscriberRole: string | null };
		grants: Grant[];
		vouchers: Voucher[];
		root: boolean;
	}>(fetch, `/systems/${encodeURIComponent(params.system)}`);
