// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			/**
			 * The authenticated identity's e-mail, or null: from the session cookie
			 * outside /api, from the personal API token on /api.
			 */
			email: string | null;
		}
	}
}

export {};
