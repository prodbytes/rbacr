import { vpiLoad } from '#lib/vpi.js';
import type { PageLoad } from './$types';

export interface Notification {
	id: string;
	kind: 'voucher-expiring';
	severity: 'warning';
	message: string;
	systemId: string | null;
	voucherCode: string;
	roles: string[];
	endsAt: string;
	raisedAt: string;
	resolvedAt: string | null;
	dismissedAt: string | null;
	dismissedBy: string | null;
	status: 'open' | 'resolved' | 'dismissed';
}

/** A failed redeem attempt (SPEC V9). */
export interface RedeemFailure {
	id: string;
	code: string;
	known: boolean;
	systemId: string | null;
	email: string;
	attemptedAt: string;
	via: 'api' | 'page';
	status: number;
	reason: string;
}

export const load: PageLoad = async ({ fetch }) => ({
	...(await vpiLoad<{ notifications: Notification[] }>(fetch, '/notifications')),
	...(await vpiLoad<{ failures: RedeemFailure[] }>(fetch, '/redeem-failures'))
});
