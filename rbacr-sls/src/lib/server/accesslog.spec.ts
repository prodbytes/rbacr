import { describe, expect, it } from 'vitest';
import { accessLine, credentialOf, refererOrigin } from './accesslog';

const req = (headers: Record<string, string>) => new Request('https://rbacr.example.com/api/check', { method: 'POST', headers });

describe('credentialOf', () => {
	it('tells API tokens, ID tokens, sessions and nothing apart', () => {
		expect(credentialOf(req({ authorization: 'Bearer rbacr_abc' }), false)).toBe('token');
		expect(credentialOf(req({ authorization: 'bearer eyJ.a.b' }), true)).toBe('id-token');
		expect(credentialOf(req({}), true)).toBe('session');
		expect(credentialOf(req({ authorization: 'Bearer' }), false)).toBe('none');
	});
});

describe('accessLine', () => {
	const entry = {
		method: 'POST',
		route: '/redeem/[code]',
		status: 429,
		ms: 12,
		ip: '203.0.113.7',
		userAgent: 'curl/8.7.1',
		origin: 'https://presence.nu01.com',
		referer: 'https://presence.nu01.com',
		credential: 'token' as const
	};

	it('is one JSON line with the route pattern, never a secret', () => {
		const line = accessLine(entry);
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual({ msg: 'request', ...entry });
		expect(line).not.toContain('rbacr_');
	});

	it('cuts a long user agent or origin', () => {
		const { userAgent, origin } = JSON.parse(accessLine({ ...entry, userAgent: 'x'.repeat(5000), origin: 'y'.repeat(5000) }));
		expect(userAgent).toHaveLength(160);
		expect(origin).toHaveLength(160);
	});

	it('keeps absent headers null', () => {
		expect(JSON.parse(accessLine({ ...entry, userAgent: null, origin: null, referer: null }))).toMatchObject({ userAgent: null, origin: null, referer: null });
	});
});

describe('refererOrigin', () => {
	it('keeps the origin, never the path (a voucher code)', () => {
		expect(refererOrigin('https://rbacr.nu01.com/redeem/SECRET-CODE?x=1')).toBe('https://rbacr.nu01.com');
		expect(refererOrigin('http://localhost:5173/')).toBe('http://localhost:5173');
	});

	it('is null when absent or not an absolute URL', () => {
		expect(refererOrigin(null)).toBeNull();
		expect(refererOrigin('')).toBeNull();
		expect(refererOrigin('/redeem/SECRET-CODE')).toBeNull();
		expect(refererOrigin('about:blank')).toBeNull();
	});
});
