import { json } from '@sveltejs/kit';
import { optInt, readJson, str, tokenJson, ux } from '#lib/server/http.js';
import type { RequestHandler } from './$types';

/** The signed-in person's API tokens for /api. */
export const GET: RequestHandler = (event) =>
	ux(event, async ({ tokens, actor }) => ({ tokens: (await tokens.list(actor.email)).map(tokenJson) }));

/** Creates a token; the plain token is in this response only. */
export const POST: RequestHandler = (event) =>
	ux(event, async ({ tokens, actor }) => {
		const body = await readJson(event.request);
		const { token, apiToken } = await tokens.create(actor.email, {
			name: str(body.name, 'name'),
			expiresInDays: optInt(body.expiresInDays, 'expiresInDays')
		});
		return json({ ...tokenJson(apiToken), token }, { status: 201 });
	});
