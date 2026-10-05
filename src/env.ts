import { defineEnvVars } from '@sveltejs/kit/env';
import { Allowlist } from './lib/server/identity';

const optional = (value: string | undefined) => value || undefined;

/** All configuration is read from RBACR_-prefixed environment variables. */
export const variables = defineEnvVars({
	RBACR_DYNAMODB_TABLE: {
		description: 'The DynamoDB table holding all data (infra/tables.yaml), e.g. rbacr',
		// required, but checked on first use: `vite build` evaluates this file without one
		schema: optional
	},
	RBACR_DYNAMODB_ENDPOINT: {
		description:
			'DynamoDB endpoint override for DynamoDB Local, e.g. http://127.0.0.1:8642. The table is created there if missing. Unset in AWS.',
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
	RBACR_VERSION: { description: 'The deployed version, reported by /health', schema: (value) => value || 'dev' },
	RBACR_DEV_LOGIN: {
		description: 'Set to 1 to enable password-less /login/dev. Only honoured by `vite dev`.',
		schema: (value) => value === '1' || value === 'true'
	}
});
