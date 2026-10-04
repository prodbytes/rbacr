// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
declare global {
	namespace App {
		interface Locals {
			/** The signed-in identity's e-mail, or null. */
			email: string | null;
		}
	}
}

export {};
