import { GetCommand, PutCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { cancellationReasons, queryAll, queryIndex, queryPrefix, type Item, type Table } from './dynamo';
import { Allowlist, granteesFor, normalizeEmail, parseGrantee } from './identity';
import { MAX_CODE_LENGTH, MIN_CODE_LENGTH, compactVoucherCode, normalizeVoucherCode, suggestVoucherCode } from '../vouchers';

/**
 * The only built-in role (R1, R2): held by every identity on RBACR_ROOT_LIST,
 * it implies every role of every system and is what lets an identity manage
 * rbacr. Every other role, and every implication, is registered data.
 */
export const ROOT_ROLE = 'root';

/**
 * The grantee of a role every identity holds (R9): its grant is to this,
 * not to an address or domain. Grants to it come only from the role's
 * `everyone` property, never from the grants API.
 */
export const EVERYONE = '*';

/** Longest system URL accepted. */
const MAX_URL_LENGTH = 2048;

/** The `grantedBy` of grants made by the paid-subscription sync (Q2). */
export const SUBSCRIPTION_GRANTOR = 'stripe';

const NAME_RE = /^[a-z0-9][a-z0-9_.:-]{0,62}$/;

/** Terms of a voucher that needs payment (a discount under 100%). */
export interface PaymentRequired {
	code: string;
	systemId: string | null;
	roles: string[];
	/** The first of `roles`, for clients that predate several roles per voucher. */
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
	/** Roles every identity holds here (R9), sorted. */
	everyone: string[];
	/** Where the system's users go (http or https), which pages link role names to; null for none. */
	url: string | null;
	/** In maintenance (R11), role queries give nobody any role here. */
	maintenance: boolean;
}

/** What any token may see of a system (R12): enough for its application to check it. */
export interface SystemStatus {
	id: string;
	name: string;
	url: string | null;
	maintenance: boolean;
}

/** Where a redemption came from: the external API or the pages (the VPI). */
export type RedeemVia = 'api' | 'page';

/** What redeeming did to one of the voucher's roles (V7). */
export interface RedeemedGrant {
	systemId: string | null;
	role: string;
	/**
	 * granted: there was no live grant; kept: one already gave the role now
	 * and forever, so it stayed (G3); replaced: the live grant (`replaced`)
	 * gave way to the voucher's.
	 */
	outcome: 'granted' | 'kept' | 'replaced';
	/** The live grant it replaced (outcome replaced), as it was. */
	replaced: { grantedBy: string; grantedAt: Date; startsAt: Date | null; endsAt: Date | null; voucherCode: string | null } | null;
}

/**
 * A voucher redemption, kept for good (V7, L1): the voucher's terms at the
 * time, who redeemed it, when, how, and what it did to each role. Records
 * from before V7 have only `email` and `redeemedAt`; the rest is null.
 */
export interface RedeemEvent {
	id: string | null;
	code: string;
	systemId: string | null;
	roles: string[];
	discountPercent: number | null;
	voucherCreatedBy: string | null;
	email: string;
	redeemedAt: Date;
	via: RedeemVia | null;
	grants: RedeemedGrant[];
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
	/** The roles redeeming it grants, sorted (V1). */
	roles: string[];
	/** The first of `roles`, for clients that predate several roles per voucher. */
	role: string;
	/** 100 grants the roles on redemption; anything lower requires payment (not available yet). */
	discountPercent: number;
	startsAt: Date | null;
	endsAt: Date | null;
	maxUses: number | null;
	uses: number;
	createdBy: string;
	createdAt: Date;
	disabledAt: Date | null;
	/** Who disabled it: a root, directly or by removing its role or system (L3). */
	disabledBy: string | null;
}

export interface VoucherInput {
	/** null for a global voucher (roots only). */
	systemId: string | null;
	roles: string[];
	/** The code to give it; omitted, one is made up (V2). */
	code?: string | null;
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

/** An absolute http or https URL, as given; anything else (javascript:, data:, relative) is refused. */
export function validUrl(raw: string): string {
	const value = raw.trim();
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw badRequest(`Invalid URL "${raw}"`);
	}
	if (url.protocol !== 'https:' && url.protocol !== 'http:') throw badRequest('A system URL must start with https:// or http://');
	if (value.length > MAX_URL_LENGTH) throw badRequest(`A system URL can have at most ${MAX_URL_LENGTH} characters`);
	return value;
}

/** Management (systems, catalogs, grants, vouchers) is for roots only (P1). */
function requireRoot(actor: Actor, message = 'Only roots can do this'): void {
	if (!actor.root) throw forbidden(message);
}

/** Most roles one voucher may grant: redeeming writes them all in one transaction. */
export const MAX_VOUCHER_ROLES = 20;

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
 *   voucher     PK VOUCHER#<key>  SK META                      GSI1 VOUCHERS#<id, or * if global> / <createdAt>#<code>
 *   redemption  PK VOUCHER#<key>  SK REDEEMED#<email>       (the RedeemEvent, V7)
 *               (<key> is the code's letters and digits, V2; vouchers made before
 *               custom codes are keyed by their XXXX-XXXX-XXXX-XXXX code)
 *   history     PK as the item   SK HIST#<its SK>#<when it was deleted>  (L4)
 *
 * Nothing is deleted (L1): a revoked grant carries revokedAt / revokedBy, a
 * removed role or implication removedAt / removedBy, a deleted system
 * deletedAt / deletedBy, a disabled voucher disabledAt / disabledBy, and
 * reads skip them. Before a key is reused, its deleted item is copied to a
 * history item, which keeps the original's attributes (GSI1 keys included).
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
const voucherKey = (code: string) => ({ PK: `VOUCHER#${compactVoucherCode(code)}`, SK: 'META' });
/** Where a voucher made before custom codes lives: its 16 random characters in groups of four. */
const legacyVoucherKey = (code: string) => {
	const compact = compactVoucherCode(code);
	return compact.length === 16 ? { PK: `VOUCHER#${compact.match(/.{4}/g)!.join('-')}`, SK: 'META' } : null;
};
/** A voucher's roles; vouchers made before several roles per voucher hold one `role`. */
const rolesOfVoucher = (it: Item): string[] => (it.roles as string[] | undefined) ?? [it.role as string];
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);
const date = (v: unknown) => (v ? new Date(v as string) : null);

/** How each kind of item is logically deleted (L1): its `<kind>At` and `<kind>By` attributes. */
type Deletion = 'revoked' | 'removed' | 'deleted' | 'disabled';

/** The attribute marking a grant, role, implication or system as deleted, and when, if it is. */
function deletion(it: Item | undefined): { attr: string; at: string } | null {
	for (const attr of ['revokedAt', 'removedAt', 'deletedAt']) if (it?.[attr]) return { attr, at: it[attr] as string };
	return null;
}

/** Not logically deleted (L2). */
const live = (it: Item) => !deletion(it);

/** Conditions for a role, or a system's META, that exists and isn't deleted. */
const LIVE_ROLE = 'attribute_exists(PK) AND attribute_not_exists(removedAt)';
const LIVE_SYSTEM = 'attribute_exists(PK) AND attribute_not_exists(deletedAt)';

/** Writes an item only where there is none, or where `old`, a deleted item already archived, still is (L4). */
function freeOrStill(old: Item | undefined) {
	const d = deletion(old);
	return d
		? { ConditionExpression: '#deleted = :deleted', ExpressionAttributeNames: { '#deleted': d.attr }, ExpressionAttributeValues: { ':deleted': d.at } }
		: { ConditionExpression: 'attribute_not_exists(PK)' };
}

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

/**
 * Replaces an existing grant only if nobody changed (or revoked) it since it
 * was read; otherwise writes a new one. A revoked grant must be archived first (L4).
 */
const unchangedSince = (existing: Item | undefined) =>
	!existing
		? { ConditionExpression: 'attribute_not_exists(PK)' }
		: existing.revokedAt
			? {
					ConditionExpression: 'grantedAt = :was AND revokedAt = :revoked',
					ExpressionAttributeValues: { ':was': existing.grantedAt, ':revoked': existing.revokedAt }
				}
			: {
					ConditionExpression: 'grantedAt = :was AND attribute_not_exists(revokedAt)',
					ExpressionAttributeValues: { ':was': existing.grantedAt }
				};

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
	roles: rolesOfVoucher(it),
	role: rolesOfVoucher(it)[0],
	discountPercent: it.discountPercent as number,
	startsAt: date(it.startsAt),
	endsAt: date(it.endsAt),
	maxUses: (it.maxUses as number | undefined) ?? null,
	uses: it.uses as number,
	createdBy: it.createdBy as string,
	createdAt: new Date(it.createdAt as string),
	disabledAt: date(it.disabledAt),
	disabledBy: (it.disabledBy as string | undefined) ?? null
});

/** A redemption record as a RedeemEvent (V7); records from before V7 hold only who and when. */
const toRedeemEvent = (it: Item, voucher: Voucher): RedeemEvent => ({
	id: (it.id as string | undefined) ?? null,
	code: (it.code as string | undefined) ?? voucher.code,
	systemId: it.type ? ((it.systemId as string | undefined) ?? null) : voucher.systemId,
	roles: (it.roles as string[] | undefined) ?? [],
	discountPercent: (it.discountPercent as number | undefined) ?? null,
	voucherCreatedBy: (it.voucherCreatedBy as string | undefined) ?? null,
	email: it.email as string,
	redeemedAt: new Date(it.redeemedAt as string),
	via: (it.via as RedeemVia | undefined) ?? null,
	grants: ((it.grants as Item[] | undefined) ?? []).map((g) => {
		const r = g.replaced as Item | undefined;
		return {
			systemId: (g.systemId as string | undefined) ?? null,
			role: g.role as string,
			outcome: g.outcome as RedeemedGrant['outcome'],
			replaced: r
				? {
						grantedBy: r.grantedBy as string,
						grantedAt: new Date(r.grantedAt as string),
						startsAt: date(r.startsAt),
						endsAt: date(r.endsAt),
						voucherCode: (r.voucherCode as string | undefined) ?? null
					}
				: null
		};
	})
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

	/**
	 * Marks items as logically deleted (L1) by `by` at `at`, keeping an
	 * earlier mark. Items that no longer exist are skipped.
	 */
	private async mark(items: Item[], kind: Deletion, by: string, at: string): Promise<void> {
		for (let i = 0; i < items.length; i += 25) {
			await Promise.all(
				items.slice(i, i + 25).map((it) =>
					this.table.doc
						.send(
							new UpdateCommand({
								TableName: this.table.name,
								Key: { PK: it.PK, SK: it.SK },
								UpdateExpression: 'SET #at = if_not_exists(#at, :at), #by = if_not_exists(#by, :by)',
								ConditionExpression: 'attribute_exists(PK)',
								ExpressionAttributeNames: { '#at': `${kind}At`, '#by': `${kind}By` },
								ExpressionAttributeValues: { ':at': at, ':by': by }
							})
						)
						.catch((err) => {
							if ((err as Error).name !== 'ConditionalCheckFailedException') throw err;
						})
				)
			);
		}
	}

	/**
	 * Copies a deleted item to its history key (L4) before its key is reused,
	 * so the deletion stays on record. Idempotent; does nothing for live items.
	 */
	private async archive(item: Item | undefined): Promise<void> {
		const d = deletion(item);
		if (!item || !d) return;
		await this.table.doc.send(new PutCommand({ TableName: this.table.name, Item: { ...item, SK: `HIST#${item.SK}#${d.at}` } }));
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
		const grantees = [...granteesFor(email), EVERYONE];
		const pages = await Promise.all(grantees.map((g) => queryIndex(this.table, `GRANTEE#${g}`)));
		return pages.flat().filter((it) => live(it) && it.role !== ROOT_ROLE && grantStatus(toGrant(it), now) === 'active');
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
		return Object.fromEntries(systems.map((s) => [s.id, s.maintenance ? [] : s.roles]));
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
		const defining = await Promise.all([...globalEnds.keys()].map((r) => this.definingSystems(r)));
		for (const roles of defining) for (const it of roles) add(it.systemId as string, it.name as string, globalEnds.get(it.name as string)!);
		const out = new Map<string, Map<string, Date | null>>();
		for (const systemId of [...held.keys()].sort()) {
			const system = await this.loadSystem(systemId);
			if (!system) continue;
			// In maintenance the system gives no roles (R11); its grants stay as they are.
			if (system.maintenance) {
				out.set(systemId, new Map());
				continue;
			}
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
				const defining = (await this.definingSystems(g.role)).map((it) => it.systemId as string).sort();
				const bySystem: Record<string, string[]> = {};
				for (const id of defining) bySystem[id] = await implied(id, g.role);
				return { ...g, status, impliedRoles: [], impliedRolesBySystem: bySystem };
			})
		);
	}

	// --- systems & role catalog -------------------------------------------

	/** The live role items named `role`, one per system whose catalog has it. */
	private async definingSystems(role: string): Promise<Item[]> {
		return (await queryIndex(this.table, `ROLENAME#${role}`)).filter(live);
	}

	/** A system's catalog items, deleted ones included: its META, roles and implications (not its grants). */
	private catalogItems(systemId: string): Promise<Item[]> {
		// Sort keys: GRANT# < HIST# < IMPL# < META < ROLE#.
		return queryAll(this.table, {
			KeyConditionExpression: 'PK = :pk AND SK >= :from',
			ExpressionAttributeValues: { ':pk': sysPK(systemId), ':from': 'IMPL#' },
			ConsistentRead: true
		});
	}

	/** A system with its catalog: its registered roles and implications. */
	private async loadSystem(systemId: string): Promise<(System & { implVersion: number }) | null> {
		const items = (await this.catalogItems(systemId)).filter(live);
		const meta = items.find((it) => it.SK === 'META');
		if (!meta) return null;
		const implies: Record<string, string[]> = {};
		for (const it of items.filter((it) => (it.SK as string).startsWith('IMPL#'))) {
			(implies[it.role as string] ??= []).push(it.implies as string);
		}
		const roleItems = items.filter((it) => (it.SK as string).startsWith('ROLE#'));
		return {
			id: systemId,
			name: meta.name as string,
			roles: roleItems.map((it) => it.name as string),
			implies,
			subscriberRole: (meta.subscriberRole as string | undefined) ?? null,
			everyone: roleItems.filter((it) => it.everyone === true).map((it) => it.name as string),
			url: (meta.url as string | undefined) ?? null,
			maintenance: meta.maintenance === true,
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

	/**
	 * A system's status (R12): its name, URL and whether it is in maintenance
	 * (R11). Anyone may ask, so an application holding only its users' own
	 * tokens can tell maintenance from a missing role.
	 */
	async systemStatus(systemId: string): Promise<SystemStatus> {
		const meta = await this.get({ PK: sysPK(systemId), SK: 'META' });
		if (!meta || !live(meta)) throw notFound(`System "${systemId}" not found`);
		return {
			id: systemId,
			name: meta.name as string,
			url: (meta.url as string | undefined) ?? null,
			maintenance: meta.maintenance === true
		};
	}

	async createSystem(actor: Actor, input: { id: string; name?: string; roles?: string[] }): Promise<System> {
		if (!actor.root) throw forbidden('Only roots can create systems');
		const id = validName('system id', input.id);
		const name = input.name?.trim() || id;
		// Only the registered roles: a system has no built-in ones.
		const roles = new Set((input.roles ?? []).map((r) => validName('role', r)));
		if (roles.size > MAX_INITIAL_ROLES) throw badRequest(`Create at most ${MAX_INITIAL_ROLES} roles at once`);
		const now = this.now().toISOString();
		// A deleted system's id can be used again; its deleted items are archived first (L4).
		const old = new Map((await this.catalogItems(id)).map((it) => [it.SK as string, it]));
		if (old.has('META') && live(old.get('META')!)) throw new RbacError(409, `System "${id}" already exists`);
		for (const sk of ['META', ...[...roles].map((r) => `ROLE#${r}`)]) await this.archive(old.get(sk));
		const reasons = await this.transact([
			{
				Put: {
					TableName: this.table.name,
					Item: { PK: sysPK(id), SK: 'META', GSI1PK: 'SYSTEMS', GSI1SK: id, id, name, createdBy: actor.email, createdAt: now },
					...freeOrStill(old.get('META'))
				}
			},
			...[...roles].map((role) => ({
				Put: {
					TableName: this.table.name,
					Item: { ...roleKey(id, role), GSI1PK: `ROLENAME#${role}`, GSI1SK: id, systemId: id, name: role, createdAt: now },
					...freeOrStill(old.get(`ROLE#${role}`))
				}
			}))
		]);
		if (reasons) throw new RbacError(409, `System "${id}" already exists`);
		return { id, name, roles: [...roles].sort(), implies: {}, subscriberRole: null, everyone: [], url: null, maintenance: false };
	}

	/**
	 * Deletes a system logically (L1, L3): disables its vouchers, revokes its
	 * grants, removes its implications and roles, then marks it deleted.
	 */
	async deleteSystem(actor: Actor, systemId: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can delete systems');
		const meta = await this.get({ PK: sysPK(systemId), SK: 'META' });
		if (!meta || !live(meta)) throw notFound(`System "${systemId}" not found`);
		const at = this.now().toISOString();
		// Not atomic: everything else goes first, so a failure leaves the
		// system listed and the delete can be retried.
		const items = (
			await queryAll(this.table, { KeyConditionExpression: 'PK = :pk', ExpressionAttributeValues: { ':pk': sysPK(systemId) } })
		).filter(live);
		const sk = (it: Item) => it.SK as string;
		await this.disableVouchers(await queryIndex(this.table, `VOUCHERS#${systemId}`), actor.email, at);
		await this.mark(items.filter((it) => sk(it).startsWith('GRANT#')), 'revoked', actor.email, at);
		await this.mark(items.filter((it) => sk(it).startsWith('IMPL#') || sk(it).startsWith('ROLE#')), 'removed', actor.email, at);
		await this.mark([meta], 'deleted', actor.email, at);
	}

	/** Disables the vouchers not disabled yet (L3); their redemptions stay. */
	private async disableVouchers(vouchers: Item[], by: string, at: string): Promise<void> {
		await this.mark(vouchers.filter((v) => !v.disabledAt), 'disabled', by, at);
	}

	async addRole(actor: Actor, systemId: string, rawRole: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can define roles');
		const role = validName('role', rawRole);
		await this.getSystem(actor, systemId);
		// A removed role can be added again; its removal is archived first (L4).
		const old = await this.get(roleKey(systemId, role));
		if (old && live(old)) throw new RbacError(409, `Role "${role}" already exists`);
		await this.archive(old);
		const reasons = await this.transact([
			{
				ConditionCheck: {
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					ConditionExpression: LIVE_SYSTEM
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
					...freeOrStill(old)
				}
			}
		]);
		if (reasons?.[0] === 'ConditionalCheckFailed') throw notFound(`System "${systemId}" not found`);
		if (reasons) throw new RbacError(409, `Role "${role}" already exists`);
	}

	/**
	 * Removes a role from the catalog logically (L1, L3), revoking its grants,
	 * removing its implications and disabling its vouchers.
	 */
	async removeRole(actor: Actor, systemId: string, role: string): Promise<void> {
		if (!actor.root) throw forbidden('Only roots can remove roles');
		const at = this.now().toISOString();
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: roleKey(systemId, role),
					UpdateExpression: 'SET removedAt = :at, removedBy = :by',
					ConditionExpression: LIVE_ROLE,
					ExpressionAttributeValues: { ':at': at, ':by': actor.email }
				})
			);
		} catch (err) {
			if ((err as Error).name === 'ConditionalCheckFailedException') throw notFound(`Role "${role}" not found in "${systemId}"`);
			throw err;
		}
		// The role is removed first, so nothing new can be granted or implied
		// with it (those writes check it is live) while the rest is marked.
		const grants = (await queryPrefix(this.table, sysPK(systemId), `GRANT#${role}#`)).filter(live);
		const implications = (await queryPrefix(this.table, sysPK(systemId), 'IMPL#')).filter(
			(it) => live(it) && (it.role === role || it.implies === role)
		);
		await this.mark(grants, 'revoked', actor.email, at);
		await this.mark(implications, 'removed', actor.email, at);
		await this.clearSubscriberRole(systemId, role);
		const vouchers = (await queryIndex(this.table, `VOUCHERS#${systemId}`)).filter((it) => rolesOfVoucher(it).includes(role));
		await this.disableVouchers(vouchers, actor.email, at);
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
						ConditionExpression: LIVE_SYSTEM
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
					ConditionExpression: LIVE_SYSTEM,
					ExpressionAttributeValues: { ':role': role }
				}
			},
			{ ConditionCheck: { TableName: this.table.name, Key: roleKey(systemId, role), ConditionExpression: LIVE_ROLE } }
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

	/** Applies the system settings given (Q2, R10, R11); at least one is required. */
	async configureSystem(
		actor: Actor,
		systemId: string,
		settings: { subscriberRole?: string | null; url?: string | null; maintenance?: boolean }
	): Promise<System> {
		const { subscriberRole, url, maintenance } = settings;
		if (subscriberRole === undefined && url === undefined && maintenance === undefined) {
			throw badRequest('Give "subscriberRole", "url" (null clears either) or "maintenance"');
		}
		let system: System | undefined;
		if (subscriberRole !== undefined) system = await this.setSubscriberRole(actor, systemId, subscriberRole);
		if (url !== undefined) system = await this.setSystemUrl(actor, systemId, url);
		if (maintenance !== undefined) system = await this.setMaintenance(actor, systemId, maintenance);
		return system!;
	}

	/**
	 * Puts a system in maintenance or takes it out (R11). In maintenance role
	 * queries answer no roles for it, so its application can be fixed while
	 * nobody is let in; grants, implications and vouchers are untouched and
	 * give their roles again once it is off.
	 */
	async setMaintenance(actor: Actor, systemId: string, maintenance: boolean): Promise<System> {
		requireRoot(actor, 'Only roots can configure systems');
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					UpdateExpression: maintenance ? 'SET maintenance = :yes' : 'REMOVE maintenance',
					ConditionExpression: LIVE_SYSTEM,
					...(maintenance && { ExpressionAttributeValues: { ':yes': true } })
				})
			);
		} catch (err) {
			if ((err as Error).name === 'ConditionalCheckFailedException') throw notFound(`System "${systemId}" not found`);
			throw err;
		}
		return this.getSystem(actor, systemId);
	}

	/** Applies the role settings given (R7, R9); at least one is required. */
	async configureRole(
		actor: Actor,
		systemId: string,
		role: string,
		settings: { implies?: string[]; everyone?: boolean }
	): Promise<System> {
		if (settings.implies === undefined && settings.everyone === undefined) {
			throw badRequest('Give "implies" or "everyone"');
		}
		let system: System | undefined;
		if (settings.implies !== undefined) system = await this.setImplications(actor, systemId, role, settings.implies);
		if (settings.everyone !== undefined) system = await this.setEveryone(actor, systemId, role, settings.everyone);
		return system!;
	}

	/**
	 * Makes every identity hold `role` in a system, or stops it (R9): a grant
	 * to EVERYONE, written together with the role's `everyone` flag, which the
	 * catalog shows. Removing the role revokes that grant like any other (L3).
	 */
	async setEveryone(actor: Actor, systemId: string, rawRole: string, everyone: boolean): Promise<System> {
		requireRoot(actor, 'Only roots can configure roles');
		const role = rawRole.trim().toLowerCase();
		const flag = {
			Update: {
				TableName: this.table.name,
				Key: roleKey(systemId, role),
				UpdateExpression: everyone ? 'SET everyone = :yes' : 'REMOVE everyone',
				ConditionExpression: LIVE_ROLE,
				...(everyone && { ExpressionAttributeValues: { ':yes': true } })
			}
		};
		for (let attempt = 0; attempt < 3; attempt++) {
			const existing = await this.get(grantKey(systemId, role, EVERYONE));
			const held = existing && live(existing) ? toGrant(existing) : null;
			let change;
			if (everyone) {
				// A grant that already gives the role now and forever is kept.
				const forever = { startsAt: null, endsAt: null };
				if (!(held && sameValidity(held, forever) && grantStatus(held, this.now()) === 'active')) {
					await this.archive(existing);
					const item = grantItem(systemId, role, EVERYONE, actor.email, this.now(), forever);
					change = { Put: { TableName: this.table.name, Item: item, ...unchangedSince(existing) } };
				}
			} else if (held) {
				change = {
					Update: {
						TableName: this.table.name,
						Key: grantKey(systemId, role, EVERYONE),
						UpdateExpression: 'SET revokedAt = :at, revokedBy = :by',
						ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(revokedAt)',
						ExpressionAttributeValues: { ':at': this.now().toISOString(), ':by': actor.email }
					}
				};
			}
			const reasons = await this.transact([flag, ...(change ? [change] : [])]);
			if (!reasons) return this.getSystem(actor, systemId);
			if (reasons[0] === 'ConditionalCheckFailed') throw notFound(`Role "${role}" not found in "${systemId}"`);
			// Otherwise the grant changed meanwhile: read it again.
		}
		throw new RbacError(409, 'The role changed meanwhile; try again');
	}

	/**
	 * Sets where a system's users go (an http or https URL), which the pages
	 * link its role names to, or none (null).
	 */
	async setSystemUrl(actor: Actor, systemId: string, rawUrl: string | null): Promise<System> {
		requireRoot(actor, 'Only roots can configure systems');
		const url = rawUrl === null ? null : validUrl(rawUrl);
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: { PK: sysPK(systemId), SK: 'META' },
					UpdateExpression: url === null ? 'REMOVE #url' : 'SET #url = :url',
					ConditionExpression: LIVE_SYSTEM,
					ExpressionAttributeNames: { '#url': 'url' },
					...(url !== null && { ExpressionAttributeValues: { ':url': url } })
				})
			);
		} catch (err) {
			if ((err as Error).name === 'ConditionalCheckFailedException') throw notFound(`System "${systemId}" not found`);
			throw err;
		}
		return this.getSystem(actor, systemId);
	}

	/**
	 * The URLs of the given systems that have one (anyone may ask: the pages
	 * link the roles a person holds to their systems).
	 */
	async systemUrls(systemIds: string[]): Promise<Record<string, string>> {
		const metas = await Promise.all([...new Set(systemIds)].map((id) => this.get({ PK: sysPK(id), SK: 'META' })));
		return Object.fromEntries(metas.filter((m) => m && live(m) && m.url).map((m) => [m!.id as string, m!.url as string]));
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
		const at = this.now().toISOString();
		// Implications removed earlier are archived before being added again (L4).
		const removed = new Map(
			(await queryPrefix(this.table, sysPK(systemId), `IMPL#${role}#`)).filter((it) => !live(it)).map((it) => [it.implies as string, it])
		);
		for (const r of implies.filter((r) => !previous.includes(r))) await this.archive(removed.get(r));
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
						? 'implVersion = :cur AND attribute_not_exists(deletedAt)'
						: `${LIVE_SYSTEM} AND attribute_not_exists(implVersion)`,
					ExpressionAttributeValues: {
						':next': system.implVersion + 1,
						...(system.implVersion && { ':cur': system.implVersion })
					}
				}
			},
			...[...new Set([role, ...implies])].map((r) => ({
				ConditionCheck: { TableName: this.table.name, Key: roleKey(systemId, r), ConditionExpression: LIVE_ROLE }
			})),
			...previous
				.filter((r) => !implies.includes(r))
				.map((r) => ({
					Update: {
						TableName: this.table.name,
						Key: { PK: sysPK(systemId), SK: `IMPL#${role}#${r}` },
						UpdateExpression: 'SET removedAt = :at, removedBy = :by',
						ExpressionAttributeValues: { ':at': at, ':by': actor.email }
					}
				})),
			...implies
				.filter((r) => !previous.includes(r))
				.map((r) => ({
					Put: { TableName: this.table.name, Item: implicationItem(systemId, role, r), ...freeOrStill(removed.get(r)) }
				}))
		]);
		if (reasons) throw new RbacError(409, 'The role catalog changed meanwhile; try again');
		return this.getSystem(actor, systemId);
	}

	// --- grants -------------------------------------------------------------

	async listGrants(actor: Actor, systemId: string): Promise<GrantWithImplied[]> {
		await this.getSystem(actor, systemId);
		// Grants to everyone show as their role's `everyone` property instead (R9).
		const items = (await queryPrefix(this.table, sysPK(systemId), 'GRANT#')).filter((it) => live(it) && it.grantee !== EVERYONE);
		return this.withImpliedRoles(items.map(toGrant));
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
			const previous = existing && live(existing) ? toGrant(existing) : null;
			if (previous && keep(previous)) return { grant: previous, previous, written: false };
			await this.archive(existing);
			const reasons = await this.transact([
				...(systemId === null
					? []
					: [
							{
								ConditionCheck: {
									TableName: this.table.name,
									Key: roleKey(systemId, item.role as string),
									ConditionExpression: LIVE_ROLE
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

	/** Revokes a live grant logically (L1): it stays, with who revoked it and when. */
	private async revokeGrant(actor: Actor, systemId: string | null, role: string, grantee: string): Promise<void> {
		try {
			await this.table.doc.send(
				new UpdateCommand({
					TableName: this.table.name,
					Key: grantKey(systemId, role, grantee),
					UpdateExpression: 'SET revokedAt = :at, revokedBy = :by',
					ConditionExpression: 'attribute_exists(PK) AND attribute_not_exists(revokedAt)',
					ExpressionAttributeValues: { ':at': this.now().toISOString(), ':by': actor.email }
				})
			);
		} catch (err) {
			if ((err as Error).name === 'ConditionalCheckFailedException') throw notFound('Grant not found');
			throw err;
		}
	}

	async revoke(actor: Actor, systemId: string, role: string, rawGrantee: string): Promise<void> {
		const grantee = parseGrantee(rawGrantee);
		if (!grantee) throw badRequest(`Invalid grantee "${rawGrantee}"`);
		requireRoot(actor, 'Only roots can revoke roles');
		await this.revokeGrant(actor, systemId, role, grantee);
	}

	// --- global grants (roots only) -----------------------------------------

	async listGlobalGrants(actor: Actor): Promise<GrantWithImplied[]> {
		if (!actor.root) throw forbidden('Only roots can see global grants');
		return this.withImpliedRoles((await queryPrefix(this.table, GLOBAL_PK, 'GRANT#')).filter(live).map(toGrant));
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
		await this.revokeGrant(actor, null, role, grantee);
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
			? (await queryIndex(this.table, 'SYSTEMS')).filter((it) => live(it) && it.subscriberRole).map((it) => ({
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
			(it) => live(it) && it.grantedBy === SUBSCRIPTION_GRANTOR && !wanted.has(`${it.PK}|${it.SK}`)
		);
		for (const it of stale) {
			try {
				await this.table.doc.send(
					new UpdateCommand({
						TableName: this.table.name,
						Key: { PK: it.PK, SK: it.SK },
						UpdateExpression: 'SET revokedAt = :at, revokedBy = :by',
						ConditionExpression: 'grantedBy = :by AND attribute_not_exists(revokedAt)',
						ExpressionAttributeValues: { ':at': now.toISOString(), ':by': SUBSCRIPTION_GRANTOR }
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
		requireRoot(actor, 'Only roots can create vouchers');
		const roles = [...new Set(input.roles.map((r) => validName('role', r)))].sort();
		if (!roles.length) throw badRequest('A voucher needs at least one role');
		if (roles.length > MAX_VOUCHER_ROLES) throw badRequest(`A voucher can grant at most ${MAX_VOUCHER_ROLES} roles`);
		const { startsAt, endsAt } = validValidity(input);
		const maxUses = input.maxUses ?? null;
		const discountPercent = input.discountPercent ?? 100;
		if (!Number.isInteger(discountPercent) || discountPercent < 0 || discountPercent > 100) {
			throw badRequest('The discount must be a whole percentage from 0 to 100');
		}
		if (maxUses !== null && (!Number.isInteger(maxUses) || maxUses < 1)) {
			throw badRequest('Usage count must be a positive integer');
		}
		const custom = input.code ? normalizeVoucherCode(input.code) : null;
		if (custom !== null) {
			const length = compactVoucherCode(custom).length;
			if (length < MIN_CODE_LENGTH || length > MAX_CODE_LENGTH) {
				throw badRequest(`A code needs ${MIN_CODE_LENGTH} to ${MAX_CODE_LENGTH} letters and digits`);
			}
		}
		const createdAt = this.now();
		// A made-up code is retried on the (unlikely) clash with an existing one.
		for (let attempt = 0; attempt < (custom ? 1 : 3); attempt++) {
			const code = custom ?? suggestVoucherCode(createdAt);
			const legacy = legacyVoucherKey(code);
			const item: Item = {
				...voucherKey(code),
				GSI1PK: `VOUCHERS#${systemId ?? GLOBAL_VOUCHERS}`,
				GSI1SK: `${createdAt.toISOString()}#${code}`,
				code,
				systemId: systemId ?? undefined,
				roles,
				// Read by versions that knew one role per voucher.
				role: roles[0],
				discountPercent,
				startsAt: iso(startsAt),
				endsAt: iso(endsAt),
				maxUses: maxUses ?? undefined,
				uses: 0,
				createdBy: actor.email,
				createdAt: createdAt.toISOString()
			};
			const reasons = await this.transact([
				...(systemId === null
					? []
					: roles.map((role) => ({
							ConditionCheck: { TableName: this.table.name, Key: roleKey(systemId, role), ConditionExpression: LIVE_ROLE }
						}))),
				// Codes are unique however they were keyed (V2).
				...(legacy
					? [{ ConditionCheck: { TableName: this.table.name, Key: legacy, ConditionExpression: 'attribute_not_exists(PK)' } }]
					: []),
				{ Put: { TableName: this.table.name, Item: item, ConditionExpression: 'attribute_not_exists(PK)' } }
			]);
			if (!reasons) return toVoucher(item);
			const missing = systemId === null ? -1 : reasons.slice(0, roles.length).indexOf('ConditionalCheckFailed');
			if (missing >= 0) throw notFound(`Role "${roles[missing]}" not found in "${systemId}"`);
			if (custom) throw new RbacError(409, `A voucher with the code ${custom} already exists`);
		}
		throw new RbacError(409, 'Voucher code collision; try again');
	}

	/** The voucher a code names, however it is typed and whenever it was made (V2). */
	private async voucherItem(rawCode: string): Promise<Item | undefined> {
		if (!compactVoucherCode(rawCode)) return undefined;
		const legacy = legacyVoucherKey(rawCode);
		return (await this.get(voucherKey(rawCode))) ?? (legacy ? await this.get(legacy) : undefined);
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
		const existing = await this.voucherItem(rawCode);
		if (!existing) {
			throw notFound('Voucher not found');
		}
		const { Attributes } = await this.table.doc.send(
			new UpdateCommand({
				TableName: this.table.name,
				Key: { PK: existing.PK, SK: existing.SK },
				UpdateExpression: 'SET disabledAt = if_not_exists(disabledAt, :now), disabledBy = if_not_exists(disabledBy, :by)',
				ConditionExpression: 'attribute_exists(PK)',
				ExpressionAttributeValues: { ':now': this.now().toISOString(), ':by': actor.email },
				ReturnValues: 'ALL_NEW'
			})
		);
		return toVoucher(Attributes!);
	}

	/** A voucher's RedeemEvents (V7), newest first; roots only. */
	async listRedemptions(actor: Actor, rawCode: string): Promise<RedeemEvent[]> {
		requireRoot(actor, 'Only roots can see redemptions');
		const item = await this.voucherItem(rawCode);
		if (!item) throw notFound('Voucher not found');
		const voucher = toVoucher(item);
		const events = (await queryPrefix(this.table, item.PK as string, 'REDEEMED#')).map((it) => toRedeemEvent(it, voucher));
		return events.sort((a, b) => b.redeemedAt.getTime() - a.redeemedAt.getTime());
	}

	/**
	 * Redeems a voucher for `email`, granting each of its roles (globally for
	 * a global voucher). Each identity can redeem a given voucher once;
	 * counting the use, recording the redemption and granting happen in one
	 * transaction whose conditions keep uses within maxUses. The grants start
	 * now and never end; each replaces an existing grant of its role unless
	 * that one already gives it now and forever (G3). A voucher with less
	 * than 100% discount needs payment, which isn't available yet: it fails
	 * with 402 and the voucher's terms, recording nothing.
	 */
	async redeemVoucher(email: string, rawCode: string, via: RedeemVia = 'api'): Promise<GrantWithImplied[]> {
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
		const item = await this.voucherItem(rawCode);
		const voucher = requireActive(item);
		const key = { PK: item!.PK, SK: item!.SK };
		if (voucher.discountPercent < 100) {
			const { code, systemId, roles, role, discountPercent } = voucher;
			throw new RbacError(402, 'This voucher requires payment, which is not available yet', {
				payment: { code, systemId, roles, role, discountPercent }
			});
		}
		const forever = { startsAt: null, endsAt: null };
		const grants = voucher.roles.map((role) =>
			grantItem(voucher.systemId, role, email, voucher.createdBy, now, forever, voucher.code)
		);
		for (let attempt = 0; attempt < 2; attempt++) {
			const found = await Promise.all(grants.map((g) => this.get({ PK: g.PK, SK: g.SK })));
			for (const f of found) await this.archive(f);
			// A grant that already gives its role now and forever is kept.
			const previous = found.map((f) => (f && live(f) ? toGrant(f) : null));
			const kept = previous.map((p) => (p && p.endsAt === null && grantStatus(p, now) === 'active' ? p : null));
			// The RedeemEvent (V7): written with the grants, so it records exactly what happened.
			const event: Item = {
				PK: key.PK,
				SK: `REDEEMED#${email}`,
				type: 'RedeemEvent',
				id: crypto.randomUUID(),
				code: voucher.code,
				systemId: voucher.systemId ?? undefined,
				roles: voucher.roles,
				discountPercent: voucher.discountPercent,
				voucherCreatedBy: voucher.createdBy,
				email,
				redeemedAt: now.toISOString(),
				via,
				grants: voucher.roles.map((role, i) => {
					const p = previous[i];
					return {
						systemId: voucher.systemId ?? undefined,
						role,
						outcome: kept[i] ? 'kept' : p ? 'replaced' : 'granted',
						replaced:
							p && !kept[i]
								? {
										grantedBy: p.grantedBy,
										grantedAt: p.grantedAt.toISOString(),
										startsAt: iso(p.startsAt),
										endsAt: iso(p.endsAt),
										voucherCode: p.voucherCode ?? undefined
									}
								: undefined
					};
				})
			};
			const reasons = await this.transact([
				{
					Update: {
						TableName: this.table.name,
						Key: key,
						UpdateExpression: 'SET uses = uses + :one',
						ConditionExpression:
							'attribute_exists(PK) AND attribute_not_exists(disabledAt) AND (attribute_not_exists(maxUses) OR uses < maxUses)',
						ExpressionAttributeValues: { ':one': 1 }
					}
				},
				{
					Put: {
						TableName: this.table.name,
						Item: event,
						ConditionExpression: 'attribute_not_exists(PK)'
					}
				},
				...grants.flatMap((grant, i) =>
					kept[i] ? [] : [{ Put: { TableName: this.table.name, Item: grant, ...unchangedSince(found[i]) } }]
				)
			]);
			if (!reasons) return this.withImpliedRoles(grants.map((g, i) => kept[i] ?? toGrant(g)));
			if (reasons[0] === 'ConditionalCheckFailed') {
				requireActive(await this.get(key));
				throw new RbacError(409, 'This voucher has no uses left');
			}
			if (reasons[1] === 'ConditionalCheckFailed') throw new RbacError(409, 'You have already redeemed this voucher');
			// Otherwise a grant changed meanwhile: retry with it.
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
		const meta = await this.requireSystem(systemId);
		const roleItem = await this.get(roleKey(systemId, role));
		if (!roleItem || !live(roleItem)) throw notFound(`Role "${role}" not found in "${systemId}"`);
		// In maintenance nobody, roots included, holds a role here (R11).
		if (meta.maintenance === true) return denied;
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

	private async requireSystem(systemId: string): Promise<Item> {
		const meta = await this.get({ PK: sysPK(systemId), SK: 'META' });
		if (!meta || !live(meta)) throw notFound(`System "${systemId}" not found`);
		return meta;
	}
}
