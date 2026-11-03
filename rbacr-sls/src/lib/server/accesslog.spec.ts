import { describe, expect, it } from 'vitest';
import { accessLine, credentialOf } from './accesslog';

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
		credential: 'token' as const
	};

	it('is one JSON line with the route pattern, never a secret', () => {
		const line = accessLine(entry);
		expect(line).not.toContain('\n');
		expect(JSON.parse(line)).toEqual({ msg: 'request', ...entry });
		expect(line).not.toContain('rbacr_');
	});

	it('cuts a long user agent', () => {
		const { userAgent } = JSON.parse(accessLine({ ...entry, userAgent: 'x'.repeat(5000) }));
		expect(userAgent).toHaveLength(160);
	});
});
