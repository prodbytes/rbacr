/**
 * A generated cover for a system's card when it has no screenshot (SPEC
 * R13): an icon for what the system is for, picked from words in its id,
 * name and description, on colours derived from its id, so a system always
 * gets the same cover. Drawn as SVG by the card itself; nothing is fetched
 * or stored.
 */

export interface Theme {
	/** What the icon shows, for its accessible name. */
	label: string;
	/** Word stems that pick this theme (matched at the start of words). */
	words: string[];
	/** Stroked paths on a 24×24 grid. */
	icon: string[];
}

export const THEMES: Theme[] = [
	{
		label: 'payments',
		words: ['bill', 'pay', 'invoice', 'subscri', 'price', 'pricing', 'money', 'financ', 'wallet', 'checkout'],
		icon: ['M3 6h18v12H3z', 'M3 10h18', 'M7 15h4']
	},
	{
		label: 'conversations',
		words: ['chat', 'messag', 'inbox', 'mail', 'forum', 'communit', 'comment', 'support', 'help'],
		icon: ['M4 5h16v10H9l-5 4z', 'M8 9h8', 'M8 12h5']
	},
	{
		label: 'analytics',
		words: ['analytic', 'report', 'metric', 'dashboard', 'stat', 'insight', 'monitor', 'chart'],
		icon: ['M4 4v16h16', 'M8 16v-4', 'M12 16V8', 'M16 16v-6']
	},
	{
		label: 'calendar',
		words: ['calendar', 'schedul', 'booking', 'book', 'event', 'presence', 'attend', 'meeting', 'shift'],
		icon: ['M4 6h16v14H4z', 'M4 10h16', 'M8 3v5', 'M16 3v5', 'M8 14h3']
	},
	{
		label: 'documents',
		words: ['doc', 'wiki', 'note', 'newsletter', 'blog', 'content', 'post', 'article', 'cms', 'knowledge'],
		icon: ['M6 3h8l4 4v14H6z', 'M14 3v4h4', 'M9 12h6', 'M9 16h6']
	},
	{
		label: 'learning',
		words: ['learn', 'course', 'class', 'school', 'lesson', 'train', 'quiz', 'tutor'],
		icon: ['M2 9l10-5 10 5-10 5z', 'M6 11v5c3 2 9 2 12 0v-5']
	},
	{
		label: 'shop',
		words: ['shop', 'store', 'cart', 'order', 'catalog', 'product', 'market'],
		icon: ['M5 8h14l-1 12H6z', 'M9 8V6a3 3 0 0 1 6 0v2']
	},
	{
		label: 'people',
		words: ['crm', 'customer', 'contact', 'people', 'team', 'user', 'member', 'hr', 'staff', 'client'],
		icon: ['M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M3 20c0-3 3-5 6-5s6 2 6 5', 'M16 11a2.5 2.5 0 1 0 0-5', 'M17 15c2 0 4 2 4 4']
	},
	{
		label: 'security',
		words: ['secur', 'auth', 'login', 'access', 'vault', 'secret', 'admin', 'permission'],
		icon: ['M12 3l8 3v6c0 5-4 8-8 9-4-1-8-4-8-9V6z', 'M9 12l2 2 4-4']
	},
	{
		label: 'media',
		words: ['video', 'media', 'photo', 'image', 'music', 'audio', 'podcast', 'stream', 'gallery'],
		icon: ['M4 5h16v14H4z', 'M10 9v6l5-3z']
	},
	{
		label: 'games',
		words: ['game', 'play', 'quest', 'puzzle', 'arcade'],
		icon: ['M6 8h12a4 4 0 0 1 0 8H6a4 4 0 0 1 0-8z', 'M8 10v4', 'M6 12h4', 'M15 11h.01', 'M17 13h.01']
	}
];

/** For systems no theme describes: a generic app. */
export const DEFAULT_THEME: Theme = {
	label: 'application',
	words: [],
	icon: ['M4 4h7v7H4z', 'M13 4h7v7h-7z', 'M4 13h7v7H4z', 'M13 13h7v7h-7z']
};

export interface Cover {
	theme: Theme;
	/** Two hues (0-359) for the background gradient. */
	hues: [number, number];
}

/** FNV-1a: a small, stable hash, so a system's colours never change. */
function hash(text: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
	return h;
}

/** The words of a text, lower-cased: runs of letters and digits. */
const wordsOf = (text: string | null | undefined) => (text ?? '').toLowerCase().match(/[a-z0-9]+/g) ?? [];

/**
 * The theme whose words appear earliest: first in the id and name, which
 * say what a system is most directly, then in the description.
 */
export function themeFor(system: { id: string; name: string; description: string | null }): Theme {
	for (const text of [`${system.id} ${system.name}`, system.description]) {
		for (const word of wordsOf(text)) {
			const theme = THEMES.find((t) => t.words.some((stem) => word.startsWith(stem)));
			if (theme) return theme;
		}
	}
	return DEFAULT_THEME;
}

export function coverFor(system: { id: string; name: string; description: string | null }): Cover {
	const hue = hash(system.id) % 360;
	return { theme: themeFor(system), hues: [hue, (hue + 50) % 360] };
}
