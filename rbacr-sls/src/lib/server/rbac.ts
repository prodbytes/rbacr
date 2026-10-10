import { DeleteCommand, GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationReasons, deleteAll, queryAll, queryIndex, queryPrefix, type Item, type Table } from './dynamo';
import { Allowlist, granteesFor, normalizeEmail, parseGrantee } from './identity';

/**
 * The only built-in role (R1, R2): held by every identity on RBACR_ROOT_LIST,
 * it implies every role of every system and is what lets an identity manage
 * rbacr. Every other role, and every implication, is registered data.
 */
export const ROOT_ROLE = 'root';

/** The `grantedBy` of grants made by the paid-subscription sync (Q2). */
export const SUBSCRIPTION_GRANTOR = 'stripe';

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
	/** On the root allow list: holds `root`, so every role, and manages everything. */
	root: boolean;
}

/** Effective roles keyed by system id, each list sorted. */
export type RoleMap = Record<string, string[]>;

export interface System {
	id: string;
	name: string;
	roles: string[];
	/**
	 * Direct implications, as registered: holding the key role also gives
	 * these roles (transitively). Roles implying nothing are left out.
	 */
	implies: Record<string, string[]>;
	/** The catalog role paying Substack subscribers hold in this system (Q2), or null for none. */
	subscriberRole: string | null;
}

/** A role check (C3, C3a): whether the role is held, and until when at most (null: no end). */
export interface RoleCheck {
	allowed: boolean;
	/** Only when allowed: when the grants giving the role end; null if they never do. */
	expiresAt: Date | null;
}

/** What the subscription sync did to one grant (Q2, Q3). */
export interface SubscriberSync {
	/** null for a global grant (left over from an earlier configuration). */
	systemId: string | null;
	role: string;
	outcome: 'granted' | 'updated' | 'revoked' | 'unchanged';
}

/** When a grant gives its role (G1): from startsAt (null: immediately) until endsAt (exclusive; null: forever). */
export interface Validity {
	startsAt: Date | null;
	endsAt: Date | null;
}

/** A grant; systemId null is a global grant (the role in every system that defines it). */
export interface Grant extends Validity {
	systemId: string | null;
	role: string;
	grantee: string;
	grantedBy: string;
	grantedAt: Date;
	voucherCode: string | null;
}

export type GrantStatus = 'active' | 'not-started' | 'expired';

export function grantStatus(g: Validity, now: Date): GrantStatus {
	if (g.startsAt && g.startsAt > now) return 'not-started';
	if (g.endsAt && g.endsAt <= now) return 'expired';
	return 'active';
}

const sameValidity = (a: Validity, b: Validity) =>
	a.startsAt?.getTime() === b.startsAt?.getTime() && a.endsAt?.getTime() === b.endsAt?.getTime();

/** Checks optional start and end dates: valid, and the start before the end. */
function validValidity(input: Partial<Validity>): Validity {
	const startsAt = input.startsAt ?? null;
	const endsAt = input.endsAt ?? null;
	for (const d of [startsAt, endsAt]) {
		if (d && Number.isNaN(d.getTime())) throw badRequest('Invalid date');
	}
	if (startsAt && endsAt && startsAt >= endsAt) throw badRequest('The end date must be after the start date');
	return { startsAt, endsAt };
}

/**
 * A grant as the API returns it: with the roles it implies (R6), so a client
 * sees everything the grant gives. For a system grant, `impliedRoles` are the
 * roles implied in its system. A global grant gives its role in every system
 * that defines it, so it lists them per system in `impliedRolesBySystem`
 * (and `impliedRoles` is empty).
 */
export interface GrantWithImplied extends Grant {
	/** Whether the grant gives its role now (G1). */
	status: GrantStatus;
	impliedRoles: string[];
	impliedRolesBySystem?: Record<string, string[]>;
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

/** Management (systems, catalogs, grants, vouchers) is for roots only (P1). */
function requireRoot(actor: Actor, message = 'Only roots can do this'): void {
	if (!actor.root) throw forbidden(message);
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
 *   system      PK SYS#<id>       SK META                      GSI1 SYSTEMS / <id>    (optional subscriberRole)
 *   role        PK SYS#<id>       SK ROLE#<name>               GSI1 ROLENAME#<name> / <id>
 *   implication PK SYS#<id>       SK IMPL#<role>#<implied>
 *   grant       PK SYS#<id>       SK GRANT#<role>#<grantee>    GSI1 GRANTEE#<grantee> / SYS#<id>#<role>
 *   global grant PK GLOBAL        SK GRANT#<role>#<grantee>    GSI1 GRANTEE#<grantee> / GLOBAL#<role>
 *               (grants carry optional startsAt / endsAt, G1)
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

/** A DynamoDB transaction holds at most 100 items. */
const MAX_TRANSACTION_ITEMS = 100;
/** Most roles a new system may define at once (the system and its roles are one transaction). */
const MAX_INITIAL_ROLES = MAX_TRANSACTION_ITEMS - 1;

/** The registered implication item for `role` implying `implied`. */
const implicationItem = (systemId: string, role: string, implied: string): Item => ({
	PK: sysPK(systemId),
	SK: `IMPL#${role}#${implied}`,
	systemId,
	role,
	implies: implied
});

const grantItem = (
	systemId: string | null,
	role: string,
	grantee: string,
	grantedBy: string,
	now: Date,
	{ startsAt, endsAt }: Validity,
	voucherCode?: string
): Item => ({
	...grantKey(systemId, role, grantee),
	GSI1PK: `GRANTEE#${grantee}`,
	GSI1SK: systemId === null ? `GLOBAL#${role}` : `SYS#${systemId}#${role}`,
	systemId: systemId ?? undefined,
	role,
	grantee,
	grantedBy,
	grantedAt: now.toISOString(),
	startsAt: iso(startsAt),
	endsAt: iso(endsAt),
	voucherCode
});

/** Replaces an existing grant only if nobody changed it since it was read; otherwise writes a new one. */
const unchangedSince = (existing: Item | undefined) =>
	existing
		? { ConditionExpression: 'grantedAt = :was', ExpressionAttributeValues: { ':was': existing.grantedAt } }
		: { ConditionExpression: 'attribute_not_exists(PK)' };

const toGrant = (it: Item): Grant => ({
	systemId: (it.systemId as string | undefined) ?? null,
	role: it.role as string,
	grantee: it.grantee as string,
	grantedBy: it.grantedBy as string,
	grantedAt: new Date(it.grantedAt as string),
	startsAt: date(it.startsAt),
	endsAt: date(it.endsAt),
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

/** The later of two ends, where null (never) is latest and undefined means none yet. */
const laterEnd = (a: Date | null | undefined, b: Date | null): Date | null =>
	a === undefined ? b : a === null || b === null ? null : a > b ? a : b;

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

	/** The configured root allow list (RBACR_ROOT_LIST), sorted; roots only. */
	rootList(actor: Actor): string[] {
		requireRoot(actor, 'Only roots can see the root allow list');
		return [...this.roots.entries].sort();
	}

	async actor(email: string): Promise<Actor> {
		const root = this.isRoot(email);
		return { email, root };
	}

	/**
	 * The grants (system and global) to an identity's address and domain that
	 * give their role now (G1). `root` comes only from the root allow list
	 * (R1), so a grant naming it, which no write path accepts, is ignored even
	 * if one were in the table.
	 */
	private async grantItemsOf(email: string): Promise<Item[]> {
		const now = this.now();
		const pages = await Promise.all(granteesFor(email).map((g) => queryIndex(this.table, `GRANTEE#${g}`)));
		return pages.flat().filter((it) => it.role !== ROOT_ROLE && grantStatus(toGrant(it), now) === 'active');
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
		const ends = await this.grantedRoleEnds(email);
		return Object.fromEntries([...ends].map(([systemId, roles]) => [systemId, [...roles.keys()].sort()]));
	}

	/**
	 * Each role an identity holds through grants, per system, with when it
	 * stops holding it at the latest (C3a): the last end among the grants
	 * valid now that give it, directly or by implication; null if one of
	 * them never ends. Direct grants, plus global grants in every system
	 * whose catalog has the role, then everything those roles imply in their
	 * system (transitively). Systems sorted.
	 */
	private async grantedRoleEnds(email: string): Promise<Map<string, Map<string, Date | null>>> {
		const held = new Map<string, Map<string, Date | null>>();
		const add = (systemId: string, role: string, end: Date | null) => {
			if (!held.has(systemId)) held.set(systemId, new Map());
			const roles = held.get(systemId)!;
			roles.set(role, laterEnd(roles.get(role), end));
		};
		const items = await this.grantItemsOf(email);
		const globalEnds = new Map<string, Date | null>();
		for (const it of items) {
			const end = date(it.endsAt);
			if (it.PK === GLOBAL_PK) globalEnds.set(it.role as string, laterEnd(globalEnds.get(it.role as string), end));
			else add(it.systemId as string, it.role as string, end);
		}
		const defining = await Promise.all([...globalEnds.keys()].map((r) => queryIndex(this.table, `ROLENAME#${r}`)));
		for (const roles of defining) for (const it of roles) add(it.systemId as string, it.name as string, globalEnds.get(it.name as string)!);
		const out = new Map<string, Map<string, Date | null>>();
		for (const systemId of [...held.keys()].sort()) {
			const system = await this.loadSystem(systemId);
			if (!system) continue;
			const edges = new Map(Object.entries(system.implies));
			const ends = new Map<string, Date | null>();
			for (const [granted, end] of held.get(systemId)!) {
				for (const r of closure([granted], edges)) ends.set(r, laterEnd(ends.get(r), end));
			}
			out.set(systemId, ends);
		}
		return out;
	}

	/**
	 * Adds to each grant the roles it implies (R6), for API responses. Grants
	 * of systems or roles that no longer exist imply nothing.
	 */
	async withImpliedRoles(grants: Grant[]): Promise<GrantWithImplied[]> {
		const systems = new Map<string, Promise<Awaited<ReturnType<Rbac['loadSystem']>>>>();
		const system = (id: string) => {
			if (!systems.has(id)) systems.set(id, this.loadSystem(id));
			return systems.get(id)!;
		};
		const implied = async (systemId: string, role: string): Promise<string[]> => {
			const s = await system(systemId);
			if (!s || !s.roles.includes(role)) return [];
			return [...closure([role], new Map(Object.entries(s.implies)))].filter((r) => r !== role).sort();
		};
		const now = this.now();
		return Promise.all(
			grants.map(async (g): Promise<GrantWithImplied> => {
				const status = grantStatus(g, now);
				if (g.systemId !== null) return { ...g, status, impliedRoles: await implied(g.systemId, g.role) };
				const defining = (await queryIndex(this.table, `ROLENAME#${g.role}`)).map((it) => it.systemId as string).sort();
				const bySystem: Record<string, string[]> = {};
				for (const id of defining) bySystem[id] = await implied(id, g.role);
				return { ...g, status, impliedRoles: [], impliedRolesBySystem: bySystem };
			})
		);
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

	/** A system with its catalog: its registered roles and implications. */
	private async loadSystem(systemId: string): Promise<(System & { implVersion: number }) | null> {
		const items = await this.catalogItems(systemId);
		const meta = items.find((it) => it.SK === 'META');
		if (!meta) return null;
		const implies: Record<string, string[]> = {};
		for (const it of items.filter((it) => (it.SK as string).startsWith('IMPL#'))) {
			(implies[it.role as string] ??= []).push(it.implies as string);
		}
		const roles = items.filter((it) => (it.SK as string).startsWith('ROLE#')).map((it) => it.name as string);
		return {
			id: systemId,
			name: meta.name as string,
			roles,
			implies,
			subscriberRole: (meta.subscriberRole as string | undefined) ?? null,
			implVersion: (meta.implVersion as number) ?? 0
		};
	}

	private async allSystems(ids?: string[]): Promise<System[]> {
		const wanted = ids ?? (await queryIndex(this.table, 'SYSTEMS')).map((it) => it.id as string);
		const systems = await Promise.all([...new Set(wanted)].sort().map((id) => this.loadSystem(id)));
		return systems.filter((s) => s !== null).map(({ implVersion: _, ...s }) => s);
	}

	/** Systems the actor can manage: all for roots, none for anyone else. */
	async listSystems(actor: Actor): Promise<System[]> {
		return actor.root ? this.allSystems() : [];
	}

	async getSystem(actor: Actor, systemId: string): Promise<System> {
		requireRoot(actor, 'Only roots can see systems');
		const [system] = await this.allSystems([systemId]);
		if (!system) throw notFound(`System "${systemId}" not found`);
		return system;
	}

	async createSystem(actor: Actor, input: { id: string; name?: string; roles?: string[] }): Promise<System> {
		if (!actor.root) throw forbidden('Only roots can create systems');
		const id = validName('system id', input.id);
		const name = input.name?.trim() || id;
		// Only the registered roles: a system has no built-in ones.
		const roles = new Set((input.roles ?? []).map((r) => validName('role', r)));
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
		return { id, name, roles: [...roles].sort(), implies: {}, subscriberRole: null };
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
		await this.clearSubscriberRole(systemId, role);
		const vouchers = (await queryIndex(this.table, `VOUCHERS#${systemId}`)).filter((it) => it.role === role);
		await this.deleteVouchers(vouchers);
	}

	/**
	 * Sets the role paying Substack subscribers hold in a system (Q2), or none
	 * (null). The role must be in the catalog; removing it clears the setting.
	 */
	async setSubscriberRole(actor: Actor, systemId: string, rawRole: string | null): Promise<System> {
		requireRoot(actor, 'Only roots can configure systems');
		const meta = { PK: sysPK(systemId), SK: 'META' };
		if (rawRole === null) {
			try {
				await this.table.doc.send(
					new UpdateCommand({
						TableName: this.table.name,
						Key: meta,
						UpdateExpression: 'REMOVE subscriberRole',
						ConditionExpression: 'attribute_exists(PK)'
					})
				);
			} catch (err) {
				if ((err as Error).name === 'ConditionalCheckFailedException') throw notFound(`System "${systemId}" not found`);
				throw err;
			}
			return this.getSystem(actor, systemId);
		}
		const role = rawRole.trim().toLowerCase();
		// One transaction, so a concurrent removal of the role can't leave it configured.
		const reasons = await this.transact([
			{
				Update: {
					TableName: this.table.name,
					Key: meta,
					UpdateExpression: 'SET subscriberRole = :role',
					ConditionExpression: 'attribute_exists(PK)',
					ExpressionAttributeValues: { ':role': role }
				}
			},
			{ ConditionCheck: { TableName: this.table.name, Key: roleKey(systemId, role), ConditionExpression: 'attribute_exists(PK)' } }
		]);
		if (reasons?.[0] === 'ConditionalCheckFailed') throw notFound(`System "${systemId}" not found`);
		if (reasons) throw notFound(`Role "${role}" not found in "${systemId}"`);
		return this.getSystem(actor, systemId);
	}

	/** Clears a system's subscriber role if it is `role` (P2). */
	private async clearSubscriberRole(systemId: string, role: string): Promise<void> {
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					UpdateExpression: 'REMOVE subscriberRole',
					ConditionExpression: 'subscriberRole = :role',
					ExpressionAttributeValues: { ':role': role }
				})
			);
		} catch (err) {
			if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
		}
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
		const system = await this.loadSystem(systemId);
		if (!system) throw notFound(`System "${systemId}" not found`);
		const requireRole = (r: string) => {
			if (!system.roles.includes(r)) throw notFound(`Role "${r}" not found in "${systemId}"`);
		};
		requireRole(role);
		for (const r of implies) {
			if (r === role) throw badRequest(`A role cannot imply itself`);
			requireRole(r);
		}
		// A cycle through `role` exists if `role` is reachable from what it implies.
		const edges = new Map(Object.entries(system.implies));
		edges.set(role, implies);
		const reachable = closure(implies.flatMap((r) => edges.get(r) ?? []).concat(implies), edges);
		if (reachable.has(role)) throw badRequest(`"${role}" would end up implying itself`);
		const previous = system.implies[role] ?? [];
		// One transaction: the version, a check per role involved, and the changes.
		const size =
			1 +
			new Set([role, ...implies]).size +
			previous.filter((r) => !implies.includes(r)).length +
			implies.filter((r) => !previous.includes(r)).length;
		if (size > MAX_TRANSACTION_ITEMS) throw badRequest('Too many changes at once; change fewer implications per request');
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
				.map((r) => ({ Put: { TableName: this.table.name, Item: implicationItem(systemId, role, r) } }))
		]);
		if (reasons) throw new RbacError(409, 'The role catalog changed meanwhile; try again');
		return this.getSystem(actor, systemId);
	}

	// --- grants -------------------------------------------------------------

	async listGrants(actor: Actor, systemId: string): Promise<GrantWithImplied[]> {
		await this.getSystem(actor, systemId);
		return this.withImpliedRoles((await queryPrefix(this.table, sysPK(systemId), 'GRANT#')).map(toGrant));
	}

	private async withImplied(grant: Grant): Promise<GrantWithImplied> {
		return (await this.withImpliedRoles([grant]))[0];
	}

	/**
	 * Writes a grant, checking the role is in the catalog for system grants.
	 * A grantee holds a role through at most one grant, so an existing grant
	 * of that role is kept when `keep` says so, and otherwise replaced.
	 */
	private async putGrant(
		item: Item,
		keep: (existing: Grant) => boolean
	): Promise<{ grant: Grant; previous: Grant | null; written: boolean }> {
		const systemId = (item.systemId as string | undefined) ?? null;
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await this.get({ PK: item.PK, SK: item.SK });
			const previous = existing ? toGrant(existing) : null;
			if (previous && keep(previous)) return { grant: previous, previous, written: false };
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
				{ Put: { TableName: this.table.name, Item: item, ...unchangedSince(existing) } }
			]);
			if (!reasons) return { grant: toGrant(item), previous, written: true };
			if (systemId !== null && reasons[0] === 'ConditionalCheckFailed') {
				throw notFound(`Role "${item.role}" not found in "${systemId}"`);
			}
			// Otherwise the grant changed meanwhile: read it again.
		}
		throw new RbacError(409, 'The grant changed meanwhile; try again');
	}

	/**
	 * A root's grant (G2): sets the validity of the grantee's grant of that
	 * role. Re-granting with the same validity is idempotent and keeps the
	 * original; a different validity replaces it.
	 */
	private async rootGrant(actor: Actor, systemId: string | null, role: string, grantee: string, validity: Validity) {
		const item = grantItem(systemId, role, grantee, actor.email, this.now(), validity);
		const { grant } = await this.putGrant(item, (existing) => sameValidity(existing, validity));
		return this.withImplied(grant);
	}

	async grant(
		actor: Actor,
		systemId: string,
		role: string,
		rawGrantee: string,
		validity: Partial<Validity> = {}
	): Promise<GrantWithImplied> {
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}": use an e-mail address or a domain`);
		requireRoot(actor, 'Only roots can grant roles');
		return this.rootGrant(actor, systemId, role, grantee, validValidity(validity));
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
		requireRoot(actor, 'Only roots can revoke roles');
		await this.deleteGrant(systemId, role, grantee);
	}

	// --- global grants (roots only) -----------------------------------------

	async listGlobalGrants(actor: Actor): Promise<GrantWithImplied[]> {
		if (!actor.root) throw forbidden('Only roots can see global grants');
		return this.withImpliedRoles((await queryPrefix(this.table, GLOBAL_PK, 'GRANT#')).map(toGrant));
	}

	/** Grants `role` in every system that defines it, now or later. */
	async grantGlobal(
		actor: Actor,
		rawRole: string,
		rawGrantee: string,
		validity: Partial<Validity> = {}
	): Promise<GrantWithImplied> {
		if (!actor.root) throw forbidden('Only roots can grant global roles');
		const role = validName('role', rawRole);
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}": use an e-mail address or a domain`);
		return this.rootGrant(actor, null, role, grantee, validValidity(validity));
	}

	async revokeGlobal(actor: Actor, role: string, rawGrantee: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can revoke global roles');
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		await this.deleteGrant(null, role, grantee);
	}

	// --- subscription sync (Q1-Q4) -------------------------------------------

	/**
	 * Makes a paying subscriber hold, in every system that has one, that
	 * system's subscriber role for their subscription's current period, and
	 * takes it away when they stop paying (`period` null). Called by the
	 * Stripe webhook, not by a person, so it takes no actor. Only grants this
	 * sync made (grantedBy SUBSCRIPTION_GRANTOR) follow the period or are
	 * revoked, including those of roles no longer configured; a grant a root
	 * made by hand, or through a voucher, stays unless it has expired.
	 */
	async syncSubscriber(rawEmail: string, period: Validity | null): Promise<SubscriberSync[]> {
		const email = normalizeEmail(rawEmail);
		if (!email) throw badRequest(`Invalid subscriber address "${rawEmail}"`);
		const validity = period && validValidity(period);
		const now = this.now();
		const configured = validity
			? (await queryIndex(this.table, 'SYSTEMS')).filter((it) => it.subscriberRole).map((it) => ({
					systemId: it.id as string,
					role: it.subscriberRole as string
				}))
			: [];
		const out: SubscriberSync[] = [];
		const wanted = new Set<string>();
		for (const { systemId, role } of configured) {
			const item = grantItem(systemId, role, email, SUBSCRIPTION_GRANTOR, now, validity!);
			wanted.add(`${item.PK}|${item.SK}`);
			const { previous, written } = await this.putGrant(item, (existing) =>
				existing.grantedBy === SUBSCRIPTION_GRANTOR
					? sameValidity(existing, validity!)
					: grantStatus(existing, now) !== 'expired'
			);
			const outcome = !written ? 'unchanged' : previous?.grantedBy === SUBSCRIPTION_GRANTOR ? 'updated' : 'granted';
			out.push({ systemId, role, outcome });
		}
		const stale = (await queryIndex(this.table, `GRANTEE#${email}`)).filter(
			(it) => it.grantedBy === SUBSCRIPTION_GRANTOR && !wanted.has(`${it.PK}|${it.SK}`)
		);
		for (const it of stale) {
			try {
				await this.table.doc.send(
					new DeleteCommand({
						TableName: this.table.name,
						Key: { PK: it.PK, SK: it.SK },
						ConditionExpression: 'grantedBy = :by',
						ExpressionAttributeValues: { ':by': SUBSCRIPTION_GRANTOR }
					})
				);
				out.push({ systemId: (it.systemId as string | undefined) ?? null, role: it.role as string, outcome: 'revoked' });
			} catch (err) {
				if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
			}
		}
		return out;
	}

	// --- vouchers -------------------------------------------------------------

	async createVoucher(actor: Actor, input: VoucherInput): Promise<Voucher> {
		const { systemId } = input;
		const role = systemId === null ? validName('role', input.role) : input.role;
		requireRoot(actor, 'Only roots can create vouchers');
		const { startsAt, endsAt } = validValidity(input);
		const maxUses = input.maxUses ?? null;
		const discountPercent = input.discountPercent ?? 100;
		if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
			throw badRequest('The discount must be a whole percentage from 0 to 100');
		}
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

	/** Vouchers of a system, newest first (roots only). */
	async listVouchers(actor: Actor, systemId: string): Promise<Voucher[]> {
		await this.getSystem(actor, systemId);
		return (await queryIndex(this.table, `VOUCHERS#${systemId}`, { newestFirst: true })).map(toVoucher);
	}

	async disableVoucher(actor: Actor, rawCode: string): Promise<Voucher> {
		requireRoot(actor, 'Only roots can disable vouchers');
		const code = normalizeVoucherCode(rawCode);
		const existing = code ? await this.get(voucherKey(code)) : undefined;
		if (!existing) {
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
	 * whose conditions keep uses within maxUses. The grant starts now and
	 * never ends; it replaces an existing grant of that role unless that one
	 * already gives it now and forever (G3). A voucher with less than 100%
	 * discount needs payment, which isn't available yet: it fails with 402 and
	 * the voucher's terms, recording nothing.
	 */
	async redeemVoucher(email: string, rawCode: string): Promise<GrantWithImplied> {
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
		const forever = { startsAt: null, endsAt: null };
		const grant = grantItem(voucher.systemId, voucher.role, email, voucher.createdBy, now, forever, code);
		for (let attempt = 0; attempt < 2; attempt++) {
			const found = await this.get({ PK: grant.PK, SK: grant.SK });
			const previous = found ? toGrant(found) : null;
			const kept = previous && previous.endsAt === null && grantStatus(previous, now) === 'active' ? previous : null;
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
				// A grant that already gives the role now and forever is kept.
				...(kept ? [] : [{ Put: { TableName: this.table.name, Item: grant, ...unchangedSince(found) } }])
			]);
			if (!reasons) return this.withImplied(kept ?? toGrant(grant));
			if (reasons[0] === 'ConditionalCheckFailed') {
				requireActive(await this.get(voucherKey(code)));
				throw new RbacError(409, 'This voucher has no uses left');
			}
			if (reasons[1] === 'ConditionalCheckFailed') throw new RbacError(409, 'You have already redeemed this voucher');
			// Otherwise the grant changed meanwhile: retry with it.
		}
		throw new RbacError(409, 'The voucher changed meanwhile; try again');
	}

	// --- role queries (the external API) -------------------------------------

	private queriedEmail(raw: string): string {
		const email = normalizeEmail(raw);
		if (!email) throw badRequest(`Invalid e-mail address "${raw}"`);
		return email;
	}

	/** Who may ask about whose roles (T6): anyone about themselves, roots about anyone. */
	private requireCanQuery(actor: Actor, email: string): void {
		if (actor.root || actor.email === email) return;
		throw forbidden("Only roots can ask about other people's roles");
	}

	/**
	 * Whether `email` holds `role` in `systemId` (granted or implied), or holds
	 * the global role `role` when systemId is null. Same rules as
	 * rolesOf/globalRolesOf.
	 */
	async hasRole(actor: Actor, rawEmail: string, systemId: string | null, rawRole: string): Promise<boolean> {
		return (await this.checkRole(actor, rawEmail, systemId, rawRole)).allowed;
	}

	/**
	 * hasRole, plus how long the answer holds (C3a): when allowed, the latest
	 * end of the grants valid now that give the role (null: they never end,
	 * as for roots). Revoking a grant can end it sooner.
	 */
	async checkRole(actor: Actor, rawEmail: string, systemId: string | null, rawRole: string): Promise<RoleCheck> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email);
		const role = rawRole.trim().toLowerCase();
		const denied: RoleCheck = { allowed: false, expiresAt: null };
		if (systemId === null) {
			if (this.isRoot(email)) return role === ROOT_ROLE ? { allowed: true, expiresAt: null } : denied;
			const items = (await this.grantItemsOf(email)).filter((it) => it.PK === GLOBAL_PK && it.role === role);
			if (!items.length) return denied;
			return { allowed: true, expiresAt: items.reduce<Date | null | undefined>((e, it) => laterEnd(e, date(it.endsAt)), undefined)! };
		}
		await this.requireSystem(systemId);
		if (!(await this.get(roleKey(systemId, role)))) throw notFound(`Role "${role}" not found in "${systemId}"`);
		if (this.isRoot(email)) return { allowed: true, expiresAt: null };
		const ends = (await this.grantedRoleEnds(email)).get(systemId);
		if (!ends?.has(role)) return denied;
		return { allowed: true, expiresAt: ends.get(role)! };
	}

	/** An identity's roles in one system (sorted). */
	async rolesIn(actor: Actor, rawEmail: string, systemId: string): Promise<string[]> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email);
		await this.requireSystem(systemId);
		return (await this.rolesOf(email))[systemId] ?? [];
	}

	/** An identity's roles in every system and its global roles. */
	async allRoles(actor: Actor, rawEmail: string): Promise<{ globalRoles: string[]; roles: RoleMap }> {
		const email = this.queriedEmail(rawEmail);
		this.requireCanQuery(actor, email);
		return { globalRoles: await this.globalRolesOf(email), roles: await this.rolesOf(email) };
	}

	private async requireSystem(systemId: string): Promise<void> {
		if (!(await this.get({ PK: sysPK(systemId), SK: 'META' }))) throw notFound(`System "${systemId}" not found`);
	}
}
