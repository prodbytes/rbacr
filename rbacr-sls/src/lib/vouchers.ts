/**
 * Voucher codes and their default terms (SPEC V2), shared by the pages and
 * the server: a code defaults to the current quarter plus random animal
 * names, e.g. 2026Q4-OTTER-FALCON-LEMUR, and a voucher to being valid
 * through that quarter.
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

/** Animals in a default code: 3 x 8 = 24 random bits. */
const ANIMALS_PER_CODE = 3;

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

/** A default code: the quarter of `at` and random animals, e.g. 2026Q4-OTTER-FALCON-LEMUR. */
export function suggestVoucherCode(at: Date = new Date()): string {
	const picks = Array.from(crypto.getRandomValues(new Uint8Array(ANIMALS_PER_CODE)), (b) => ANIMALS[b]);
	return [quarterOf(at).label, ...picks].join('-');
}

/** Shortest and longest codes, counting letters and digits only. */
export const MIN_CODE_LENGTH = 6;
export const MAX_CODE_LENGTH = 40;

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

