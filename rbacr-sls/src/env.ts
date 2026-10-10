import { defineEnvVars } from '@sveltejs/kit/env';
import { parseCorsOrigins } from './lib/server/cors';
import { parseAudiences } from './lib/server/idtokens';
import { Allowlist } from './lib/server/identity';
import { DEFAULT_SESSION_RETENTION_DAYS } from './lib/server/session';
import { BOOTSTRAP_TOKEN_RE } from './lib/server/tokens';

const optional = (value: string | undefined) => value || undefined;

/** All configuration is read from RBACR_-prefixed environment variables. */
export const variables = defineEnvVars({
	RBACR_DYNAMODB_TABLE: {
		description: 'The DynamoDB table holding all data (infra/tables.yaml), e.g. rbacr',
		// required, but checked on first use: `vite build` evaluates this file without one
		schema: optional
	},
	RBACR_DYNAMODB_SESSIONS_TABLE: {
		description:
			'The DynamoDB table holding sign-in sessions, which DynamoDB purges by TTL (infra/tables.yaml); default <RBACR_DYNAMODB_TABLE>-sessions',
		schema: optional
	},
	RBACR_SESSION_RETENTION_DAYS: {
		description: 'Whole days a session record is kept after the session expires, then purged by TTL (default 365)',
		// checked here so a bad value stops the app from starting
		schema: (value) => {
			if (!value) return DEFAULT_SESSION_RETENTION_DAYS;
			if (!/^[1-9][0-9]{0,4}$/.test(value)) throw new Error(`must be a whole number of days, 1 or more (got ${value})`);
			return Number(value);
		}
	},
	RBACR_DYNAMODB_ENDPOINT: {
		description:
			'DynamoDB endpoint override for DynamoDB Local, e.g. http://127.0.0.1:8642. The table is created there if missing. Unset in AWS.',
		schema: optional
	},
	RBACR_BOOTSTRAP_TOKEN: {
		description:
			'A fixed API token (rbacr_ and 32+ base64url characters) made a live token of RBACR_BOOTSTRAP_EMAIL when the app first reaches DynamoDB. Only with RBACR_DYNAMODB_ENDPOINT (local development).',
		// checked here so a bad value stops the app from starting
		schema: (value) => {
			if (value && !BOOTSTRAP_TOKEN_RE.test(value)) throw new Error('must be rbacr_ followed by at least 32 base64url characters');
			return value || undefined;
		}
	},
	RBACR_BOOTSTRAP_EMAIL: {
		description: 'The owner of RBACR_BOOTSTRAP_TOKEN; put it in RBACR_ROOT_LIST to make the token a root token',
		schema: optional
	},
	RBACR_ROOT_LIST: {
		description:
			'Comma-separated e-mail addresses and/or domains (example.com or @example.com) that are roots',
		// parsed here so an invalid entry stops the app from starting
		schema: (value) => {
			Allowlist.parse(value);
			return value ?? '';
		}
	},
	RBACR_GOOGLE_CLIENT_ID: { description: 'Google OAuth client id', schema: optional },
	RBACR_GOOGLE_CLIENT_SECRET: { description: 'Google OAuth client secret', schema: optional },
	RBACR_GOOGLE_AUDIENCES: {
		description:
			"Comma-separated Google OAuth client ids whose users' ID tokens /api accepts on its self-service routes (SPEC I1-I5), e.g. an app's web, Android and iOS clients. Empty: ID tokens are refused.",
		// parsed here so an invalid entry stops the app from starting
		schema: (value) => parseAudiences(value).join(',')
	},
	RBACR_CORS_ORIGINS: {
		description:
			'Comma-separated web origins (e.g. https://app.example.com) allowed to call /api from the browser (SPEC H3, H4). Empty: no CORS.',
		// parsed here so an invalid entry stops the app from starting
		schema: (value) => parseCorsOrigins(value).join(',')
	},
	RBACR_PUBLIC_ORIGIN: {
		description:
			'The origin users browse, e.g. https://rbacr.nu01.com. Builds the Google redirect URI; defaults to the request origin.',
		schema: (value) => {
			if (!value) return undefined;
			const url = new URL(value);
			if (url.origin !== value) throw new Error(`must be a bare origin like https://example.com (got ${value})`);
			return value;
		}
	},
	RBACR_ORIGIN_SECRET: {
		description:
			'When set, every request must carry it in the x-rbacr-origin-secret header (added by CloudFront), so the Lambda URL cannot be called directly.',
		schema: optional
	},
	RBACR_STRIPE_WEBHOOK_SECRET: {
		description:
			"Signing secret (whsec_…) of the Stripe webhook endpoint <origin>/webhooks/stripe. With RBACR_STRIPE_API_KEY, turns on the paid-subscription sync.",
		schema: optional
	},
	RBACR_STRIPE_API_KEY: {
		description: 'Restricted Stripe key (rk_…) with read access to Customers and Subscriptions, for the subscription sync',
		schema: optional
	},
	RBACR_VERSION: { description: 'The deployed version, reported by /health', schema: (value) => value || 'dev' },
	RBACR_DEV_LOGIN: {
		description: 'Set to 1 to enable password-less /login/dev. Only honoured by `vite dev`.',
		schema: (value) => value === '1' || value === 'true'
	}
});
