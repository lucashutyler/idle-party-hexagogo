/** `<name>.json` in `data/` belongs to a store, and player saves live in the same folder. See docs/architecture/persistence.md. */
const STORE_FILE_NAMES: ReadonlySet<string> = new Set([
  'accounts',
  'api-tokens',
  'design-notes',
  'dungeons',
  'encounters',
  'guilds',
  'henchmen',
  'invite-list',
  'items',
  'monsters',
  'npcs',
  'quests',
  'recipes',
  'sets',
  'shops',
  'skill-slots',
  'skills',
  'tile-types',
  'trades',
  'world',
  'zones',
]);

const SYSTEM_CHAT_SENDER = 'server';

/** The socket upgrade and save restore treat this string as "no name". */
const NO_NAME_SENTINEL = 'undefined';

const OBJECT_PROTOTYPE_KEYS = Object.getOwnPropertyNames(Object.prototype).map(key => key.toLowerCase());

const RESERVED_USERNAMES: ReadonlySet<string> = new Set([...STORE_FILE_NAMES, SYSTEM_CHAT_SENDER, NO_NAME_SENTINEL, ...OBJECT_PROTOTYPE_KEYS]);

const STAFF_WORDS: ReadonlySet<string> = new Set([
  'admin',
  'administrator',
  'moderator',
  'mod',
  'gm',
  'gamemaster',
  'staff',
  'system',
  'official',
  'support',
  'server',
]);

const NAME_SEPARATORS = /[_\-0-9]+/;
const LOWER_TO_UPPER = /(?<=[a-z])(?=[A-Z])/;

export function isStoreFileName(name: string): boolean {
  return STORE_FILE_NAMES.has(name);
}

/** Case-insensitive, because some filesystems are and player names already compare that way. */
export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.toLowerCase());
}

/** A staff word as a word of the name, two words run together, or the whole name without separators. See docs/architecture/auth.md. */
export function looksLikeStaffName(name: string): boolean {
  const words = name.split(NAME_SEPARATORS)
    .flatMap(part => part.split(LOWER_TO_UPPER))
    .filter(word => word.length > 0)
    .map(word => word.toLowerCase());
  if (words.some(word => STAFF_WORDS.has(word))) return true;
  if (words.some((word, i) => i > 0 && STAFF_WORDS.has(words[i - 1] + word))) return true;
  return STAFF_WORDS.has(words.join(''));
}
