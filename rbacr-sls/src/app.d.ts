// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			/**
			 * The authenticated identity's e-mail, or null: from the session cookie
			 * outside /api, from the personal API token or an app's Google ID token on /api.
			 */
			email: string | null;
			/** On /api: authenticated by an application's Google ID token (SPEC I1), so limited to I4. */
			app: boolean;
		}
	}
}

export {};
