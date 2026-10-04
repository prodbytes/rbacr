import { json } from '@sveltejs/kit';
import { RBACR_VERSION } from '$app/env/private';
import type { RequestHandler } from './$types';

/** Liveness probe and deployed version; deliberately does not touch the database. */
export const GET: RequestHandler = () => json({ ok: true, version: RBACR_VERSION });
