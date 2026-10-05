import { describe, expect, it } from 'vitest';
import { rejectNonFrontend } from './vpiguard';

const OWN = ['https://rbacr.example.com'];
const req = (method: string, headers: Record<string, string>) =>
	new Request('https://rbacr.example.com/vpi/me', { method, headers });
const frontend = { 'x-rbacr-vpi': '1', 'sec-fetch-site': 'same-origin' };

describe('rejectNonFrontend', () => {
	it("accepts SvelteKit's internal render fetches", () => {
		expect(rejectNonFrontend(req('GET', {}), true, OWN)).toBeNull();
	});

	it('accepts same-origin browser fetches from the frontend', () => {
		expect(rejectNonFrontend(req('GET', frontend), false, OWN)).toBeNull();
		expect(rejectNonFrontend(req('POST', { ...frontend, origin: OWN[0] }), false, OWN)).toBeNull();
	});

	it('rejects plain clients, other sites and foreign origins', () => {
		expect(rejectNonFrontend(req('GET', {}), false, OWN)).toMatch(/header/);
		expect(rejectNonFrontend(req('GET', { 'x-rbacr-vpi': '1' }), false, OWN)).toMatch(/same-origin/);
		expect(rejectNonFrontend(req('GET', { ...frontend, 'sec-fetch-site': 'cross-site' }), false, OWN)).toMatch(/same-origin/);
		expect(rejectNonFrontend(req('GET', { ...frontend, 'sec-fetch-site': 'same-site' }), false, OWN)).toMatch(/same-origin/);
		expect(rejectNonFrontend(req('POST', frontend), false, OWN)).toMatch(/origin/);
		expect(rejectNonFrontend(req('POST', { ...frontend, origin: 'https://evil.example' }), false, OWN)).toMatch(/origin/);
	});
});
