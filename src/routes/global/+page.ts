import { uxLoad } from '#lib/uxapi.js';
import type { Grant, Voucher } from '../systems/[system]/+page.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) => uxLoad<{ grants: Grant[]; vouchers: Voucher[] }>(fetch, '/global');
