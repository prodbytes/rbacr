import { describe, expect, it } from 'vitest';
import { DEFAULT_NEXT, redeemPath, safeNext } from './next';

describe('safeNext (S5)', () => {
	it('keeps paths on the site', () => {
		expect(safeNext('/redeem/2026Q4-OTTER-FALCON-LEMUR')).toBe('/redeem/2026Q4-OTTER-FALCON-LEMUR');
		expect(safeNext('/systems/crm?x=1#vouchers')).toBe('/systems/crm?x=1#vouchers');
		expect(safeNext('/')).toBe('/');
	});

	it('falls back to /me for anything that could leave it', () => {
		for (const bad of [
			null,
			undefined,
			'',
			'me',
			'//evil.com',
			'/\\evil.com',
			'/a\\b',
			'https://evil.com',
			'javascript:alert(1)',
			'/x\nLocation: https://evil.com',
			'\t//evil.com',
			`/${'a'.repeat(600)}`
		]) {
			expect(safeNext(bad)).toBe(DEFAULT_NEXT);
		}
	});

	it('builds redeem links that safeNext keeps (V8)', () => {
		expect(redeemPath('SPRING SALE')).toBe('/redeem/SPRING%20SALE');
		expect(safeNext(redeemPath('2026Q4-OTTER'))).toBe('/redeem/2026Q4-OTTER');
	});
});
