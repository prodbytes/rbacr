import { defineConfig, type Plugin } from 'vitest/config';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

/**
 * Dev only: Floci (the local CloudFront, floci/README.md) rejects raw `[` and
 * `]` in request paths, which SvelteKit's dynamic routes put in module URLs
 * (/src/routes/systems/[system]/+page.ts). This rewrites the dev server's
 * final JavaScript and HTML responses to reference those paths
 * percent-encoded (vite decodes them). Production chunks have hashed names.
 */
const ROUTE_PATH = /(["'`])(\/src\/routes\/[^"'`\n]*\[[^"'`\n]*)\1/g;
const encodeRouteBrackets: Plugin = {
	name: 'rbacr:encode-route-brackets',
	apply: 'serve',
	configureServer(server) {
		server.middlewares.use((_req, res, next) => {
			const end = res.end.bind(res) as (...args: unknown[]) => typeof res;
			res.end = ((chunk?: unknown, ...rest: unknown[]) => {
				const type = String(res.getHeader('content-type') ?? '');
				if ((typeof chunk === 'string' || Buffer.isBuffer(chunk)) && /javascript|html/.test(type)) {
					const text = chunk.toString();
					if (text.includes('/src/routes/')) {
						const encoded = text.replace(ROUTE_PATH, (_, quote, path: string) =>
							quote + path.replaceAll('[', '%5B').replaceAll(']', '%5D') + quote
						);
						if (res.getHeader('content-length')) res.setHeader('content-length', Buffer.byteLength(encoded));
						return end(encoded, ...rest);
					}
				}
				return end(chunk, ...rest);
			}) as typeof res.end;
			next();
		});
	}
};

// Behind Floci, the HMR WebSocket (which Floci can't carry) goes straight to
// the dev server: process-compose sets RBACR_HMR_HOST (a *.localhost name, so
// a ws:// socket is allowed from the https:// page).
const hmrHost = process.env.RBACR_HMR_HOST;
const hmrPort = Number(process.env.RBACR_APP_PORT ?? 5173);

// Vitest gets its own SvelteKit output directory. Otherwise running the tests
// rewrites .svelte-kit/generated/dev/env with the test process's environment,
// and a running dev server hot-reloads it, losing the RBACR_* settings that
// process-compose gave it.
const outDir = process.env.VITEST ? '.svelte-kit-vitest' : '.svelte-kit';

export default defineConfig({
	server: hmrHost ? { hmr: { protocol: 'ws', host: hmrHost, clientPort: hmrPort } } : {},
	plugins: [
		encodeRouteBrackets,
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter(),
			// SvelteKit's CSRF check is off ('*') because it also refused /api
			// clients; hooks.server.ts applies it to everything else (SPEC H2).
			csrf: { trustedOrigins: ['*'] },
			outDir
		})
	],
	test: {
		expect: { requireAssertions: true },
		projects: [
			{
				extends: './vite.config.ts',
				test: {
					name: 'server',
					environment: 'node',
					// DynamoDB Local for the domain tests (a container unless RBACR_TEST_DYNAMODB_ENDPOINT is set).
					globalSetup: ['src/lib/server/testing/setup.ts'],
					testTimeout: 20_000,
					hookTimeout: 30_000,
					include: ['src/**/*.{test,spec}.{js,ts}'],
					exclude: ['src/**/*.svelte.{test,spec}.{js,ts}']
				}
			}
		]
	}
});
