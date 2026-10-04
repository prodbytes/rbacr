import { error, redirect } from '@sveltejs/kit';

/**
 * Client for /uxapi, the frontend's own API (see src/lib/server/uxguard.ts).
 * Pass SvelteKit's `fetch` from load functions, so server-side rendering
 * calls the endpoints internally, or the browser's `fetch` from pages.
 */

export interface Payment {
	code: string;
	systemId: string | null;
	role: string;
	discountPercent: number;
}

export class UxError extends Error {
	constructor(
		readonly status: number,
		message: string,
		readonly payment?: Payment
	) {
		super(message);
	}
}

export async function uxFetch<T = unknown>(
	fetchFn: typeof fetch,
	path: string,
	init: { method?: string; body?: unknown } = {}
): Promise<T> {
	const res = await fetchFn(`/uxapi${path}`, {
		method: init.method ?? 'GET',
		headers: {
			'x-rbacr-ux': '1',
			...(init.body !== undefined && { 'content-type': 'application/json' })
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body)
	});
	if (res.status === 204) return undefined as T;
	const data = await res.json().catch(() => ({}));
	if (!res.ok) throw new UxError(res.status, data.error ?? res.statusText, data.payment);
	return data as T;
}

/** For load functions: not signed in goes to the sign-in page, other failures to the error page. */
export async function uxLoad<T>(fetchFn: typeof fetch, path: string): Promise<T> {
	try {
		return await uxFetch<T>(fetchFn, path);
	} catch (err) {
		if (err instanceof UxError) {
			if (err.status === 401) redirect(303, '/');
			error(err.status, err.message);
		}
		throw err;
	}
}

/** A submitted form's fields, with the default submission prevented. */
export function formValues(event: SubmitEvent): Record<string, string> {
	event.preventDefault();
	const form = event.currentTarget as HTMLFormElement;
	return Object.fromEntries([...new FormData(form)].map(([k, v]) => [k, String(v)]));
}

/** <input type="datetime-local"> has no zone; the UI labels these fields as UTC. */
export function utcIso(value: string | undefined): string | null {
	return value ? `${value}:00Z` : null;
}

export function formatDate(iso: string | null): string {
	return iso ? iso.slice(0, 16).replace('T', ' ') + ' UTC' : '—';
}
