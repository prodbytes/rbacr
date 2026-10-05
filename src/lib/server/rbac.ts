import type { Db } from './db';
import { Allowlist, granteesFor, isDomainGrantee, normalizeEmail, parseGrantee } from './identity';

/** The per-system role that lets an identity manage that system's grants and vouchers. */
export const ADMIN_ROLE = 'admin';

/** The single global (system-independent) role held by every identity on RBACR_ROOT_LIST. */
export const ROOT_ROLE = 'root';

const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,62}$/;

/** Terms of a voucher that needs payment (a discount under 100%). */
export interface PaymentRequired {
	code: string;
	systemId: string | null;
	role: string;
	discountPercent: number;
}

export class RbacError extends Error {
	constructor(
		readonly status: 400 | 402 | 403 | 404 | 409,
		message: string,
		/** Extra fields for the error response. */
		readonly details?: { payment?: PaymentRequired }
	) {
		super(message);
	}
}

const forbidden = (message = 'Forbidden') => new RbacError(403, message);
const badRequest = (message: string) => new RbacError(400, message);
const notFound = (message: string) => new RbacError(404, message);

export interface Actor {
	email: string;
	root: boolean;
	/** System ids where the actor holds the admin role (empty for roots, who manage everything). */
	adminOf: string[];
}

/** Effective roles keyed by system id, each list sorted. */
export type RoleMap = Record<string, string[]>;

export interface System {
	id: string;
	name: string;
	roles: string[];
	/** Direct implications: holding the key role also gives these roles (transitively). Roles implying nothing are left out. */
	implies: Record<string, string[]>;
}

/** A grant; systemId null is a global grant (the role in every system that defines it). */
export interface Grant {
	systemId: string | null;
	role: string;
	grantee: string;
	grantedBy: string;
	grantedAt: Date;
	voucherCode: string | null;
}

/** A voucher; systemId null is a global voucher (redeeming it makes a global grant). */
export interface Voucher {
	code: string;
	systemId: string | null;
	role: string;
	/** 100 grants the role on redemption; anything lower requires payment (not available yet). */
	discountPercent: number;
	startsAt: Date | null;
	endsAt: Date | null;
	maxUses: number | null;
	uses: number;
	createdBy: string;
	createdAt: Date;
	disabledAt: Date | null;
}

export interface VoucherInput {
	/** null for a global voucher (roots only). */
	systemId: string | null;
	role: string;
	/** 0-100, default 100. */
	discountPercent?: number | null;
	startsAt?: Date | null;
	endsAt?: Date | null;
	maxUses?: number | null;
}

export type VoucherStatus = 'active' | 'disabled' | 'not-started' | 'expired' | 'exhausted';

export function voucherStatus(v: Voucher, now: Date): VoucherStatus {
	if (v.disabledAt) return 'disabled';
	if (v.startsAt && v.startsAt > now) return 'not-started';
	if (v.endsAt && v.endsAt <= now) return 'expired';
	if (v.maxUses !== null && v.uses >= v.maxUses) return 'exhausted';
	return 'active';
}

export function validName(kind: string, raw: string): string {
	const name = raw.trim().toLowerCase();
	if (!NAME_RE.test(name)) {
		throw badRequest(
			`Invalid ${kind} "${raw}": use 1-63 lowercase letters, digits, '_', '.', ':' or '-', starting with a letter or digit`
		);
	}
	// "root" is the global role; a system role of that name would be ambiguous.
	if (kind === 'role' && name === ROOT_ROLE) throw badRequest(`"${ROOT_ROLE}" is reserved for the global root role`);
	return name;
}

/** Whether the actor may manage (view grants, create vouchers for) a system. */
export function canManageSystem(actor: Actor, systemId: string): boolean {
	return actor.root || actor.adminOf.includes(systemId);
}

/**
 * Whether the actor may hand out `role` on `systemId` (null: globally) to
 * `grantee`, directly or through a voucher (pass grantee = null for
 * vouchers). Only roots may assign globally, assign the admin role or grant
 * to whole domains.
 */
export function canAssign(actor: Actor, systemId: string | null, role: string, grantee: string | null): boolean {
	if (actor.root) return true;
	if (systemId === null || !actor.adminOf.includes(systemId)) return false;
	if (role === ADMIN_ROLE) return false;
	if (grantee !== null && isDomainGrantee(grantee)) return false;
	return true;
}

const VOUCHER_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 symbols, no 0/O/1/I

export function generateVoucherCode(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(16));
	const chars = Array.from(bytes, (b) => VOUCHER_ALPHABET[b & 31]).join('');
	return chars.match(/.{4}/g)!.join('-');
}

export function normalizeVoucherCode(raw: string): string {
	const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
	return chars.match(/.{1,4}/g)?.join('-') ?? '';
}

type GrantRow = {
	system_id: string | null;
	role: string;
	grantee: string;
	granted_by: string;
	granted_at: Date;
	voucher_code: string | null;
};

type VoucherRow = {
	code: string;
	system_id: string | null;
	role: string;
	discount_percent: number;
	starts_at: Date | null;
	ends_at: Date | null;
	max_uses: number | null;
	uses: number;
	created_by: string;
	created_at: Date;
	disabled_at: Date | null;
};

const toGrant = (r: GrantRow): Grant => ({
	systemId: r.system_id,
	role: r.role,
	grantee: r.grantee,
	grantedBy: r.granted_by,
	grantedAt: new Date(r.granted_at),
	voucherCode: r.voucher_code
});

const toVoucher = (r: VoucherRow): Voucher => ({
	code: r.code,
	systemId: r.system_id,
	role: r.role,
	discountPercent: r.discount_percent,
	startsAt: r.starts_at && new Date(r.starts_at),
	endsAt: r.ends_at && new Date(r.ends_at),
	maxUses: r.max_uses,
	uses: r.uses,
	createdBy: r.created_by,
	createdAt: new Date(r.created_at),
	disabledAt: r.disabled_at && new Date(r.disabled_at)
});

export class Rbac {
	constructor(
		private readonly db: Db,
		private readonly roots: Allowlist,
		private readonly now: () => Date = () => new Date()
	) {}

	isRoot(email: string): boolean {
		return this.roots.includes(email);
	}

	async actor(email: string): Promise<Actor> {
		const root = this.isRoot(email);
		if (root) return { email, root, adminOf: [] };
		const roles = await this.grantedRoles(email);
		const adminOf = Object.keys(roles).filter((s) => roles[s].includes(ADMIN_ROLE));
		return { email, root, adminOf };
	}

	/**
	 * System-independent roles: ["root"] for identities on the root list,
	 * otherwise the roles of their (and their domain's) global grants.
	 */
	async globalRolesOf(email: string): Promise<string[]> {
		if (this.isRoot(email)) return [ROOT_ROLE];
		const rows = await this.db.query<{ role: string }>(
			'SELECT DISTINCT role FROM global_grants WHERE grantee = ANY($1) ORDER BY role',
			[granteesFor(email)]
		);
		return rows.map((r) => r.role);
	}

	/**
	 * Roles an identity holds: everything for roots, otherwise its own and its
	 * domain's grants plus the roles those imply.
	 */
	async rolesOf(email: string): Promise<RoleMap> {
		if (!this.isRoot(email)) return this.grantedRoles(email);
		const systems = await this.allSystems();
		return Object.fromEntries(systems.map((s) => [s.id, s.roles]));
	}

	private async grantedRoles(email: string): Promise<RoleMap> {
		// Direct grants, plus global grants in every system whose catalog has the
		// role, then everything those roles imply in their system (transitively).
		const rows = await this.db.query<{ system_id: string; role: string }>(
			`WITH RECURSIVE held (system_id, role) AS (
				SELECT * FROM (
					SELECT system_id, role FROM grants WHERE grantee = ANY($1)
					UNION
					SELECT r.system_id, r.name FROM global_grants g JOIN roles r ON r.name = g.role
					WHERE g.grantee = ANY($1)
				) direct
				UNION
				SELECT i.system_id, i.implies FROM held h
				JOIN role_implications i ON i.system_id = h.system_id AND i.role = h.role
			 )
			 SELECT system_id, role FROM held ORDER BY system_id, role`,
			[granteesFor(email)]
		);
		const map: RoleMap = {};
		for (const r of rows) (map[r.system_id] ??= []).push(r.role);
		return map;
	}

	// --- systems & role catalog -------------------------------------------

	private async allSystems(ids?: string[]): Promise<System[]> {
		const rows = await this.db.query<{ id: string; name: string; roles: string[] | null }>(
			`SELECT s.id, s.name, array_remove(array_agg(r.name ORDER BY r.name), NULL) AS roles
			 FROM systems s LEFT JOIN roles r ON r.system_id = s.id
			 WHERE $1::text[] IS NULL OR s.id = ANY($1)
			 GROUP BY s.id, s.name ORDER BY s.id`,
			[ids ?? null]
		);
		const edges = await this.db.query<{ system_id: string; role: string; implies: string }>(
			`SELECT system_id, role, implies FROM role_implications
			 WHERE $1::text[] IS NULL OR system_id = ANY($1) ORDER BY system_id, role, implies`,
			[ids ?? null]
		);
		const implies: Record<string, Record<string, string[]>> = {};
		for (const e of edges) ((implies[e.system_id] ??= {})[e.role] ??= []).push(e.implies);
		return rows.map((r) => ({ id: r.id, name: r.name, roles: r.roles ?? [], implies: implies[r.id] ?? {} }));
	}

	/** Systems the actor can manage: all for roots, administered ones for admins. */
	async listSystems(actor: Actor): Promise<System[]> {
		if (actor.root) return this.allSystems();
		if (!actor.adminOf.length) return [];
		return this.allSystems(actor.adminOf);
	}

	async getSystem(actor: Actor, systemId: string): Promise<System> {
		if (!canManageSystem(actor, systemId)) throw forbidden();
		const [system] = await this.allSystems([systemId]);
		if (!system) throw notFound(`System "${systemId}" not found`);
		return system;
	}

	async createSystem(actor: Actor, input: { id: string; name?: string; roles?: string[] }): Promise<System> {
		if (!actor.root) throw forbidden('Only roots can create systems');
		const id = validName('system id', input.id);
		const name = input.name?.trim() || id;
		const roles = new Set([ADMIN_ROLE, ...(input.roles ?? []).map((r) => validName('role', r))]);
		return this.db.transaction(async (tx) => {
			const inserted = await tx.query(
				'INSERT INTO systems (id, name, created_by) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING id',
				[id, name, actor.email]
			);
			if (!inserted.length) throw new RbacError(409, `System "${id}" already exists`);
			for (const role of roles) {
				await tx.query('INSERT INTO roles (system_id, name) VALUES ($1, $2)', [id, role]);
			}
			return { id, name, roles: [...roles].sort(), implies: {} };
		});
	}

	async deleteSystem(actor: Actor, systemId: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can delete systems');
		const rows = await this.db.query('DELETE FROM systems WHERE id = $1 RETURNING id', [systemId]);
		if (!rows.length) throw notFound(`System "${systemId}" not found`);
	}

	async addRole(actor: Actor, systemId: string, rawRole: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can define roles');
		const role = validName('role', rawRole);
		await this.getSystem(actor, systemId);
		const rows = await this.db.query(
			'INSERT INTO roles (system_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING name',
			[systemId, role]
		);
		if (!rows.length) throw new RbacError(409, `Role "${role}" already exists`);
	}

	/** Removes a role from the catalog, along with its grants and vouchers. */
	async removeRole(actor: Actor, systemId: string, role: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can remove roles');
		if (role === ADMIN_ROLE) throw badRequest('The admin role cannot be removed');
		const rows = await this.db.query(
			'DELETE FROM roles WHERE system_id = $1 AND name = $2 RETURNING name',
			[systemId, role]
		);
		if (!rows.length) throw notFound(`Role "${role}" not found in "${systemId}"`);
	}

	/**
	 * Sets the roles that `role` directly implies in a system, replacing the
	 * previous ones. Implications are transitive. Nothing may imply the admin
	 * role (admins could otherwise hand it out), and cycles are refused.
	 */
	async setImplications(actor: Actor, systemId: string, rawRole: string, rawImplies: string[]): Promise<System> {
		if (!actor.root) throw forbidden('Only roots can change role implications');
		const role = rawRole.trim().toLowerCase();
		const implies = [...new Set(rawImplies.map((r) => r.trim().toLowerCase()))].sort();
		await this.db.transaction(async (tx) => {
			// Lock the system so concurrent edits can't combine into a cycle.
			const locked = await tx.query('SELECT 1 FROM systems WHERE id = $1 FOR UPDATE', [systemId]);
			if (!locked.length) throw notFound(`System "${systemId}" not found`);
			await this.requireRole(tx, systemId, role);
			for (const r of implies) {
				if (r === role) throw badRequest(`A role cannot imply itself`);
				if (r === ADMIN_ROLE) throw badRequest(`No role can imply the ${ADMIN_ROLE} role`);
				await this.requireRole(tx, systemId, r);
			}
			const edges = await tx.query<{ role: string; implies: string }>(
				'SELECT role, implies FROM role_implications WHERE system_id = $1 AND role <> $2',
				[systemId, role]
			);
			const graph = new Map<string, string[]>([[role, implies]]);
			for (const e of edges) graph.set(e.role, [...(graph.get(e.role) ?? []), e.implies]);
			// A cycle through `role` exists if `role` is reachable from what it implies.
			const seen = new Set<string>();
			const stack = [...implies];
			while (stack.length) {
				const r = stack.pop()!;
				if (r === role) throw badRequest(`"${role}" would end up implying itself`);
				if (seen.has(r)) continue;
				seen.add(r);
				stack.push(...(graph.get(r) ?? []));
			}
			await tx.query('DELETE FROM role_implications WHERE system_id = $1 AND role = $2', [systemId, role]);
			for (const r of implies) {
				await tx.query('INSERT INTO role_implications (system_id, role, implies) VALUES ($1, $2, $3)', [
					systemId,
					role,
					r
				]);
			}
		});
		return this.getSystem(actor, systemId);
	}

	private async requireRole(db: Db, systemId: string, role: string): Promise<void> {
		const rows = await db.query('SELECT 1 FROM roles WHERE system_id = $1 AND name = $2', [systemId, role]);
		if (!rows.length) throw notFound(`Role "${role}" not found in "${systemId}"`);
	}

	// --- grants -------------------------------------------------------------

	async listGrants(actor: Actor, systemId: string): Promise<Grant[]> {
		await this.getSystem(actor, systemId);
		const rows = await this.db.query<GrantRow>(
			'SELECT * FROM grants WHERE system_id = $1 ORDER BY role, grantee',
			[systemId]
		);
		return rows.map(toGrant);
	}

	async grant(actor: Actor, systemId: string, role: string, rawGrantee: string): Promise<Grant> {
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}": use an e-mail address or a domain`);
		if (!canAssign(actor, systemId, role, grantee)) {
			throw forbidden(
				role === ADMIN_ROLE
					? 'Only roots can grant the admin role'
					: isDomainGrantee(grantee)
						? 'Only roots can grant roles to whole domains'
						: 'Forbidden'
			);
		}
		await this.requireRole(this.db, systemId, role);
		const [row] = await this.db.query<GrantRow>(
			`INSERT INTO grants (system_id, role, grantee, granted_by) VALUES ($1, $2, $3, $4)
			 ON CONFLICT (system_id, role, grantee) DO UPDATE SET system_id = EXCLUDED.system_id
			 RETURNING *`,
			[systemId, role, grantee, actor.email]
		);
		return toGrant(row);
	}

	async revoke(actor: Actor, systemId: string, role: string, rawGrantee: string): Promise<void> {
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		if (!canAssign(actor, systemId, role, grantee)) {
			throw forbidden(role === ADMIN_ROLE ? 'Only roots can revoke the admin role' : 'Forbidden');
		}
		const rows = await this.db.query(
			'DELETE FROM grants WHERE system_id = $1 AND role = $2 AND grantee = $3 RETURNING role',
			[systemId, role, grantee]
		);
		if (!rows.length) throw notFound('Grant not found');
	}

	// --- global grants (roots only) -----------------------------------------

	async listGlobalGrants(actor: Actor): Promise<Grant[]> {
		if (!actor.root) throw forbidden('Only roots can see global grants');
		const rows = await this.db.query<GrantRow>(
			'SELECT NULL AS system_id, * FROM global_grants ORDER BY role, grantee'
		);
		return rows.map(toGrant);
	}

	/** Grants `role` in every system that defines it, now or later. */
	async grantGlobal(actor: Actor, rawRole: string, rawGrantee: string): Promise<Grant> {
		if (!actor.root) throw forbidden('Only roots can grant global roles');
		const role = validName('role', rawRole);
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}": use an e-mail address or a domain`);
		const [row] = await this.db.query<GrantRow>(
			`INSERT INTO global_grants (role, grantee, granted_by) VALUES ($1, $2, $3)
			 ON CONFLICT (role, grantee) DO UPDATE SET role = EXCLUDED.role
			 RETURNING NULL AS system_id, *`,
			[role, grantee, actor.email]
		);
		return toGrant(row);
	}

	async revokeGlobal(actor: Actor, role: string, rawGrantee: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can revoke global roles');
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		const rows = await this.db.query(
			'DELETE FROM global_grants WHERE role = $1 AND grantee = $2 RETURNING role',
			[role, grantee]
		);
		if (!rows.length) throw notFound('Grant not found');
	}

	// --- vouchers -------------------------------------------------------------

	async createVoucher(actor: Actor, input: VoucherInput): Promise<Voucher> {
		const { systemId } = input;
		const role = systemId === null ? validName('role', input.role) : input.role;
		if (!canAssign(actor, systemId, role, null)) {
			throw forbidden(
				systemId === null
					? 'Only roots can create global vouchers'
					: role === ADMIN_ROLE
						? 'Only roots can create admin vouchers'
						: 'Forbidden'
			);
		}
		const startsAt = input.startsAt ?? null;
		const endsAt = input.endsAt ?? null;
		const maxUses = input.maxUses ?? null;
		const discountPercent = input.discountPercent ?? 100;
		if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
			throw badRequest('The discount must be a whole percentage from 0 to 100');
		}
		for (const d of [startsAt, endsAt]) {
			if (d && Number.isNaN(d.getTime())) throw badRequest('Invalid date');
		}
		if (startsAt && endsAt && startsAt >= endsAt) throw badRequest('The end date must be after the start date');
		if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
			throw badRequest('Usage count must be a positive integer');
		}
		if (systemId !== null) await this.requireRole(this.db, systemId, role);
		const [row] = await this.db.query<VoucherRow>(
			`INSERT INTO vouchers (code, system_id, role, discount_percent, starts_at, ends_at, max_uses, created_by)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
			[generateVoucherCode(), systemId, role, discountPercent, startsAt, endsAt, maxUses, actor.email]
		);
		return toVoucher(row);
	}

	/** Global vouchers (roots only). */
	async listGlobalVouchers(actor: Actor): Promise<Voucher[]> {
		if (!actor.root) throw forbidden('Only roots can see global vouchers');
		const rows = await this.db.query<VoucherRow>(
			'SELECT * FROM vouchers WHERE system_id IS NULL ORDER BY created_at DESC'
		);
		return rows.map(toVoucher);
	}

	/** Vouchers of a system; admins only see the ones they may hand out (non-admin). */
	async listVouchers(actor: Actor, systemId: string): Promise<Voucher[]> {
		await this.getSystem(actor, systemId);
		const rows = await this.db.query<VoucherRow>(
			`SELECT * FROM vouchers WHERE system_id = $1 AND ($2 OR role <> $3) ORDER BY created_at DESC`,
			[systemId, actor.root, ADMIN_ROLE]
		);
		return rows.map(toVoucher);
	}

	async disableVoucher(actor: Actor, rawCode: string): Promise<Voucher> {
		const code = normalizeVoucherCode(rawCode);
		const [existing] = await this.db.query<VoucherRow>('SELECT * FROM vouchers WHERE code = $1', [code]);
		if (!existing || !canAssign(actor, existing.system_id, existing.role, null)) {
			throw notFound('Voucher not found');
		}
		const [row] = await this.db.query<VoucherRow>(
			'UPDATE vouchers SET disabled_at = coalesce(disabled_at, $2) WHERE code = $1 RETURNING *',
			[code, this.now()]
		);
		return toVoucher(row);
	}

	/**
	 * Redeems a voucher for `email`, granting its role (globally for a global
	 * voucher). Each identity can redeem a given voucher once; the use counter
	 * is checked and incremented atomically. A voucher with less than 100%
	 * discount needs payment, which isn't available yet: it fails with 402 and
	 * the voucher's terms, recording nothing.
	 */
	async redeemVoucher(email: string, rawCode: string): Promise<Grant> {
		const code = normalizeVoucherCode(rawCode);
		const now = this.now();
		return this.db.transaction(async (tx) => {
			const [voucher] = await tx.query<VoucherRow>('SELECT * FROM vouchers WHERE code = $1 FOR UPDATE', [code]);
			if (!voucher) throw notFound('Voucher not found');
			const status = voucherStatus(toVoucher(voucher), now);
			if (status !== 'active') {
				const reasons: Record<Exclude<VoucherStatus, 'active'>, string> = {
					disabled: 'This voucher has been disabled',
					'not-started': 'This voucher is not valid yet',
					expired: 'This voucher has expired',
					exhausted: 'This voucher has no uses left'
				};
				throw new RbacError(409, reasons[status]);
			}
			if (voucher.discount_percent < 100) {
				throw new RbacError(402, 'This voucher requires payment, which is not available yet', {
					payment: {
						code,
						systemId: voucher.system_id,
						role: voucher.role,
						discountPercent: voucher.discount_percent
					}
				});
			}
			const redeemed = await tx.query(
				'INSERT INTO voucher_redemptions (code, email) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING code',
				[code, email]
			);
			if (!redeemed.length) throw new RbacError(409, 'You have already redeemed this voucher');
			await tx.query('UPDATE vouchers SET uses = uses + 1 WHERE code = $1', [code]);
			if (voucher.system_id === null) {
				const [row] = await tx.query<GrantRow>(
					`INSERT INTO global_grants (role, grantee, granted_by, voucher_code) VALUES ($1, $2, $3, $4)
					 ON CONFLICT (role, grantee) DO UPDATE SET role = EXCLUDED.role
					 RETURNING NULL AS system_id, *`,
					[voucher.role, email, voucher.created_by, code]
				);
				return toGrant(row);
			}
			const [row] = await tx.query<GrantRow>(
				`INSERT INTO grants (system_id, role, grantee, granted_by, voucher_code)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (system_id, role, grantee) DO UPDATE SET system_id = EXCLUDED.system_id
				 RETURNING *`,
				[voucher.system_id, voucher.role, email, voucher.created_by, code]
			);
			return toGrant(row);
		});
	}

	// --- role queries (the external API) -------------------------------------

	private queriedEmail(raw: string): string {
		const email = normalizeEmail(raw);
		if (!email) throw badRequest(`Invalid e-mail address "${raw}"`);
		return email;
	}

	/**
	 * Who may ask about whose roles: anyone about themselves, roots about
	 * anyone, admins about anyone within the systems they administer (never
	 * about global roles, which span every system).
	 */
	private requireCanQuery(actor: Actor, email: string, systemId: string | null): void {
		if (actor.root || actor.email === email) return;
		if (systemId !== null && actor.adminOf.includes(systemId)) return;
		throw forbidden(
			systemId === null
				? "Only roots can ask about other people's global roles"
				: `You can only ask about other people's roles in systems you administer`
		);
	}

	/**
	 * Whether `email` holds `role` in `systemId` (granted or implied), or holds
	 * the global role `role` when systemId is null. Same rules as
	 * rolesOf/globalRolesOf.
	 */
	async hasRole(actor: Actor, rawEmail: string, systemId: string | null, rawRole: string): Promise<boolean> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email, systemId);
		const role = rawRole.trim().toLowerCase();
		if (systemId === null) return (await this.globalRolesOf(email)).includes(role);
		await this.requireSystem(systemId);
		await this.requireRole(this.db, systemId, role);
		if (this.isRoot(email)) return true;
		return ((await this.grantedRoles(email))[systemId] ?? []).includes(role);
	}

	/** An identity's roles in one system (sorted). */
	async rolesIn(actor: Actor, rawEmail: string, systemId: string): Promise<string[]> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email, systemId);
		await this.requireSystem(systemId);
		return (await this.rolesOf(email))[systemId] ?? [];
	}

	/** An identity's roles in every system and its global roles. */
	async allRoles(actor: Actor, rawEmail: string): Promise<{ globalRoles: string[]; roles: RoleMap }> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email, null);
		return { globalRoles: await this.globalRolesOf(email), roles: await this.rolesOf(email) };
	}

	private async requireSystem(systemId: string): Promise<void> {
		const rows = await this.db.query('SELECT 1 FROM systems WHERE id = $1', [systemId]);
		if (!rows.length) throw notFound(`System "${systemId}" not found`);
	}
}
