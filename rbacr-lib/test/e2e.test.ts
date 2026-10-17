// Against a real rbacr: RBACR_E2E_URL (e.g. the rbacr-local image,
// http://localhost:8686) and RBACR_E2E_TOKEN, a root's token (rbacr-local's
// RBACR_TOKEN is one). Skipped without them. Made-up addresses only.
import { describe, expect, it } from 'vitest';
import { RbacrClient } from '../src/index.js';

const url = process.env.RBACR_E2E_URL;
const token = process.env.RBACR_E2E_TOKEN;

describe.skipIf(!url || !token)('rbacr-lib against rbacr', () => {
  const system = `e2e-${Date.now().toString(36)}`;
  const raw = (method: string, path: string, body?: unknown) =>
    fetch(`${url}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  it('checks, lists and grants roles with an end, and revokes them', async () => {
    expect((await raw('POST', '/api/systems', { id: system, roles: ['member', 'boss'] })).status).toBe(201);
    expect((await raw('PUT', `/api/systems/${system}/roles/boss`, { implies: ['member'] })).ok).toBe(true);
    const c = new RbacrClient({ url, token, cacheMs: 0 });

    expect(await c.allows('ada@example.com', system, 'member')).toBe(false);
    const endsAt = new Date(Date.now() + 3_600_000).toISOString();
    await c.grant({ systemId: system, role: 'member', grantee: 'Ada@Example.com', endsAt });
    // rbacr's role index is eventually consistent (about a second, D3).
    await new Promise((r) => setTimeout(r, 1500));
    const check = await c.check('ada@example.com', system, 'member');
    expect(check.allowed).toBe(true);
    expect(check.ttl).toBeGreaterThan(3500);
    expect(await c.holders(system, 'member')).toEqual(new Set(['ada@example.com']));

    await c.grant({ systemId: system, role: 'boss', grantee: 'ben@example.com' });
    await new Promise((r) => setTimeout(r, 1500));
    expect(await c.rolesOf('ben@example.com', system)).toEqual(['boss', 'member']);

    expect(await c.revoke({ systemId: system, role: 'member', grantee: 'ada@example.com' })).toBe(true);
    expect(await c.revoke({ systemId: system, role: 'member', grantee: 'ada@example.com' })).toBe(false);
    await new Promise((r) => setTimeout(r, 1500));
    expect(await c.allows('ada@example.com', system, 'member')).toBe(false);
    await raw('DELETE', `/api/systems/${system}`);
  }, 30_000);
});
