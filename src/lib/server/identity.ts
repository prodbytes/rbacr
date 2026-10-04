/**
 * Identities are Google e-mail addresses. Grants and the root allow list can
 * target either a single address (`ana@example.com`) or a whole domain, which
 * is stored as `@example.com`. Matching is exact and case-insensitive:
 * `@example.com` does not cover `sub.example.com`.
 */

const EMAIL_RE = /^[^\s@]+@([a-z0-9-]+\.)+[a-z0-9-]+$/;
const DOMAIN_RE = /^([a-z0-9-]+\.)+[a-z0-9-]+$/;

export function normalizeEmail(raw: string): string | null {
	const email = raw.trim().toLowerCase();
	return EMAIL_RE.test(email) ? email : null;
}

export function domainOf(email: string): string {
	return email.slice(email.lastIndexOf('@') + 1);
}

/**
 * Parses a grantee: an e-mail address, or a domain written as `example.com`
 * or `@example.com`. Returns the canonical form (`ana@example.com` or
 * `@example.com`), or null when the input is neither.
 */
export function parseGrantee(raw: string): string | null {
	const value = raw.trim().toLowerCase();
	if (value.startsWith('@')) {
		return DOMAIN_RE.test(value.slice(1)) ? value : null;
	}
	if (value.includes('@')) return normalizeEmail(value);
	return DOMAIN_RE.test(value) ? `@${value}` : null;
}

export function isDomainGrantee(grantee: string): boolean {
	return grantee.startsWith('@');
}

/** The grantees that apply to an e-mail: the address itself and its domain. */
export function granteesFor(email: string): [string, string] {
	return [email, `@${domainOf(email)}`];
}

export class Allowlist {
	readonly entries: ReadonlySet<string>;

	constructor(entries: Iterable<string>) {
		this.entries = new Set(entries);
	}

	/**
	 * Parses a comma- or whitespace-separated list of addresses and domains,
	 * e.g. `ana@example.com, example.org`. Invalid entries are reported so a
	 * typo in the root list fails loudly instead of silently granting nothing.
	 */
	static parse(raw: string | undefined): Allowlist {
		const entries: string[] = [];
		const invalid: string[] = [];
		for (const item of (raw ?? '').split(/[\s,]+/).filter(Boolean)) {
			const grantee = parseGrantee(item);
			if (grantee) entries.push(grantee);
			else invalid.push(item);
		}
		if (invalid.length) {
			throw new Error(`Invalid root allow list entries: ${invalid.join(', ')}`);
		}
		return new Allowlist(entries);
	}

	includes(email: string): boolean {
		return granteesFor(email).some((g) => this.entries.has(g));
	}
}
