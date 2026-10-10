// Smoke test for the packaged Lambda: invokes lambda.js (the deployed entrypoint)
// with Lambda function URL events (payload v2, as CloudFront forwards them)
// against the production build.
// Run `npm run build` first. Only exercises routes that need no DynamoDB.
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { before, describe, it } from 'node:test';

process.env.RBACR_DYNAMODB_TABLE = 'unused';
process.env.RBACR_ROOT_LIST = 'example.com';
process.env.RBACR_GOOGLE_CLIENT_ID = 'test-client-id';
process.env.RBACR_GOOGLE_CLIENT_SECRET = 'test-client-secret';
process.env.RBACR_DEV_LOGIN = '1'; // must be ignored by production builds
process.env.RBACR_PUBLIC_ORIGIN = 'https://rbacr.example.com';
process.env.RBACR_ORIGIN_SECRET = 'test-origin-secret';
process.env.RBACR_VERSION = '1.2.3-RC';
process.env.RBACR_STRIPE_WEBHOOK_SECRET = 'whsec_test';
process.env.RBACR_STRIPE_API_KEY = 'rk_test_unused';
// The Lambda sees the function URL's Host; CloudFront sends the site's host in
// x-rbacr-host (an origin custom header), which adapter-node reads.
process.env.HOST_HEADER = 'x-rbacr-host';
const FROM_CLOUDFRONT = { 'x-rbacr-origin-secret': 'test-origin-secret', 'x-rbacr-host': 'rbacr.example.com' };

let handler;
before(async () => {
	({ handler } = await import('../lambda.js'));
});

async function invoke(target, { method = 'GET', headers = {}, body: requestBody, viaCloudFront = true } = {}) {
	const [path, query = ''] = target.split('?');
	const event = {
		version: '2.0',
		routeKey: '$default',
		rawPath: path,
		rawQueryString: query,
		headers: {
			host: 'abc123.lambda-url.us-east-1.on.aws',
			'x-forwarded-proto': 'https',
			...(viaCloudFront && FROM_CLOUDFRONT),
			...headers
		},
		requestContext: {
			http: { method, path, protocol: 'HTTP/1.1', sourceIp: '203.0.113.1', userAgent: 'test' },
			requestId: 'test',
			stage: '$default'
		},
		...(requestBody !== undefined && { body: requestBody }),
		isBase64Encoded: false
	};
	const res = await handler(event, {});
	const body = res.isBase64Encoded ? Buffer.from(res.body, 'base64').toString('utf8') : res.body;
	return { ...res, body };
}

describe('lambda handler', () => {
	it('serves the JSON health check, outside /api, with the deployed version', async () => {
		const res = await invoke('/health');
		assert.equal(res.statusCode, 200);
		assert.equal(res.headers['cache-control'], 'no-store');
		assert.deepEqual(JSON.parse(res.body), { ok: true, version: '1.2.3-RC', checks: { google: 'ok' } });
	});

	it('refuses requests that bypass CloudFront', async () => {
		for (const headers of [{}, { 'x-rbacr-origin-secret': 'wrong' }]) {
			const res = await invoke('/health', { viaCloudFront: false, headers });
			assert.equal(res.statusCode, 403);
		}
	});

	it('renders the sign-in page as HTML', async () => {
		const res = await invoke('/', { headers: { accept: 'text/html' } });
		assert.equal(res.statusCode, 200);
		assert.match(res.headers['content-type'], /text\/html/);
		assert.match(res.body, /Sign in with Google/);
		assert.doesNotMatch(res.body, /Development sign-in/);
	});

	it('requires an API token on /api, ignoring session cookies', async () => {
		for (const headers of [{}, { cookie: 'rbacr_session=anything' }, { authorization: 'Basic abc' }]) {
			const res = await invoke('/api/me', { headers: { accept: 'application/json', ...headers } });
			assert.equal(res.statusCode, 401);
			assert.equal(res.headers['www-authenticate'], 'Bearer');
			assert.deepEqual(JSON.parse(res.body), { error: 'A valid API token is required' });
		}
		const res = await invoke('/api/check', { method: 'POST', headers: { 'content-type': 'application/json' } });
		assert.equal(res.statusCode, 401);
	});

	it('refuses every /api path without a token, unknown ones included', async () => {
		for (const path of ['/api', '/api/health', '/api/nope', '/api/systems/x/roles/y']) {
			const res = await invoke(path);
			assert.equal(res.statusCode, 401, path);
			assert.equal(res.headers['cache-control'], 'no-store');
		}
	});

	it('lets API clients write without an Origin, body-less DELETEs included (H2)', async () => {
		for (const path of ['/api/vouchers/ABCD-EFGH-JKLM-NPQR', '/api/systems/x', '/api/systems/x/roles/y']) {
			const res = await invoke(path, { method: 'DELETE' });
			assert.equal(res.statusCode, 401, path); // the token check, not the CSRF check
		}
	});

	it('refuses cross-site form submissions outside /api (H2)', async () => {
		for (const headers of [{}, { origin: 'https://evil.example' }, { 'content-type': 'application/x-www-form-urlencoded' }]) {
			const res = await invoke('/logout', { method: 'POST', headers });
			assert.equal(res.statusCode, 403, JSON.stringify(headers));
			assert.match(res.body, /Cross-site POST form submissions are forbidden/);
		}
		const own = await invoke('/logout', { method: 'POST', headers: { origin: 'https://rbacr.example.com' } });
		assert.notEqual(own.statusCode, 403);
	});

	it('refuses /vpi calls that do not come from the frontend', async () => {
		const attempts = [
			{},
			{ 'x-rbacr-vpi': '1' },
			{ 'x-rbacr-vpi': '1', 'sec-fetch-site': 'cross-site' },
			{ 'sec-fetch-site': 'same-origin' }
		];
		for (const headers of attempts) {
			const res = await invoke('/vpi/session', { headers });
			assert.equal(res.statusCode, 403, JSON.stringify(headers));
			assert.match(JSON.parse(res.body).error, /only for the rbacr frontend/);
		}
		const write = await invoke('/vpi/me/redeem', {
			method: 'POST',
			headers: { 'x-rbacr-vpi': '1', 'sec-fetch-site': 'same-origin', origin: 'https://evil.example', 'content-type': 'application/json' }
		});
		assert.equal(write.statusCode, 403);
	});

	it('serves /vpi to the frontend', async () => {
		const headers = { 'x-rbacr-vpi': '1', 'sec-fetch-site': 'same-origin' };
		const session = await invoke('/vpi/session', { headers });
		assert.equal(session.statusCode, 200);
		assert.equal(session.headers['cache-control'], 'no-store');
		assert.deepEqual(JSON.parse(session.body), { user: null, devLogin: false });
		const me = await invoke('/vpi/me', { headers });
		assert.equal(me.statusCode, 401);
		assert.deepEqual(JSON.parse(me.body), { error: 'Not signed in' });
	});

	it('redirects anonymous page visits to sign-in', async () => {
		const res = await invoke('/systems', { headers: { accept: 'text/html' } });
		assert.equal(res.statusCode, 303);
		assert.equal(res.headers.location, '/');
	});

	it('starts Google sign-in with the public origin as redirect URI', async () => {
		const res = await invoke('/login/google');
		assert.equal(res.statusCode, 302);
		const url = new URL(res.headers.location);
		assert.equal(url.hostname, 'accounts.google.com');
		assert.equal(
			url.searchParams.get('redirect_uri'),
			'https://rbacr.example.com/login/google/callback'
		);
		const cookie = [].concat(res.multiValueHeaders?.['set-cookie'] ?? res.cookies ?? res.headers['set-cookie']).join();
		assert.match(cookie, /rbacr_oauth=.*HttpOnly/i);
		assert.match(cookie, /Secure/);
	});

	it('does not expose the dev login in production builds', async () => {
		const res = await invoke('/login/dev', { headers: { accept: 'text/html' } });
		assert.equal(res.statusCode, 404);
	});

	it('accepts same-site form submissions arriving on the function URL host', async () => {
		const res = await invoke('/logout', {
			method: 'POST',
			headers: { origin: 'https://rbacr.example.com', 'content-type': 'application/x-www-form-urlencoded' }
		});
		assert.equal(res.statusCode, 303); // past the CSRF check: signed out, back to sign-in
		assert.equal(res.headers.location, '/');
	});

	it('rejects cross-site form submissions (CSRF)', async () => {
		const res = await invoke('/logout', {
			method: 'POST',
			headers: { origin: 'https://evil.example', 'content-type': 'application/x-www-form-urlencoded' }
		});
		assert.equal(res.statusCode, 403);
		assert.match(res.body, /Cross-site POST form submissions are forbidden/);
	});

	it('takes Stripe webhooks outside both APIs, checking their signature', async () => {
		const body = JSON.stringify({ id: 'evt_1', type: 'invoice.paid', data: { object: {} } });
		const t = Math.floor(Date.now() / 1000);
		const v1 = createHmac('sha256', 'whsec_test').update(`${t}.${body}`).digest('hex');
		const post = (signature) =>
			invoke('/webhooks/stripe', {
				method: 'POST',
				headers: { 'content-type': 'application/json', 'stripe-signature': signature },
				body
			});
		const forged = await post(`t=${t},v1=${'0'.repeat(64)}`);
		assert.equal(forged.statusCode, 400);
		const signed = await post(`t=${t},v1=${v1}`);
		assert.equal(signed.statusCode, 200);
		assert.deepEqual(JSON.parse(signed.body), { received: true, ignored: 'invoice.paid' });
	});

	it('serves static client assets', async () => {
		const asset = readdirSync('build/client/_app/immutable/entry').find((f) => f.endsWith('.js'));
		const res = await invoke(`/_app/immutable/entry/${asset}`);
		assert.equal(res.statusCode, 200);
		assert.match(res.headers['content-type'], /javascript/);
		assert.match(res.headers['cache-control'], /immutable/);
	});
});
