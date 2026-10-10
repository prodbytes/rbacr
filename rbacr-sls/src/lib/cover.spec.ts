import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME, coverFor, themeFor } from './cover';

const system = (id: string, name = id, description: string | null = null) => ({ id, name, description });

describe('generated covers (R13)', () => {
	it('pick an icon for what the system is for', () => {
		expect(themeFor(system('billing')).label).toBe('payments');
		expect(themeFor(system('presence', 'Presence')).label).toBe('calendar');
		expect(themeFor(system('acme', 'Acme', 'Invoices and payments for the finance team.')).label).toBe('payments');
		expect(themeFor(system('x1', 'X1', 'A wiki for the support team.')).label).toBe('documents');
	});

	it('prefer the id and name over the description', () => {
		expect(themeFor(system('chat', 'Chat', 'Billing questions, answered.')).label).toBe('conversations');
	});

	it('fall back to a generic app', () => {
		expect(themeFor(system('zz9', 'Zz9', 'Plural Z Alpha.'))).toBe(DEFAULT_THEME);
	});

	it('keep their colours for a system, and vary them between systems', () => {
		expect(coverFor(system('billing')).hues).toEqual(coverFor(system('billing', 'Renamed')).hues);
		expect(coverFor(system('billing')).hues).not.toEqual(coverFor(system('crm')).hues);
		for (const h of coverFor(system('crm')).hues) expect(h >= 0 && h < 360).toBe(true);
	});
});
