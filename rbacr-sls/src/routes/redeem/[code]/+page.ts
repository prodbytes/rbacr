import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

/** A voucher's redeem link (V8): anonymous visitors sign in first and come back here (S5). */
export const load: PageLoad = async ({ parent, params, url }) => {
	if (!(await parent()).user) redirect(303, `/?next=${encodeURIComponent(url.pathname)}`);
	return { code: params.code };
};
