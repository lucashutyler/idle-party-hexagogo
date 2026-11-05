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

export function isStoreFileName(name: string): boolean {
  return STORE_FILE_NAMES.has(name);
}

/** Case-insensitive, because some filesystems are and player names already compare that way. */
export function isReservedUsername(username: string): boolean {
  return RESERVED_USERNAMES.has(username.toLowerCase());
}
