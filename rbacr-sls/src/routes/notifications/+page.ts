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

export const load: PageLoad = ({ fetch }) => vpiLoad<{ notifications: Notification[] }>(fetch, '/notifications');
