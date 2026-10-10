import { vpiLoad } from '#lib/vpi.js';
import type { Grant, Voucher } from '../systems/[system]/+page.js';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ fetch }) => vpiLoad<{ grants: Grant[]; vouchers: Voucher[] }>(fetch, '/global');
