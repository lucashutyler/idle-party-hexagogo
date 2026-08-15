/**
 * Single source of truth for every kind of imagery the game serves.
 *
 * The kind set used to be written down in five places that had silently
 * drifted apart — the server's static mounts, the admin upload allow-list, the
 * client `AssetKind` union, the admin artwork-section union, and the vite dev
 * proxy — which is how the game ended up serving 15 kinds while only 7 could
 * be uploaded. Everything now derives from `ASSET_KIND_INFO`: adding a kind is
 * one row here.
 *
 * URL convention is `<mount>/{id}.png`, served from `data/<dir>/`. Most kinds
 * follow `/{kind}-artwork/{id}.png`, but the three icon sets predate that
 * convention and keep their own mounts, so `dir` and `mount` are spelled out
 * per row rather than derived from the kind name.
 */

export const ASSET_KINDS = [
  'item',
  'monster',
  'set',
  'shop',
  'zone',
  'tile',
  'tile-type',
  'parchment',
  'class',
  'npc',
  'logo',
  'combat-bg',
  'room-bg',
  'class-icon',
  'slot-icon',
  'nav-icon',
] as const;

export type AssetKind = (typeof ASSET_KINDS)[number];

/**
 * How the coverage report enumerates the ids a kind is *expected* to have art
 * for. `'none'` marks a kind that only ever holds optional per-entity
 * overrides, so nothing is ever reported missing for it.
 */
export type AssetIdSource =
  | 'items'
  | 'monsters'
  | 'sets'
  | 'shops'
  | 'zones'
  | 'tileTypes'
  | 'npcs'
  | 'maps'
  | 'classes'
  | 'equipSlots'
  | 'navIcons'
  | 'fixed'
  | 'none';

/** Extra ids a kind's folder may legitimately hold beyond its required set. */
export type AssetOverrideSource =
  /** Per-room art keyed by the room's GUID. */
  | 'tiles'
  /** Per-room art keyed by the `{zoneId}-{col}-{row}` composite. */
  | 'rooms';

/**
 * One link in the chain the client walks when an id has no art of its own.
 * Mirrors what the render sites actually do, so the coverage report can say
 * "missing its own art but still renders real art" instead of crying wolf.
 */
export interface AssetFallback {
  /** Folder searched for the fallback. */
  kind: AssetKind;
  /** Which id is looked up there. */
  idFrom: 'zoneId' | 'tileType' | 'nameSlug';
}

export interface AssetKindInfo {
  /** Human label for admin UI and API docs. */
  label: string;
  /** What this art is used for — surfaced verbatim in the API and MCP tools. */
  description: string;
  /** Folder under the process working directory that holds the PNGs. */
  dir: string;
  /** Public URL prefix the client fetches from. */
  mount: string;
  /** Drives the coverage report's required-id set. */
  idSource: AssetIdSource;
  /** Human description of the id format. */
  idFormat: string;
  /** Required ids for `idSource: 'fixed'` kinds. */
  fixedIds?: readonly string[];
  /** Ids beyond the required set that are overrides rather than orphans. */
  overrideIdSource?: AssetOverrideSource;
  /** `square` rejects non-square uploads; `any` accepts any aspect ratio. */
  shape: 'square' | 'any';
  /** Ordered fallbacks the client walks when an id has no art of its own. */
  fallbacks?: readonly AssetFallback[];
  /**
   * Fold ids to lowercase everywhere — on upload, in the public URL, and in the
   * coverage report. Set for `class` because its three render sites disagreed
   * on casing (`slugify(className)` in one, the raw `Knight` in two others), so
   * uploaded art would only ever have resolved in one of them. Folding pins a
   * single canonical filename instead of leaving the drift in place.
   */
  lowercaseIds?: boolean;
}

export const ASSET_KIND_INFO: Record<AssetKind, AssetKindInfo> = {
  item: {
    label: 'Item',
    description: 'Item icons shown in inventory, loot popups, and shop listings.',
    dir: 'data/item-artwork',
    mount: '/item-artwork',
    idSource: 'items',
    idFormat: 'ItemDefinition.id',
    shape: 'square',
  },
  monster: {
    label: 'Monster',
    description: 'Monster portraits shown on the combat screen.',
    dir: 'data/monster-artwork',
    mount: '/monster-artwork',
    idSource: 'monsters',
    idFormat: 'MonsterDefinition.id',
    shape: 'square',
    // CombatScreen still honors art dropped in under a slug of the name.
    fallbacks: [{ kind: 'monster', idFrom: 'nameSlug' }],
  },
  // ── Deferred (see DEFERRED_ASSET_KINDS) ──
  // Still mounted and still rendered by whatever already reads them, but held
  // back from the assets API until the blockers below are resolved.
  set: {
    label: 'Equipment set',
    description: 'Set artwork. Deferred from the assets API — nothing in the client renders set art yet.',
    dir: 'data/set-artwork',
    mount: '/set-artwork',
    idSource: 'sets',
    idFormat: 'SetDefinition.id',
    shape: 'square',
  },
  shop: {
    label: 'Shop',
    description:
      'Shop icon on the room-view action button. Deferred from the assets API — the room view fetches this art by '
      + "the room's ZONE id while the uploader files it under the shop's id, so art uploaded the normal way never renders.",
    dir: 'data/shop-artwork',
    mount: '/shop-artwork',
    idSource: 'shops',
    idFormat: 'ShopDefinition.id (the room view currently fetches by zone id instead — see description)',
    shape: 'square',
  },
  zone: {
    label: 'Zone',
    description: 'Zone artwork, also the last-resort combat backdrop for rooms in the zone.',
    dir: 'data/zone-artwork',
    mount: '/zone-artwork',
    idSource: 'zones',
    idFormat: 'ZoneDefinition.id (the zone tag, not displayName)',
    shape: 'square',
  },
  tile: {
    label: 'Room override',
    description: 'Per-room map art that overrides the room type art for one specific room.',
    dir: 'data/tile-artwork',
    mount: '/tile-artwork',
    // Room-type art already covers every room, so a room with no override of
    // its own is not missing anything.
    idSource: 'none',
    idFormat: 'WorldTileDefinition.id (room GUID)',
    overrideIdSource: 'tiles',
    shape: 'square',
    fallbacks: [{ kind: 'tile-type', idFrom: 'tileType' }],
  },
  'tile-type': {
    label: 'Room type',
    description: 'Map art for every room of a given type — the baseline the world map draws.',
    dir: 'data/tile-type-artwork',
    mount: '/tile-type-artwork',
    idSource: 'tileTypes',
    idFormat: "TileTypeDefinition.id (matches a room's type)",
    shape: 'square',
  },
  parchment: {
    label: 'Map parchment',
    description: 'Tiling parchment backdrop behind the world map, one per map.',
    dir: 'data/parchment-artwork',
    mount: '/parchment-artwork',
    idSource: 'maps',
    idFormat: 'WorldMapMeta.id',
    shape: 'square',
  },
  class: {
    label: 'Class portrait',
    description: 'Character portraits on the combat, character, and profile screens.',
    dir: 'data/class-artwork',
    mount: '/class-artwork',
    idSource: 'classes',
    idFormat: 'Class name, folded to lowercase (Knight → knight.png)',
    shape: 'square',
    lowercaseIds: true,
  },
  npc: {
    label: 'NPC',
    description: 'NPC portraits in the talk popup. NPCs may instead point at any URL via NpcDefinition.artworkUrl.',
    dir: 'data/npc-artwork',
    mount: '/npc-artwork',
    idSource: 'npcs',
    idFormat: 'NpcDefinition.id',
    shape: 'square',
  },
  logo: {
    label: 'Logo',
    description: 'Splash-screen logo shown while the game loads.',
    dir: 'data/logo-artwork',
    mount: '/logo-artwork',
    idSource: 'fixed',
    idFormat: "the single id 'idle-party'",
    fixedIds: ['idle-party'],
    shape: 'any',
  },
  'combat-bg': {
    label: 'Combat backdrop',
    description: 'Wide backdrop behind the combat stage. One per zone, optionally overridden per room.',
    dir: 'data/combat-bg-artwork',
    mount: '/combat-bg-artwork',
    idSource: 'zones',
    idFormat: 'Zone id for the zone default; `{zoneId}-{col}-{row}` for a per-room override',
    overrideIdSource: 'rooms',
    shape: 'any',
    fallbacks: [{ kind: 'zone', idFrom: 'zoneId' }],
  },
  'room-bg': {
    label: 'Room backdrop',
    description: 'Backdrop behind the room view. One per zone, optionally overridden per room.',
    dir: 'data/room-bg-artwork',
    mount: '/room-bg-artwork',
    idSource: 'zones',
    idFormat: 'Zone id for the zone default; `{zoneId}-{col}-{row}` for a per-room override',
    overrideIdSource: 'rooms',
    shape: 'any',
  },
  'class-icon': {
    label: 'Class icon',
    description: 'Small class glyphs used inline in party lists, chat, and leaderboards.',
    dir: 'data/class-icons',
    mount: '/class-icons',
    // Not lowercased: `CLASS_ICONS` requests `/class-icons/Knight.png` by exact
    // name, and those files predate the registry, so the canonical id here is
    // the class name as spelled.
    idSource: 'classes',
    idFormat: "Class name as spelled, plus the 'Unknown' and 'Server' placeholders",
    shape: 'square',
  },
  'slot-icon': {
    label: 'Equipment slot icon',
    description: 'Glyphs on the equipment-slot dogears.',
    dir: 'data/slot-icons',
    mount: '/slot-icons',
    idSource: 'equipSlots',
    idFormat: 'EquipSlot id',
    shape: 'square',
  },
  'nav-icon': {
    label: 'Navigation icon',
    description: 'Bottom-navigation button glyphs.',
    dir: 'data/nav-icons',
    mount: '/nav-icons',
    idSource: 'navIcons',
    idFormat: 'Nav destination id',
    shape: 'square',
  },
};

/**
 * Kinds the assets API actually manages — what `/api/admin/assets/*`, the MCP
 * asset tools, and the coverage report operate on.
 *
 * This is `ASSET_KINDS` minus `DEFERRED_ASSET_KINDS`. It is spelled out as its
 * own tuple rather than filtered at runtime so it can drive a `z.enum(...)`;
 * `AssetKinds.test.ts` asserts the two lists partition `ASSET_KINDS` exactly,
 * so adding a kind without classifying it fails the build.
 */
export const MANAGED_ASSET_KINDS = [
  'item',
  'monster',
  'zone',
  'tile',
  'tile-type',
  'parchment',
  'class',
  'npc',
  'logo',
  'combat-bg',
  'room-bg',
  'class-icon',
  'slot-icon',
  'nav-icon',
] as const;

export type ManagedAssetKind = (typeof MANAGED_ASSET_KINDS)[number];

/**
 * Kinds that exist in the registry — served statically, rendered by the client,
 * type-checked — but are deliberately **not** exposed through the assets API,
 * the MCP tools, or the coverage report yet. They stay here as placeholders so
 * the folders keep serving existing art and the work is one list move away.
 *
 * - `shop`: the room view fetches shop art by the room's *zone* id while the
 *   uploader writes it under the *shop* id, so the API would accept and report
 *   art the game never renders. Blocked on that client fix.
 * - `set`: uploadable and served, but nothing in the client renders set art at
 *   all, so coverage would pressure authors to draw art nothing displays.
 */
export const DEFERRED_ASSET_KINDS = ['set', 'shop'] as const;

export type DeferredAssetKind = (typeof DEFERRED_ASSET_KINDS)[number];

/** Narrow caller input to a kind the assets API is willing to act on. */
export function isManagedAssetKind(value: unknown): value is ManagedAssetKind {
  return typeof value === 'string' && (MANAGED_ASSET_KINDS as readonly string[]).includes(value);
}

/** True for a registry kind that exists but isn't wired into the API yet. */
export function isDeferredAssetKind(value: unknown): value is DeferredAssetKind {
  return typeof value === 'string' && (DEFERRED_ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * Narrow arbitrary caller input to a known kind. Uses an explicit list scan
 * rather than an object lookup so inherited keys like `constructor` and
 * `__proto__` can't pass as kinds — the same hazard `DraftEditor.toRecord`
 * guards against for content ids.
 */
export function isAssetKind(value: unknown): value is AssetKind {
  return typeof value === 'string' && (ASSET_KINDS as readonly string[]).includes(value);
}

/**
 * The one true spelling of an id for a kind. Applied on upload, in the public
 * URL, and when the coverage report joins content against disk, so all three
 * agree on the filename.
 */
export function canonicalAssetId(kind: AssetKind, id: string): string {
  return ASSET_KIND_INFO[kind].lowercaseIds ? id.toLowerCase() : id;
}

/** Public URL the client fetches a given asset from. */
export function assetPublicPath(kind: AssetKind, id: string): string {
  return `${ASSET_KIND_INFO[kind].mount}/${encodeURIComponent(canonicalAssetId(kind, id))}.png`;
}

/**
 * Ids are interpolated straight into a filename, so anything that could climb
 * out of the folder or hide an extension is rejected. Hyphens and dots must
 * stay legal — room overrides are `{zoneId}-{col}-{row}` and class ids carry
 * mixed case — so the guard bans path separators and any `..` run instead of
 * allow-listing a narrower shape.
 */
export const ASSET_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,127}$/;

export function isValidAssetId(id: string): boolean {
  return ASSET_ID_PATTERN.test(id) && !id.includes('..');
}
