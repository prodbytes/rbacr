import { vpiLoad } from '#lib/vpi.js';
import type { PageLoad } from './$types';

export interface Token {
	id: string;
	name: string;
	prefix: string;
	createdAt: string;
	expiresAt: string | null;
	lastUsedAt: string | null;
	revokedAt: string | null;
}

export const load: PageLoad = async ({ fetch }) => {
	const [me, { tokens }] = await Promise.all([
		vpiLoad<{ email: string; root: boolean; globalRoles: string[]; roles: Record<string, string[]> }>(fetch, '/me'),
		vpiLoad<{ tokens: Token[] }>(fetch, '/tokens')
	]);
	return { ...me, tokens };
};
