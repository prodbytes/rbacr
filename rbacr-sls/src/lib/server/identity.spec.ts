import { describe, expect, it } from 'vitest';
import { Allowlist, domainOf, granteesFor, normalizeEmail, parseGrantee } from './identity';

describe('normalizeEmail', () => {
	it('lower-cases and trims valid addresses', () => {
		expect(normalizeEmail('  Ana@Example.COM ')).toBe('ana@example.com');
	});
	it('rejects invalid addresses', () => {
		for (const bad of ['', 'ana', 'ana@', '@example.com', 'a b@example.com', 'ana@example']) {
			expect(normalizeEmail(bad)).toBeNull();
		}
	});
});

describe('parseGrantee', () => {
	it('accepts addresses and both domain spellings', () => {
		expect(parseGrantee('Ana@Example.com')).toBe('ana@example.com');
		expect(parseGrantee('example.com')).toBe('@example.com');
		expect(parseGrantee('@Example.com')).toBe('@example.com');
	});
	it('rejects garbage', () => {
		for (const bad of ['', '@', 'example', '@@example.com', 'not a domain.com']) {
			expect(parseGrantee(bad)).toBeNull();
		}
	});
});

describe('granteesFor', () => {
	it('returns the address and its domain', () => {
		expect(domainOf('ana@example.com')).toBe('example.com');
		expect(granteesFor('ana@example.com')).toEqual(['ana@example.com', '@example.com']);
	});
});

describe('Allowlist', () => {
	const list = Allowlist.parse('boss@example.com, root.org\n@other.net');

	it('matches individual addresses', () => {
		expect(list.includes('boss@example.com')).toBe(true);
		expect(list.includes('intern@example.com')).toBe(false);
	});
	it('matches whole domains exactly', () => {
		expect(list.includes('anyone@root.org')).toBe(true);
		expect(list.includes('x@other.net')).toBe(true);
		expect(list.includes('x@sub.root.org')).toBe(false);
	});
	it('is empty when unset', () => {
		expect(Allowlist.parse(undefined).entries.size).toBe(0);
		expect(Allowlist.parse('').includes('a@b.com')).toBe(false);
	});
	it('fails loudly on invalid entries', () => {
		expect(() => Allowlist.parse('good.com, not-valid')).toThrow(/not-valid/);
	});
});
