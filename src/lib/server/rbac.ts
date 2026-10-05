import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationReasons, deleteAll, queryAll, queryIndex, queryPrefix, type Item, type Table } from './dynamo';
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

/**
 * Item layout in the table (src/lib/server/dynamo.ts). Dates are ISO strings;
 * an absent attribute means null.
 *
 *   system      PK SYS#<id>       SK META                      GSI1 SYSTEMS / <id>
 *   role        PK SYS#<id>       SK ROLE#<name>               GSI1 ROLENAME#<name> / <id>
 *   implication PK SYS#<id>       SK IMPL#<role>#<implied>
 *   grant       PK SYS#<id>       SK GRANT#<role>#<grantee>    GSI1 GRANTEE#<grantee> / SYS#<id>#<role>
 *   global grant PK GLOBAL        SK GRANT#<role>#<grantee>    GSI1 GRANTEE#<grantee> / GLOBAL#<role>
 *   voucher     PK VOUCHER#<code> SK META                      GSI1 VOUCHERS#<id, or * if global> / <createdAt>#<code>
 *   redemption  PK VOUCHER#<code> SK REDEEMED#<email>
 *
 * Names and grantees can't contain '#', so the keys are unambiguous and sort
 * by role, then grantee.
 */
const sysPK = (id: string) => `SYS#${id}`;
const GLOBAL_PK = 'GLOBAL';
const GLOBAL_VOUCHERS = '*';
const roleKey = (systemId: string, role: string) => ({ PK: sysPK(systemId), SK: `ROLE#${role}` });
const grantKey = (systemId: string | null, role: string, grantee: string) => ({
	PK: systemId === null ? GLOBAL_PK : sysPK(systemId),
	SK: `GRANT#${role}#${grantee}`
});
const voucherKey = (code: string) => ({ PK: `VOUCHER#${code}`, SK: 'META' });
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const date = (v: unknown) => (v ? new Date(v as string) : null);

/** Most implied roles one role may list (a transaction holds at most 100 items). */
const MAX_IMPLIES = 30;
/** Most roles a new system may define at once (same limit). */
const MAX_INITIAL_ROLES = 90;

const grantItem = (systemId: string | null, role: string, grantee: string, grantedBy: string, now: Date, voucherCode?: string): Item => ({
	...grantKey(systemId, role, grantee),
	GSI1PK: `GRANTEE#${grantee}`,
	GSI1SK: systemId === null ? `GLOBAL#${role}` : `SYS#${systemId}#${role}`,
	systemId: systemId ?? undefined,
	role,
	grantee,
	grantedBy,
	grantedAt: now.toISOString(),
	voucherCode
});

const toGrant = (it: Item): Grant => ({
	systemId: (it.systemId as string | undefined) ?? null,
	role: it.role as string,
	grantee: it.grantee as string,
	grantedBy: it.grantedBy as string,
	grantedAt: new Date(it.grantedAt as string),
	voucherCode: (it.voucherCode as string | undefined) ?? null
});

const toVoucher = (it: Item): Voucher => ({
	code: it.code as string,
	systemId: (it.systemId as string | undefined) ?? null,
	role: it.role as string,
	discountPercent: it.discountPercent as number,
	startsAt: date(it.startsAt),
	endsAt: date(it.endsAt),
	maxUses: (it.maxUses as number | undefined) ?? null,
	uses: it.uses as number,
	createdBy: it.createdBy as string,
	createdAt: new Date(it.createdAt as string),
	disabledAt: date(it.disabledAt)
});

/** Every role reachable from `held` through `edges` (role -> implied roles), `held` included. */
function closure(held: Iterable<string>, edges: Map<string, string[]>): Set<string> {
	const out = new Set<string>();
	const stack = [...held];
	while (stack.length) {
		const r = stack.pop()!;
		if (out.has(r)) continue;
		out.add(r);
		stack.push(...(edges.get(r) ?? []));
	}
	return out;
}

export class Rbac {
	constructor(
		private readonly table: Table,
		private readonly roots: Allowlist,
		private readonly now: () => Date = () => new Date()
	) {}

	private get(key: Item): Promise<Item | undefined> {
		return this.table.doc
			.send(new GetCommand({ TableName: this.table.name, Key: key, ConsistentRead: true }))
			.then((r) => r.Item);
	}

	private put(item: Item, condition = 'attribute_not_exists(PK)') {
		return this.table.doc.send(new PutCommand({ TableName: this.table.name, Item: item, ConditionExpression: condition }));
	}

	/** Runs a TransactWrite; on cancellation returns the reason codes instead of throwing. */
	private async transact(items: NonNullable<ConstructorParameters<typeof TransactWriteCommand>[0]['TransactItems']>): Promise<string[] | null> {
		try {
			await this.table.doc.send(new TransactWriteCommand({ TransactItems: items }));
			return null;
		} catch (err) {
			const reasons = cancellationReasons(err);
			if (!reasons) throw err;
			return reasons;
		}
	}

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

	/** The grants (system and global) to an identity's address and domain. */
	private async grantItemsOf(email: string): Promise<Item[]> {
		const pages = await Promise.all(granteesFor(email).map((g) => queryIndex(this.table, `GRANTEE#${g}`)));
		return pages.flat();
	}

	/**
	 * System-independent roles: ["root"] for identities on the root list,
	 * otherwise the roles of their (and their domain's) global grants.
	 */
	async globalRolesOf(email: string): Promise<string[]> {
		if (this.isRoot(email)) return [ROOT_ROLE];
		const items = await this.grantItemsOf(email);
		return [...new Set(items.filter((it) => it.PK === GLOBAL_PK).map((it) => it.role as string))].sort();
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
		const held = new Map<string, Set<string>>();
		const add = (systemId: string, role: string) => {
			if (!held.has(systemId)) held.set(systemId, new Set());
			held.get(systemId)!.add(role);
		};
		const items = await this.grantItemsOf(email);
		const globalRoles = new Set<string>();
		for (const it of items) {
			if (it.PK === GLOBAL_PK) globalRoles.add(it.role as string);
			else add(it.systemId as string, it.role as string);
		}
		const defining = await Promise.all([...globalRoles].map((r) => queryIndex(this.table, `ROLENAME#${r}`)));
		for (const roles of defining) for (const it of roles) add(it.systemId as string, it.name as string);
		const map: RoleMap = {};
		for (const systemId of [...held.keys()].sort()) {
			const edges = new Map<string, string[]>();
			for (const it of await queryPrefix(this.table, sysPK(systemId), 'IMPL#')) {
				edges.set(it.role as string, [...(edges.get(it.role as string) ?? []), it.implies as string]);
			}
			map[systemId] = [...closure(held.get(systemId)!, edges)].sort();
		}
		return map;
	}

	// --- systems & role catalog -------------------------------------------

	/** A system's catalog items: its META, roles and implications (not its grants). */
	private catalogItems(systemId: string): Promise<Item[]> {
		// Sort keys: GRANT# < IMPL# < META < ROLE#.
		return queryAll(this.table, {
			KeyConditionExpression: 'PK = :pk AND SK >= :from',
			ExpressionAttributeValues: { ':pk': sysPK(systemId), ':from': 'IMPL#' },
			ConsistentRead: true
		});
	}

	private async loadSystem(systemId: string): Promise<(System & { implVersion: number }) | null> {
		const items = await this.catalogItems(systemId);
		const meta = items.find((it) => it.SK === 'META');
		if (!meta) return null;
		const implies: Record<string, string[]> = {};
		for (const it of items.filter((it) => (it.SK as string).startsWith('IMPL#'))) {
			(implies[it.role as string] ??= []).push(it.implies as string);
		}
		const roles = items.filter((it) => (it.SK as string).startsWith('ROLE#')).map((it) => it.name as string);
		return { id: systemId, name: meta.name as string, roles, implies, implVersion: (meta.implVersion as number) ?? 0 };
	}

	private async allSystems(ids?: string[]): Promise<System[]> {
		const wanted = ids ?? (await queryIndex(this.table, 'SYSTEMS')).map((it) => it.id as string);
		const systems = await Promise.all([...new Set(wanted)].sort().map((id) => this.loadSystem(id)));
		return systems.filter((s) => s !== null).map(({ implVersion: _, ...s }) => s);
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
		if (roles.size > MAX_INITIAL_ROLES) throw badRequest(`Create at most ${MAX_INITIAL_ROLES} roles at once`);
		const now = this.now().toISOString();
		const reasons = await this.transact([
			{
				Put: {
					TableName: this.table.name,
					Item: { PK: sysPK(id), SK: 'META', GSI1PK: 'SYSTEMS', GSI1SK: id, id, name, createdBy: actor.email, createdAt: now },
					ConditionExpression: 'attribute_not_exists(PK)'
				}
			},
			...[...roles].map((role) => ({
				Put: {
					TableName: this.table.name,
					Item: { ...roleKey(id, role), GSI1PK: `ROLENAME#${role}`, GSI1SK: id, systemId: id, name: role, createdAt: now }
				}
			}))
		]);
		if (reasons) throw new RbacError(409, `System "${id}" already exists`);
		return { id, name, roles: [...roles].sort(), implies: {} };
	}

	async deleteSystem(actor: Actor, systemId: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can delete systems');
		const meta = await this.get({ PK: sysPK(systemId), SK: 'META' });
		if (!meta) throw notFound(`System "${systemId}" not found`);
		// Not atomic: everything else goes first, so a failure leaves the
		// system listed and the delete can be retried.
		const items = await queryAll(this.table, {
			KeyConditionExpression: 'PK = :pk',
			ExpressionAttributeValues: { ':pk': sysPK(systemId) }
		});
		await this.deleteVouchers(await queryIndex(this.table, `VOUCHERS#${systemId}`));
		await deleteAll(this.table, items.filter((it) => it.SK !== 'META'));
		await deleteAll(this.table, [meta]);
	}

	/** Deletes vouchers with their redemptions. */
	private async deleteVouchers(vouchers: Item[]): Promise<void> {
		for (const v of vouchers) {
			const items = await queryAll(this.table, {
				KeyConditionExpression: 'PK = :pk',
				ExpressionAttributeValues: { ':pk': v.PK }
			});
			await deleteAll(this.table, items);
		}
	}

	async addRole(actor: Actor, systemId: string, rawRole: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can define roles');
		const role = validName('role', rawRole);
		await this.getSystem(actor, systemId);
		const reasons = await this.transact([
			{
				ConditionCheck: {
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					ConditionExpression: 'attribute_exists(PK)'
				}
			},
			{
				Put: {
					TableName: this.table.name,
					Item: {
						...roleKey(systemId, role),
						GSI1PK: `ROLENAME#${role}`,
						GSI1SK: systemId,
						systemId,
						name: role,
						createdAt: this.now().toISOString()
					},
					ConditionExpression: 'attribute_not_exists(PK)'
				}
			}
		]);
		if (reasons?.[0] === 'ConditionalCheckFailed') throw notFound(`System "${systemId}" not found`);
		if (reasons) throw new RbacError(409, `Role "${role}" already exists`);
	}

	/** Removes a role from the catalog, along with its grants, implications and vouchers. */
	async removeRole(actor: Actor, systemId: string, role: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can remove roles');
		if (role === ADMIN_ROLE) throw badRequest('The admin role cannot be removed');
		const { Attributes } = await this.table.doc.send(
			new DeleteCommand({ TableName: this.table.name, Key: roleKey(systemId, role), ReturnValues: 'ALL_OLD' })
		);
		if (!Attributes) throw notFound(`Role "${role}" not found in "${systemId}"`);
		// The role is gone first, so nothing new can be granted or implied
		// with it (those writes check it exists) while the rest is cleaned up.
		const grants = await queryPrefix(this.table, sysPK(systemId), `GRANT#${role}#`);
		const implications = (await queryPrefix(this.table, sysPK(systemId), 'IMPL#')).filter(
			(it) => it.role === role || it.implies === role
		);
		await deleteAll(this.table, [...grants, ...implications]);
		const vouchers = (await queryIndex(this.table, `VOUCHERS#${systemId}`)).filter((it) => it.role === role);
		await this.deleteVouchers(vouchers);
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
		if (implies.length > MAX_IMPLIES) throw badRequest(`A role can imply at most ${MAX_IMPLIES} roles directly`);
		const system = await this.loadSystem(systemId);
		if (!system) throw notFound(`System "${systemId}" not found`);
		const requireRole = (r: string) => {
			if (!system.roles.includes(r)) throw notFound(`Role "${r}" not found in "${systemId}"`);
		};
		requireRole(role);
		for (const r of implies) {
			if (r === role) throw badRequest(`A role cannot imply itself`);
			if (r === ADMIN_ROLE) throw badRequest(`No role can imply the ${ADMIN_ROLE} role`);
			requireRole(r);
		}
		// A cycle through `role` exists if `role` is reachable from what it implies.
		const edges = new Map(Object.entries(system.implies));
		edges.set(role, implies);
		const reachable = closure(implies.flatMap((r) => edges.get(r) ?? []).concat(implies), edges);
		if (reachable.has(role)) throw badRequest(`"${role}" would end up implying itself`);
		const previous = system.implies[role] ?? [];
		// The META version guards against concurrent edits combining into a
		// cycle; the role checks against concurrent removal.
		const reasons = await this.transact([
			{
				Update: {
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					UpdateExpression: 'SET implVersion = :next',
					ConditionExpression: system.implVersion
						? 'implVersion = :cur'
						: 'attribute_exists(PK) AND attribute_not_exists(implVersion)',
					ExpressionAttributeValues: {
						':next': system.implVersion + 1,
						...(system.implVersion && { ':cur': system.implVersion })
					}
				}
			},
			...[...new Set([role, ...implies])].map((r) => ({
				ConditionCheck: { TableName: this.table.name, Key: roleKey(systemId, r), ConditionExpression: 'attribute_exists(PK)' }
			})),
			...previous
				.filter((r) => !implies.includes(r))
				.map((r) => ({ Delete: { TableName: this.table.name, Key: { PK: sysPK(systemId), SK: `IMPL#${role}#${r}` } } })),
			...implies
				.filter((r) => !previous.includes(r))
				.map((r) => ({
					Put: {
						TableName: this.table.name,
						Item: { PK: sysPK(systemId), SK: `IMPL#${role}#${r}`, systemId, role, implies: r }
					}
				}))
		]);
		if (reasons) throw new RbacError(409, 'The role catalog changed meanwhile; try again');
		return this.getSystem(actor, systemId);
	}

	// --- grants -------------------------------------------------------------

	async listGrants(actor: Actor, systemId: string): Promise<Grant[]> {
		await this.getSystem(actor, systemId);
		return (await queryPrefix(this.table, sysPK(systemId), 'GRANT#')).map(toGrant);
	}

	/**
	 * Writes a grant unless it exists (re-granting is idempotent and keeps the
	 * original), checking the role is in the catalog for system grants.
	 */
	private async putGrant(item: Item): Promise<Grant> {
		const systemId = (item.systemId as string | undefined) ?? null;
		const reasons = await this.transact([
			...(systemId === null
				? []
				: [
						{
							ConditionCheck: {
								TableName: this.table.name,
								Key: roleKey(systemId, item.role as string),
								ConditionExpression: 'attribute_exists(PK)'
							}
						}
					]),
			{ Put: { TableName: this.table.name, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }
		]);
		if (!reasons) return toGrant(item);
		if (systemId !== null && reasons[0] === 'ConditionalCheckFailed') {
			throw notFound(`Role "${item.role}" not found in "${systemId}"`);
		}
		const existing = await this.get({ PK: item.PK, SK: item.SK });
		if (!existing) throw new RbacError(409, 'The grant changed meanwhile; try again');
		return toGrant(existing);
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
		return this.putGrant(grantItem(systemId, role, grantee, actor.email, this.now()));
	}

	private async deleteGrant(systemId: string | null, role: string, grantee: string): Promise<void> {
		const { Attributes } = await this.table.doc.send(
			new DeleteCommand({ TableName: this.table.name, Key: grantKey(systemId, role, grantee), ReturnValues: 'ALL_OLD' })
		);
		if (!Attributes) throw notFound('Grant not found');
	}

	async revoke(actor: Actor, systemId: string, role: string, rawGrantee: string): Promise<void> {
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		if (!canAssign(actor, systemId, role, grantee)) {
			throw forbidden(role === ADMIN_ROLE ? 'Only roots can revoke the admin role' : 'Forbidden');
		}
		await this.deleteGrant(systemId, role, grantee);
	}

	// --- global grants (roots only) -----------------------------------------

	async listGlobalGrants(actor: Actor): Promise<Grant[]> {
		if (!actor.root) throw forbidden('Only roots can see global grants');
		return (await queryPrefix(this.table, GLOBAL_PK, 'GRANT#')).map(toGrant);
	}

	/** Grants `role` in every system that defines it, now or later. */
	async grantGlobal(actor: Actor, rawRole: string, rawGrantee: string): Promise<Grant> {
		if (!actor.root) throw forbidden('Only roots can grant global roles');
		const role = validName('role', rawRole);
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}": use an e-mail address or a domain`);
		return this.putGrant(grantItem(null, role, grantee, actor.email, this.now()));
	}

	async revokeGlobal(actor: Actor, role: string, rawGrantee: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can revoke global roles');
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		await this.deleteGrant(null, role, grantee);
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
		const code = generateVoucherCode();
		const createdAt = this.now().toISOString();
		const item: Item = {
			...voucherKey(code),
			GSI1PK: `VOUCHERS#${systemId ?? GLOBAL_VOUCHERS}`,
			GSI1SK: `${createdAt}#${code}`,
			code,
			systemId: systemId ?? undefined,
			role,
			discountPercent,
			startsAt: iso(startsAt),
			endsAt: iso(endsAt),
			maxUses: maxUses ?? undefined,
			uses: 0,
			createdBy: actor.email,
			createdAt
		};
		const reasons = await this.transact([
			...(systemId === null
				? []
				: [
						{
							ConditionCheck: {
								TableName: this.table.name,
								Key: roleKey(systemId, role),
								ConditionExpression: 'attribute_exists(PK)'
							}
						}
					]),
			{ Put: { TableName: this.table.name, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }
		]);
		if (reasons && systemId !== null && reasons[0] === 'ConditionalCheckFailed') {
			throw notFound(`Role "${role}" not found in "${systemId}"`);
		}
		if (reasons) throw new RbacError(409, 'Voucher code collision; try again');
		return toVoucher(item);
	}

	/** Global vouchers (roots only), newest first. */
	async listGlobalVouchers(actor: Actor): Promise<Voucher[]> {
		if (!actor.root) throw forbidden('Only roots can see global vouchers');
		return (await queryIndex(this.table, `VOUCHERS#${GLOBAL_VOUCHERS}`, { newestFirst: true })).map(toVoucher);
	}

	/** Vouchers of a system, newest first; admins only see the ones they may hand out (non-admin). */
	async listVouchers(actor: Actor, systemId: string): Promise<Voucher[]> {
		await this.getSystem(actor, systemId);
		const items = await queryIndex(this.table, `VOUCHERS#${systemId}`, { newestFirst: true });
		return items.filter((it) => actor.root || it.role !== ADMIN_ROLE).map(toVoucher);
	}

	async disableVoucher(actor: Actor, rawCode: string): Promise<Voucher> {
		const code = normalizeVoucherCode(rawCode);
		const existing = code ? await this.get(voucherKey(code)) : undefined;
		if (!existing || !canAssign(actor, (existing.systemId as string | undefined) ?? null, existing.role as string, null)) {
			throw notFound('Voucher not found');
		}
		const { Attributes } = await this.table.doc.send(
			new UpdateCommand({
				TableName: this.table.name,
				Key: voucherKey(code),
				UpdateExpression: 'SET disabledAt = if_not_exists(disabledAt, :now)',
				ConditionExpression: 'attribute_exists(PK)',
				ExpressionAttributeValues: { ':now': this.now().toISOString() },
				ReturnValues: 'ALL_NEW'
			})
		);
		return toVoucher(Attributes!);
	}

	/**
	 * Redeems a voucher for `email`, granting its role (globally for a global
	 * voucher). Each identity can redeem a given voucher once; counting the
	 * use, recording the redemption and granting happen in one transaction
	 * whose conditions keep uses within maxUses. A voucher with less than 100%
	 * discount needs payment, which isn't available yet: it fails with 402 and
	 * the voucher's terms, recording nothing.
	 */
	async redeemVoucher(email: string, rawCode: string): Promise<Grant> {
		const code = normalizeVoucherCode(rawCode);
		const now = this.now();
		const reasonsByStatus: Record<Exclude<VoucherStatus, 'active'>, string> = {
			disabled: 'This voucher has been disabled',
			'not-started': 'This voucher is not valid yet',
			expired: 'This voucher has expired',
			exhausted: 'This voucher has no uses left'
		};
		const requireActive = (item: Item | undefined): Voucher => {
			if (!item) throw notFound('Voucher not found');
			const voucher = toVoucher(item);
			const status = voucherStatus(voucher, now);
			if (status !== 'active') throw new RbacError(409, reasonsByStatus[status]);
			return voucher;
		};
		const voucher = requireActive(code ? await this.get(voucherKey(code)) : undefined);
		if (voucher.discountPercent < 100) {
			throw new RbacError(402, 'This voucher requires payment, which is not available yet', {
				payment: { code, systemId: voucher.systemId, role: voucher.role, discountPercent: voucher.discountPercent }
			});
		}
		const grant = grantItem(voucher.systemId, voucher.role, email, voucher.createdBy, now, code);
		for (let attempt = 0; attempt < 2; attempt++) {
			const existing = await this.get({ PK: grant.PK, SK: grant.SK });
			const reasons = await this.transact([
				{
					Update: {
						TableName: this.table.name,
						Key: voucherKey(code),
						UpdateExpression: 'SET uses = uses + :one',
						ConditionExpression:
							'attribute_exists(PK) AND attribute_not_exists(disabledAt) AND (attribute_not_exists(maxUses) OR uses < maxUses)',
						ExpressionAttributeValues: { ':one': 1 }
					}
				},
				{
					Put: {
						TableName: this.table.name,
						Item: { PK: voucherKey(code).PK, SK: `REDEEMED#${email}`, email, redeemedAt: now.toISOString() },
						ConditionExpression: 'attribute_not_exists(PK)'
					}
				},
				// Re-redeeming a role you already hold keeps the existing grant.
				...(existing
					? []
					: [{ Put: { TableName: this.table.name, Item: grant, ConditionExpression: 'attribute_not_exists(PK)' } }])
			]);
			if (!reasons) return toGrant(existing ?? grant);
			if (reasons[0] === 'ConditionalCheckFailed') {
				requireActive(await this.get(voucherKey(code)));
				throw new RbacError(409, 'This voucher has no uses left');
			}
			if (reasons[1] === 'ConditionalCheckFailed') throw new RbacError(409, 'You have already redeemed this voucher');
			// Otherwise the grant appeared meanwhile: retry keeping it.
		}
		throw new RbacError(409, 'The voucher changed meanwhile; try again');
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
		if (!(await this.get(roleKey(systemId, role)))) throw notFound(`Role "${role}" not found in "${systemId}"`);
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
		if (!(await this.get({ PK: sysPK(systemId), SK: 'META' }))) throw notFound(`System "${systemId}" not found`);
	}
}
