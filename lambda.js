// AWS Lambda entrypoint: adapts function URL events (payload v2, from CloudFront;
// see infra/app.yaml) to the adapter-node request handler, which serves both
// static assets and SvelteKit routes.
import serverless from 'serverless-http';
import { handler as app } from './build/handler.js';

// Every response body is base64-encoded so precompressed (.br/.gz) assets and
// images survive intact; the function URL decodes it for the client.
export const handler = serverless(
	(req, res) => {
		// serverless-http constructs its response with a `{ method }` stub as `res.req`;
		// adapter-node drains `res.req` after responding, so point it at the real request.
		res.req = req;
		app(req, res);
	},
	{ binary: true }
);
