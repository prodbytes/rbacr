// rbacr-lib: a TypeScript client for rbacr's external API (/api), for
// servers that ask which roles their users hold (SPEC.md C1-C7) and, with
// a root's token, grant and revoke them. No dependencies: the platform's
// fetch (Node 20+, Deno, Bun, workers).

/** rbacr's sites. */
export const RBACR_PRODUCTION = 'https://rbacr.nu01.com';
export const RBACR_RELEASE_CANDIDATE = 'https://rc.rbacr.nu01.com';
export const RBACR_LOCAL = 'http://localhost:8686';

export interface RbacrOptions {
  /** rbacr's site; default RBACR_URL, else https://rbacr.nu01.com (C7). Plain http only for localhost. */
  url?: string;
  /** A personal API token (`rbacr_…`), or a function giving one; default RBACR_TOKEN (C7). */
  token?: string | (() => string | Promise<string>);
  /** How long answers are kept, in ms (default 60 s; 0: never). A "yes" never outlives its grant's ttl (C3a, C6). */
  cacheMs?: number;
  /** Each request's time limit, in ms (default 5 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
  /** Milliseconds now (tests). */
  clock?: () => number;
}

/** An error answer, or no answer: `status` 0 when rbacr couldn't be reached. */
export class RbacrError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'RbacrError';
  }
}

export interface Me {
  email: string;
  root: boolean;
  globalRoles: string[];
  /** systemId -> roles. */
  roles: Record<string, string[]>;
}

export interface Check {
  email: string;
  systemId: string;
  role: string;
  allowed: boolean;
  /** The latest end among the grants giving the role (null: no end, or no role). */
  expiresAt: string | null;
  /** Seconds until then (null likewise). */
  ttl: number | null;
}

export interface AllRoles {
  email: string;
  globalRoles: string[];
  roles: Record<string, string[]>;
}

export interface SystemStatus {
  id: string;
  name: string;
  url?: string | null;
  maintenance?: boolean;
}

export type GrantStatus = 'active' | 'not-started' | 'expired';

export interface Grant {
  systemId: string;
  role: string;
  /** An address, or a domain as `@example.com`. */
  grantee: string;
  grantedBy: string;
  grantedAt: string;
  startsAt: string | null;
  endsAt: string | null;
  status: GrantStatus;
  voucherCode?: string | null;
  impliedRoles?: string[];
}

export interface GrantInput {
  systemId: string;
  role: string;
  /** An address, or a domain (`example.com` / `@example.com`). */
  grantee: string;
  /** ISO 8601; from now when left out. */
  startsAt?: string;
  /** ISO 8601, exclusive; never when left out. A grant again with another validity replaces it (G2). */
  endsAt?: string;
}

interface Kept<T> {
  value: T;
  until: number;
}

/**
 * A client for one rbacr site and token. Checks and role lists are kept
 * for `cacheMs` (a "yes" no longer than its grant lasts); errors never are
 * (C6). The "fail closed" helpers ({@link allows}, {@link rolesOf})
 * answer "no" / null when rbacr can't; the others throw {@link RbacrError}.
 */
export class RbacrClient {
  readonly url: string;
  private readonly token: () => Promise<string>;
  private readonly cacheMs: number;
  private readonly timeoutMs: number;
  private readonly doFetch: typeof fetch;
  private readonly clock: () => number;
  private readonly checks = new Map<string, Kept<boolean>>();
  private readonly roleLists = new Map<string, Kept<AllRoles>>();
  private readonly holderSets = new Map<string, Kept<Set<string>>>();

  constructor(options: RbacrOptions = {}) {
    const env = typeof process === 'undefined' ? {} : process.env;
    this.url = siteUrl(options.url ?? env.RBACR_URL ?? RBACR_PRODUCTION);
    const token = options.token ?? env.RBACR_TOKEN ?? '';
    this.token = typeof token === 'function' ? async () => (await token()).trim() : async () => token.trim();
    this.cacheMs = options.cacheMs ?? 60_000;
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.doFetch = options.fetch ?? fetch;
    this.clock = options.clock ?? Date.now;
  }

  // --- Asking -----------------------------------------------------------------

  /** `GET /api/me`: the token owner's own roles. */
  me(): Promise<Me> {
    return this.call<Me>('GET', '/api/me');
  }

  /** `POST /api/check`: whether `email` holds `role` in `systemId` now (C3), uncached. */
  check(email: string, systemId: string, role: string): Promise<Check> {
    return this.call<Check>('POST', '/api/check', { email: lower(email), systemId, role });
  }

  /**
   * Whether `email` holds `role` in `systemId`, kept for `cacheMs` (a "yes"
   * no longer than its ttl). Fails closed: an error, or no answer, is
   * false (C6), and isn't kept. `fresh`: ask even when an answer is kept.
   */
  async allows(email: string, systemId: string, role: string, options: { fresh?: boolean } = {}): Promise<boolean> {
    const key = `${lower(email)}\n${systemId}\n${role.toLowerCase()}`;
    const hit = this.checks.get(key);
    if (!options.fresh && hit && hit.until > this.clock()) return hit.value;
    try {
      const answer = await this.check(email, systemId, role);
      const ttlMs = answer.allowed && answer.ttl !== null ? answer.ttl * 1000 : Infinity;
      this.keep(this.checks, key, answer.allowed === true, ttlMs);
      return answer.allowed === true;
    } catch {
      return false;
    }
  }

  /** `POST /api/roles` with a system: `email`'s effective roles in it, sorted (C4), uncached. */
  async roles(email: string, systemId: string): Promise<string[]> {
    const out = await this.call<{ roles: string[] }>('POST', '/api/roles', { email: lower(email), systemId });
    return out.roles;
  }

  /** `POST /api/roles` without a system: every system's roles and the global ones (C4), uncached. */
  allRoles(email: string): Promise<AllRoles> {
    return this.call<AllRoles>('POST', '/api/roles', { email: lower(email) });
  }

  /**
   * `email`'s effective roles in `systemId` plus their global roles
   * (`root`), sorted, without duplicates; kept for `cacheMs`. Null when
   * rbacr can't say (not kept). `fresh`: ask even when an answer is kept.
   */
  async rolesOf(email: string, systemId: string, options: { fresh?: boolean } = {}): Promise<string[] | null> {
    const key = lower(email);
    const hit = this.roleLists.get(key);
    let all = !options.fresh && hit && hit.until > this.clock() ? hit.value : undefined;
    if (!all) {
      try {
        all = await this.allRoles(email);
      } catch {
        return null;
      }
      this.keep(this.roleLists, key, all, Infinity);
    }
    return [...new Set([...(all.roles[systemId] ?? []), ...all.globalRoles])].sort();
  }

  /** `GET /api/systems/:id/status`: the system's name, URL and whether it's in maintenance (R12). */
  systemStatus(systemId: string): Promise<SystemStatus> {
    return this.call<SystemStatus>('GET', `/api/systems/${encodeURIComponent(systemId)}/status`);
  }

  // --- Granting (roots) ----------------------------------------------------------

  /** `GET /api/systems/:id/grants` (roots): the system's live direct grants. */
  async grants(systemId: string): Promise<Grant[]> {
    const out = await this.call<{ grants: Grant[] }>('GET', `/api/systems/${encodeURIComponent(systemId)}/grants`);
    return out.grants;
  }

  /**
   * Whom `role` is granted to now in `systemId`, by address (roots): its
   * active direct grants, not implied holders, global grants or roots.
   * Kept for `cacheMs`, and dropped by this client's own grants and
   * revokes. Errors throw (and aren't kept).
   */
  async holders(systemId: string, role: string, options: { fresh?: boolean } = {}): Promise<Set<string>> {
    const key = `${systemId}\n${role.toLowerCase()}`;
    const hit = this.holderSets.get(key);
    if (!options.fresh && hit && hit.until > this.clock()) return hit.value;
    const grants = await this.grants(systemId);
    const holders = new Set(
      grants.filter((g) => g.role === role.toLowerCase() && g.status === 'active').map((g) => g.grantee.toLowerCase()),
    );
    this.keep(this.holderSets, key, holders, Infinity);
    return holders;
  }

  /** `POST /api/systems/:id/grants` (roots): grants a role (again with another validity: replaces it, G2). */
  async grant(input: GrantInput): Promise<Grant> {
    const { systemId, role, grantee, startsAt, endsAt } = input;
    this.forgetGrantee(systemId, role, grantee);
    return this.call<Grant>('POST', `/api/systems/${encodeURIComponent(systemId)}/grants`, {
      role,
      grantee: lower(grantee),
      ...(startsAt ? { startsAt } : {}),
      ...(endsAt ? { endsAt } : {}),
    });
  }

  /** `DELETE /api/systems/:id/grants` (roots): revokes a grant. False when there was none to revoke. */
  async revoke(input: Pick<GrantInput, 'systemId' | 'role' | 'grantee'>): Promise<boolean> {
    const { systemId, role, grantee } = input;
    this.forgetGrantee(systemId, role, grantee);
    try {
      await this.call('DELETE', `/api/systems/${encodeURIComponent(systemId)}/grants`, { role, grantee: lower(grantee) });
      return true;
    } catch (e) {
      if (e instanceof RbacrError && e.status === 404) return false;
      throw e;
    }
  }

  /** Drops kept answers: about `email`, or all of them. */
  forget(email?: string): void {
    if (email === undefined) {
      this.checks.clear();
      this.roleLists.clear();
      this.holderSets.clear();
      return;
    }
    const key = lower(email);
    this.roleLists.delete(key);
    for (const k of this.checks.keys()) if (k.startsWith(`${key}\n`)) this.checks.delete(k);
  }

  // --- Plumbing --------------------------------------------------------------------

  private forgetGrantee(systemId: string, role: string, grantee: string): void {
    this.holderSets.delete(`${systemId}\n${role.toLowerCase()}`);
    if (grantee.includes('@') && !grantee.startsWith('@')) this.forget(grantee);
    // A domain grant changes everyone's in it: drop every kept answer.
    else {
      this.checks.clear();
      this.roleLists.clear();
    }
  }

  private keep<T>(map: Map<string, Kept<T>>, key: string, value: T, limitMs: number): void {
    const ms = Math.min(this.cacheMs, limitMs);
    if (ms > 0) map.set(key, { value, until: this.clock() + ms });
  }

  private async call<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    const token = await this.token();
    if (!token) throw new RbacrError(401, 'no rbacr token (RBACR_TOKEN)');
    let res: Response;
    try {
      res = await this.doFetch(`${this.url}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new RbacrError(0, `rbacr unreachable: ${String((e as Error)?.message ?? e)}`);
    }
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = undefined;
    }
    if (!res.ok) {
      const message = (json as { error?: unknown } | undefined)?.error;
      throw new RbacrError(res.status, typeof message === 'string' ? message : `rbacr answered ${res.status}`);
    }
    return json as T;
  }
}

function lower(email: string): string {
  return email.trim().toLowerCase();
}

/** The site, without a trailing slash; https, or http for localhost only (C7). */
function siteUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RbacrError(0, `RBACR_URL isn't a URL: ${raw}`);
  }
  const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new RbacrError(0, 'rbacr must be https (plain http only for localhost)');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}
