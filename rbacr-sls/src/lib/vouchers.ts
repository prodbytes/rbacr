/**
 * Voucher codes and their default terms (SPEC V2), shared by the pages and
 * the server: a code defaults to the current quarter plus random animal
 * names, e.g. 2026Q4-OTTER-FALCON-LEMUR-HERON-MOOSE, and a voucher to being valid
 * through that quarter, from two weeks before it starts to two weeks after
 * it ends.
 */

/** 256 animals, so each one picked is 8 random bits. */
export const ANIMALS = [
	'AARDVARK', 'ALPACA', 'ANCHOVY', 'ANT', 'ANTEATER', 'ANTELOPE', 'APE', 'ASP',
	'AXOLOTL', 'BABOON', 'BADGER', 'BASS', 'BAT', 'BEAR', 'BEAVER', 'BEE',
	'BEETLE', 'BISON', 'BLUEJAY', 'BOAR', 'BOBCAT', 'BONOBO', 'BUFFALO', 'BULLFROG',
	'BUNNY', 'BUZZARD', 'CAMEL', 'CANARY', 'CAPYBARA', 'CARIBOU', 'CARP', 'CAT',
	'CATFISH', 'CHAMOIS', 'CHEETAH', 'CHICKEN', 'CHIPMUNK', 'CICADA', 'CLAM', 'COATI',
	'COBRA', 'COD', 'CONDOR', 'COUGAR', 'COW', 'COYOTE', 'CRAB', 'CRANE',
	'CRICKET', 'CROW', 'CUCKOO', 'DEER', 'DINGO', 'DODO', 'DOG', 'DOLPHIN',
	'DONKEY', 'DORMOUSE', 'DOVE', 'DUCK', 'DUGONG', 'EAGLE', 'EEL', 'EGRET',
	'ELAND', 'ELEPHANT', 'ELK', 'EMU', 'ERMINE', 'FALCON', 'FENNEC', 'FERRET',
	'FINCH', 'FLAMINGO', 'FOX', 'FROG', 'GANNET', 'GAZELLE', 'GECKO', 'GERBIL',
	'GHARIAL', 'GIBBON', 'GIRAFFE', 'GNU', 'GOAT', 'GOLDFISH', 'GOOSE', 'GOPHER',
	'GORILLA', 'GROUSE', 'GULL', 'GUPPY', 'HADDOCK', 'HALIBUT', 'HAMSTER', 'HARE',
	'HAWK', 'HEDGEHOG', 'HERON', 'HERRING', 'HIPPO', 'HORNET', 'HORSE', 'HOUND',
	'HUSKY', 'HYENA', 'IBEX', 'IBIS', 'IGUANA', 'IMPALA', 'JACKAL', 'JAGUAR',
	'JAY', 'JERBOA', 'KANGAROO', 'KESTREL', 'KIWI', 'KOALA', 'KOI', 'KRILL',
	'KUDU', 'LADYBUG', 'LAMB', 'LARK', 'LEMMING', 'LEMUR', 'LEOPARD', 'LIMPET',
	'LION', 'LIZARD', 'LLAMA', 'LOBSTER', 'LOCUST', 'LOON', 'LORIS', 'LYNX',
	'MACAW', 'MAGPIE', 'MALLARD', 'MAMMOTH', 'MANATEE', 'MANTIS', 'MARLIN', 'MARMOT',
	'MARTEN', 'MEERKAT', 'MINK', 'MINNOW', 'MOLE', 'MONGOOSE', 'MONKEY', 'MOOSE',
	'MOTH', 'MOUSE', 'MULE', 'MUSKOX', 'NARWHAL', 'NEWT', 'NIGHTJAR', 'NUTHATCH',
	'OCELOT', 'OCTOPUS', 'OKAPI', 'OPOSSUM', 'ORCA', 'ORIOLE', 'OSPREY', 'OSTRICH',
	'OTTER', 'OWL', 'OX', 'OYSTER', 'PANDA', 'PANGOLIN', 'PANTHER', 'PARROT',
	'PEACOCK', 'PELICAN', 'PENGUIN', 'PHEASANT', 'PIGEON', 'PIKE', 'PIRANHA', 'PLATYPUS',
	'PLOVER', 'PONY', 'POODLE', 'PORPOISE', 'PRAWN', 'PUFFIN', 'PUMA', 'PYTHON',
	'QUAIL', 'QUOKKA', 'RABBIT', 'RACCOON', 'RAM', 'RAVEN', 'REINDEER', 'RHINO',
	'ROBIN', 'SABLE', 'SALMON', 'SARDINE', 'SEAHORSE', 'SEAL', 'SERVAL', 'SHARK',
	'SHEEP', 'SHREW', 'SHRIMP', 'SKUNK', 'SLOTH', 'SNAIL', 'SNAKE', 'SNIPE',
	'SPARROW', 'SPIDER', 'SQUID', 'SQUIRREL', 'STARLING', 'STINGRAY', 'STORK', 'SWALLOW',
	'SWAN', 'SWIFT', 'TAMARIN', 'TAPIR', 'TARSIER', 'TERMITE', 'TERN', 'TIGER',
	'TOAD', 'TORTOISE', 'TOUCAN', 'TROUT', 'TUNA', 'TURKEY', 'TURTLE', 'URCHIN',
	'VIPER', 'VOLE', 'VULTURE', 'WALLABY', 'WALRUS', 'WARTHOG', 'WASP', 'WEASEL',
	'WHALE', 'WOLF', 'WOMBAT', 'WOODCOCK', 'WREN', 'YAK', 'ZEBRA', 'ZEBU'
];

/**
 * Animals in a default code: 5 x 8 = 40 random bits, so guessing one at the
 * redeem limits (V10) would take millennia.
 */
const ANIMALS_PER_CODE = 5;

export interface Quarter {
	/** e.g. 2026Q4 */
	label: string;
	/** Its first instant, UTC. */
	start: Date;
	/** The next quarter's first instant, UTC (exclusive, like a voucher's endsAt). */
	end: Date;
}

/** The calendar quarter (UTC) that `at` falls in. */
export function quarterOf(at: Date): Quarter {
	const year = at.getUTCFullYear();
	const q = Math.floor(at.getUTCMonth() / 3);
	return {
		label: `${year}Q${q + 1}`,
		start: new Date(Date.UTC(year, q * 3, 1)),
		end: new Date(Date.UTC(year, q * 3 + 3, 1))
	};
}

/** Days a default validity reaches before and after its quarter. */
export const VALIDITY_MARGIN_DAYS = 14;

/** A new voucher's default validity: the quarter of `at`, widened by VALIDITY_MARGIN_DAYS each side. */
export function defaultValidity(at: Date): { start: Date; end: Date } {
	const { start, end } = quarterOf(at);
	const margin = VALIDITY_MARGIN_DAYS * 24 * 60 * 60 * 1000;
	return { start: new Date(start.getTime() - margin), end: new Date(end.getTime() + margin) };
}

/** A default code: the quarter of `at` and random animals, e.g. 2026Q4-OTTER-FALCON-LEMUR-HERON-MOOSE. */
export function suggestVoucherCode(at: Date = new Date()): string {
	const picks = Array.from(crypto.getRandomValues(new Uint8Array(ANIMALS_PER_CODE)), (b) => ANIMALS[b]);
	return [quarterOf(at).label, ...picks].join('-');
}

/**
 * Shortest and longest codes, counting letters and digits only. The longest
 * default code (a quarter and five 8-letter animals) has 46.
 */
export const MIN_CODE_LENGTH = 12;
export const MAX_CODE_LENGTH = 48;
/** Fewest different letters and digits a code may have. */
export const MIN_CODE_DISTINCT = 6;

/**
 * Why a code chosen by hand is too easy to guess, or null when it isn't
 * (V2): too short or long, too few different characters, one block
 * repeated (ABCABCABCABC), or a run (ABCDEFGHIJKL, 987654321098). These
 * only rule out the worst; a code made of words people would try
 * (SUMMER-SALE-2026) passes, so the generated codes are the safe choice.
 */
export function weakCodeReason(raw: string): string | null {
	const code = compactVoucherCode(raw);
	if (code.length < MIN_CODE_LENGTH || code.length > MAX_CODE_LENGTH) {
		return `A code needs ${MIN_CODE_LENGTH} to ${MAX_CODE_LENGTH} letters and digits`;
	}
	if (new Set(code).size < MIN_CODE_DISTINCT) {
		return `A code needs at least ${MIN_CODE_DISTINCT} different letters and digits`;
	}
	for (let size = 1; size <= code.length / 2; size++) {
		if (code.length % size === 0 && code.slice(0, size).repeat(code.length / size) === code) {
			return 'A code can\'t be one block repeated';
		}
	}
	const steps = new Set(Array.from(code.slice(1), (c, i) => c.charCodeAt(0) - code.charCodeAt(i)));
	if ((steps.size === 1 && [1, -1].includes([...steps][0])) || isDigitRun(code)) {
		return 'A code can\'t be a run of letters or digits';
	}
	return null;
}

/** Digits counting up or down, wrapping past 9 or 0 (1234567890, 9876543210). */
function isDigitRun(code: string): boolean {
	if (!/^[0-9]+$/.test(code)) return false;
	const d = Array.from(code, Number);
	return [1, 9].some((step) => d.every((x, i) => i === 0 || x === (d[i - 1] + step) % 10));
}

/**
 * A code as shown and stored: upper case, letters and digits, any run of
 * other characters (spaces, dashes, underscores) a single dash. Empty when
 * nothing is left.
 */
export function normalizeVoucherCode(raw: string): string {
	return raw
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
}

/** What codes are matched by: letters and digits only, so separators don't matter. */
export function compactVoucherCode(raw: string): string {
	return raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

