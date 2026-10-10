import { describe, expect, it } from 'vitest';
import { PREFLIGHT_MAX_AGE, addCorsHeaders, allowedOrigin, isPreflight, parseCorsOrigins, preflight } from './cors';

const ALLOWED = ['https://presence.example.com', 'http://localhost:8080'];
const req = (method: string, headers: Record<string, string> = {}) =>
	new Request('https://rbacr.example.com/api/me', { method, headers });

describe('parseCorsOrigins', () => {
	it('takes comma-separated bare origins', () => {
		expect(parseCorsOrigins(undefined)).toEqual([]);
		expect(parseCorsOrigins(' https://a.example.com, https://b.example.com:8443 ,http://localhost:8080')).toEqual([
			'https://a.example.com',
			'https://b.example.com:8443',
			'http://localhost:8080'
		]);
	});

	it('refuses paths, wildcards, other schemes and junk', () => {
		for (const bad of ['https://a.example.com/', 'https://a.example.com/app', '*', 'null', 'ftp://a.example.com', 'a.example.com', 'https://A.example.com']) {
			expect(() => parseCorsOrigins(bad), bad).toThrow();
		}
	});
});

describe('allowedOrigin', () => {
	it('matches the Origin exactly', () => {
		expect(allowedOrigin(req('GET', { origin: 'https://presence.example.com' }), ALLOWED)).toBe('https://presence.example.com');
		expect(allowedOrigin(req('GET', { origin: 'https://presence.example.com.evil.example' }), ALLOWED)).toBeNull();
		expect(allowedOrigin(req('GET', { origin: 'http://presence.example.com' }), ALLOWED)).toBeNull();
		expect(allowedOrigin(req('GET', { origin: 'null' }), ALLOWED)).toBeNull();
		expect(allowedOrigin(req('GET'), ALLOWED)).toBeNull();
	});
});

describe('addCorsHeaders', () => {
	it('allows the exact origin, never credentials, and always varies on Origin', () => {
		const headers = new Headers({ vary: 'Accept' });
		addCorsHeaders(headers, 'https://presence.example.com');
		expect(headers.get('access-control-allow-origin')).toBe('https://presence.example.com');
		expect(headers.get('access-control-allow-credentials')).toBeNull();
		expect(headers.get('vary')).toBe('Accept, Origin');
		const none = new Headers();
		addCorsHeaders(none, null);
		expect(none.get('access-control-allow-origin')).toBeNull();
		expect(none.get('vary')).toBe('Origin');
	});
});

describe('preflight', () => {
	const ask = (method: string) => req('OPTIONS', { origin: ALLOWED[0], 'access-control-request-method': method });

	it('recognises preflights', () => {
		expect(isPreflight(ask('POST'))).toBe(true);
		expect(isPreflight(req('OPTIONS'))).toBe(false);
		expect(isPreflight(req('GET', { 'access-control-request-method': 'GET' }))).toBe(false);
	});

	it('answers an allowed origin for a method the route takes', () => {
		const res = preflight(ask('POST'), ALLOWED[0], (m) => m === 'POST');
		expect(res.status).toBe(204);
		expect(res.headers.get('access-control-allow-origin')).toBe(ALLOWED[0]);
		expect(res.headers.get('access-control-allow-methods')).toBe('GET, POST');
		expect(res.headers.get('access-control-allow-headers')).toBe('Authorization, Content-Type');
		expect(res.headers.get('access-control-max-age')).toBe(String(PREFLIGHT_MAX_AGE));
		expect(res.headers.get('access-control-allow-credentials')).toBeNull();
		expect(res.headers.get('vary')).toBe('Origin');
	});

	it('refuses other origins and routes without CORS headers', () => {
		for (const res of [preflight(ask('POST'), null, () => true), preflight(ask('DELETE'), ALLOWED[0], (m) => m === 'POST')]) {
			expect(res.status).toBe(403);
			expect(res.headers.get('access-control-allow-origin')).toBeNull();
			expect(res.headers.get('access-control-allow-methods')).toBeNull();
		}
	});
});
