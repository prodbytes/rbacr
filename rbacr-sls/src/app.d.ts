// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			/**
			 * The authenticated identity's e-mail, or null: from the session cookie
			 * outside /api, from the personal API token or an app's ID token on /api.
			 */
			email: string | null;
			/** On /api: authenticated by an application's ID token (SPEC I1, I7), so limited to I4. */
			app: boolean;
			/** With `app`: the only systems its issuer reaches (SPEC I10); null for every system. */
			appSystems: readonly string[] | null;
		}
	}
}

export {};
