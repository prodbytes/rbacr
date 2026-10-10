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
	/** The roles redeeming it grants (SPEC V1). */
	roles: string[];
	discountPercent: number;
	startsAt: string | null;
	endsAt: string | null;
	maxUses: number | null;
	uses: number;
	status: string;
	createdBy: string;
	createdAt: string;
	disabledAt: string | null;
	/** Who disabled it (SPEC L1, L3). */
	disabledBy: string | null;
}

export const load: PageLoad = ({ fetch, params }) =>
	vpiLoad<{
		system: {
			id: string;
			name: string;
			roles: string[];
			implies: Record<string, string[]>;
			subscriberRole: string | null;
			/** Roles every identity holds (SPEC R9). */
			everyone: string[];
			/** Where role names link to (SPEC R10). */
			url: string | null;
			/** No roles are given while on (SPEC R11). */
			maintenance: boolean;
		};
		grants: Grant[];
		vouchers: Voucher[];
		root: boolean;
	}>(fetch, `/systems/${encodeURIComponent(params.system)}`);
