import { redirect } from '@sveltejs/kit';
import { safeNext } from '#lib/next.js';
import type { PageLoad } from './$types';

/** `?next=` is where to go once signed in (S5), e.g. a voucher's redeem page. */
export const load: PageLoad = async ({ parent, url }) => {
	const next = url.searchParams.get('next');
	if ((await parent()).user) redirect(303, safeNext(next));
	return { next: next === null ? null : safeNext(next) };
};
