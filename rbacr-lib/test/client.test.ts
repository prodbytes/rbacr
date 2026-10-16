import { describe, expect, it } from 'vitest';
import { RbacrClient, RbacrError } from '../src/index.js';

interface Asked {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}

/** rbacr faked: answers by "METHOD path", recording what was asked. */
function fake(answers: Record<string, (body: any) => [number, unknown]>) {
  const asked: Asked[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    asked.push({ method: String(init.method), url: String(url), auth: new Headers(init.headers).get('authorization'), body });
    const answer = answers[`${init.method} ${path}`];
    if (!answer) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 });
    const [status, json] = answer(body);
    return new Response(status === 204 ? null : JSON.stringify(json), { status });
  }) as typeof fetch;
  return { asked, fetchFn };
}

describe('rbacr-lib', () => {
  it('takes RBACR_URL and RBACR_TOKEN, refuses plain http but for localhost', async () => {
    const { asked, fetchFn } = fake({ 'GET /api/me': () => [200, { email: 'a@example.com', root: false, globalRoles: [], roles: {} }] });
    process.env.RBACR_URL = 'https://rbacr.example.com/';
    process.env.RBACR_TOKEN = 'rbacr_made_up';
    try {
      const c = new RbacrClient({ fetch: fetchFn });
      expect(c.url).toBe('https://rbacr.example.com');
      await c.me();
      expect(asked[0]).toMatchObject({ method: 'GET', url: 'https://rbacr.example.com/api/me', auth: 'Bearer rbacr_made_up' });
    } finally {
      delete process.env.RBACR_URL;
      delete process.env.RBACR_TOKEN;
    }
    expect(() => new RbacrClient({ url: 'http://rbacr.example.com' })).toThrow(/https/);
    expect(new RbacrClient({ url: 'http://localhost:8686' }).url).toBe('http://localhost:8686');
    // A local server in Docker reaching rbacr on its host.
    expect(new RbacrClient({ url: 'http://host.docker.internal:2115' }).url).toBe('http://host.docker.internal:2115');
    expect(new RbacrClient({ url: 'http://rbacr.localhost' }).url).toBe('http://rbacr.localhost');
    expect(() => new RbacrClient({ url: 'http://localhost.example.com' })).toThrow(/https/);
    await expect(new RbacrClient({ url: 'https://r.example.com', token: '', fetch: fetchFn }).me()).rejects.toMatchObject({ status: 401 });
  });

  it('allows: kept for cacheMs, a yes never past its ttl, errors never; fails closed', async () => {
    let now = 0;
    let allowed = true;
    let ttl: number | null = 30;
    let down = false;
    const { asked, fetchFn } = fake({
      'POST /api/check': (b) => (down ? [503, { error: 'down' }] : [200, { ...b, allowed, expiresAt: null, ttl: allowed ? ttl : null }]),
    });
    const c = new RbacrClient({ url: 'https://r.example.com', token: 't', fetch: fetchFn, clock: () => now });
    expect(await c.allows('Ada@Example.com', 'grigri', 'premium')).toBe(true);
    expect(asked[0]!.body).toEqual({ email: 'ada@example.com', systemId: 'grigri', role: 'premium' });
    now = 29_000;
    expect(await c.allows('ada@example.com', 'grigri', 'premium')).toBe(true);
    expect(asked).toHaveLength(1);
    // The grant's ttl (30 s) ends the kept yes before cacheMs (60 s).
    now = 31_000;
    allowed = false;
    expect(await c.allows('ada@example.com', 'grigri', 'premium')).toBe(false);
    expect(asked).toHaveLength(2);
    // Down: no, and not kept.
    down = true;
    expect(await c.allows('ben@example.com', 'grigri', 'premium')).toBe(false);
    down = false;
    allowed = true;
    ttl = null;
    expect(await c.allows('ben@example.com', 'grigri', 'premium')).toBe(true);
    // fresh asks again.
    expect(await c.allows('ben@example.com', 'grigri', 'premium', { fresh: true })).toBe(true);
    expect(asked).toHaveLength(5);
  });

  it("rolesOf: the system's roles plus global ones, kept; null when rbacr can't say", async () => {
    let down = false;
    const { asked, fetchFn } = fake({
      'POST /api/roles': () => (down ? [500, {}] : [200, { email: 'a@example.com', globalRoles: ['root'], roles: { grigri: ['premium', 'admin'], other: ['x'] } }]),
    });
    let now = 0;
    const c = new RbacrClient({ url: 'https://r.example.com', token: 't', fetch: fetchFn, clock: () => now });
    expect(await c.rolesOf('a@example.com', 'grigri')).toEqual(['admin', 'premium', 'root']);
    expect(await c.rolesOf('A@example.com', 'grigri')).toEqual(['admin', 'premium', 'root']);
    expect(asked).toHaveLength(1);
    now = 61_000;
    down = true;
    expect(await c.rolesOf('a@example.com', 'grigri')).toBeNull();
  });

  it('grants, revokes and lists holders (roots); its own changes drop what it kept', async () => {
    const grants: { role: string; grantee: string; status: string; endsAt: string | null }[] = [];
    const { asked, fetchFn } = fake({
      'GET /api/systems/grigri/grants': () => [200, { grants }],
      'POST /api/systems/grigri/grants': (b) => {
        grants.push({ role: b.role, grantee: b.grantee, status: 'active', endsAt: b.endsAt ?? null });
        return [201, { systemId: 'grigri', ...b, status: 'active' }];
      },
      'DELETE /api/systems/grigri/grants': (b) => {
        const i = grants.findIndex((g) => g.role === b.role && g.grantee === b.grantee);
        if (i < 0) return [404, { error: 'no such grant' }];
        grants.splice(i, 1);
        return [204, null];
      },
      'POST /api/roles': () => [200, { email: 'ada@example.com', globalRoles: [], roles: { grigri: grants.filter((g) => g.grantee === 'ada@example.com').map((g) => g.role) } }],
    });
    const c = new RbacrClient({ url: 'https://r.example.com', token: 't', fetch: fetchFn });
    expect(await c.holders('grigri', 'blocked')).toEqual(new Set());
    expect(await c.rolesOf('ada@example.com', 'grigri')).toEqual([]);
    const g = await c.grant({ systemId: 'grigri', role: 'blocked', grantee: 'Ada@Example.com', endsAt: '2030-01-01T00:00:00.000Z' });
    expect(g.grantee).toBe('ada@example.com');
    expect(asked.at(-1)!.body).toEqual({ role: 'blocked', grantee: 'ada@example.com', endsAt: '2030-01-01T00:00:00.000Z' });
    // Dropped: the next asks see the grant.
    expect(await c.holders('grigri', 'blocked')).toEqual(new Set(['ada@example.com']));
    expect(await c.rolesOf('ada@example.com', 'grigri')).toEqual(['blocked']);
    expect(await c.revoke({ systemId: 'grigri', role: 'blocked', grantee: 'ada@example.com' })).toBe(true);
    expect(await c.revoke({ systemId: 'grigri', role: 'blocked', grantee: 'ada@example.com' })).toBe(false);
    expect(await c.holders('grigri', 'blocked')).toEqual(new Set());
  });

  it('errors carry the status and rbacr\'s message; unreachable is 0', async () => {
    const { fetchFn } = fake({ 'POST /api/check': () => [403, { error: 'only roots may ask about others' }] });
    const c = new RbacrClient({ url: 'https://r.example.com', token: 't', fetch: fetchFn });
    const e = await c.check('a@example.com', 'grigri', 'admin').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RbacrError);
    expect(e).toMatchObject({ status: 403, message: 'only roots may ask about others' });
    const offline = new RbacrClient({ url: 'https://r.example.com', token: 't', fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    await expect(offline.me()).rejects.toMatchObject({ status: 0 });
  });
});
