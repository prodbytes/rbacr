import { describe, expect, it } from 'vitest';
import { isCrossSiteForm } from './csrf';

const OWN = ['https://rbacr.example.com'];
const req = (method: string, headers: Record<string, string> = {}) =>
	new Request('https://rbacr.example.com/x', { method, headers });

describe('isCrossSiteForm (H2)', () => {
	it('refuses form-like writes from other or unknown origins', () => {
		for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
			expect(isCrossSiteForm(req(method), '/logout', OWN)).toBe(true);
			expect(isCrossSiteForm(req(method, { origin: 'https://evil.example' }), '/logout', OWN)).toBe(true);
		}
		for (const type of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', 'Text/Plain']) {
			expect(isCrossSiteForm(req('POST', { 'content-type': type }), '/login/dev', OWN)).toBe(true);
		}
	});

	it('accepts same-origin forms, reads and non-form bodies', () => {
		expect(isCrossSiteForm(req('POST', { origin: OWN[0] }), '/logout', OWN)).toBe(false);
		expect(isCrossSiteForm(req('GET'), '/me', OWN)).toBe(false);
		expect(isCrossSiteForm(req('HEAD'), '/me', OWN)).toBe(false);
		expect(isCrossSiteForm(req('POST', { 'content-type': 'application/json' }), '/webhooks/stripe', OWN)).toBe(false);
	});

	it('never applies to /api, which takes bearer tokens only', () => {
		expect(isCrossSiteForm(req('DELETE'), '/api/vouchers/ABCD', OWN)).toBe(false);
		expect(isCrossSiteForm(req('POST', { 'content-type': 'text/plain' }), '/api', OWN)).toBe(false);
		expect(isCrossSiteForm(req('DELETE'), '/apis', OWN)).toBe(true);
	});
});
