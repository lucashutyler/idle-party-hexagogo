import { ASSET_KINDS, MANAGED_ASSET_KINDS, ASSET_KIND_INFO, ALL_CLASS_NAMES, EQUIP_SLOTS, canonicalAssetId } from '@idle-party-rpg/shared';
import type { AssetKind, ManagedAssetKind, AssetKindInfo, AssetFallback } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';
import type { AssetStore } from './AssetStore.js';

/**
 * Answers "what imagery is missing?" by joining every asset folder against the
 * content that is supposed to have art in it.
 *
 * The join is only useful if it accounts for the fallback chains the client
 * actually walks — rooms fall back to room-type art, combat backdrops fall
 * back to zone art, monsters fall back to a slug of their name. A naive
 * does-the-file-exist check reports thousands of false positives, so every
 * entry reports both whether it has art of its own and what it really renders.
 */

/** Nav destinations that draw a PNG. Chat uses a chevron glyph, so it has no icon. */
const NAV_ICON_IDS = ['combat', 'map', 'items', 'craft', 'social', 'settings'] as const;

/** Placeholder glyphs the class-icon set carries beyond the real classes. */
const CLASS_ICON_EXTRA_IDS = ['Unknown', 'Server'] as const;

/** Matches `CombatScreen`'s legacy name-slug fallback for monster art. */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/**
 * How an id renders today: its own art, a fallback kind's art, art at a
 * free-form URL the entity carries itself, or the placeholder.
 */
export type AssetResolution = 'own' | 'placeholder' | 'external' | `fallback:${AssetKind}`;

export interface AssetCoverageEntry {
  id: string;
  /** Display name of the entity that wants this art. */
  label: string;
  hasOwnAsset: boolean;
  /** What the player actually sees for this id right now. */
  resolvedVia: AssetResolution;
}

export interface AssetKindCoverage {
  kind: AssetKind;
  label: string;
  description: string;
  dir: string;
  mount: string;
  idFormat: string;
  /** How many ids of this kind are expected to have art. */
  required: number;
  /** Required ids that have art of their own. */
  present: number;
  /** Required ids with no art of their own. */
  missing: number;
  /**
   * Of the missing, how many still render real art anyway — through a fallback
   * chain, or via an artwork URL the entity carries itself.
   */
  coveredByFallback: number;
  /**
   * Recognized files sitting on top of the required set — per-room overrides,
   * plus alias files a fallback chain still resolves (monster art filed under a
   * slug of the monster's name).
   */
  overrides: number;
  /** Files matching no required id, no override shape, and no fallback alias. */
  orphans: string[];
  /** Per-id detail. Omitted unless requested — some kinds have thousands. */
  entries?: AssetCoverageEntry[];
}

export interface AssetCoverageReport {
  generatedAt: string;
  summary: {
    kinds: number;
    required: number;
    present: number;
    missing: number;
    coveredByFallback: number;
    overrides: number;
    orphans: number;
  };
  kinds: AssetKindCoverage[];
}

export interface AssetCoverageOptions {
  /** Restrict the report to one kind. */
  kind?: ManagedAssetKind;
  /** Include the per-id `entries` array. */
  includeEntries?: boolean;
  /** With `includeEntries`, list only ids that have no art of their own. */
  missingOnly?: boolean;
  /** Cap on entries per kind. Defaults to 500. */
  entryLimit?: number;
}

/** One id that wants art, plus the context its fallback chain needs. */
interface RequiredId {
  id: string;
  label: string;
  /**
   * Zones this id is associated with, for `idFrom: 'zoneId'` fallbacks. A list
   * because a shop can be placed in rooms across several zones, and the client
   * fetches its art by whichever zone the player is standing in.
   */
  zoneIds?: string[];
  /** Room type, for `idFrom: 'tileType'` fallbacks. */
  tileType?: string;
  /** Slug of the entity name, for `idFrom: 'nameSlug'` fallbacks. */
  nameSlug?: string;
  /**
   * Art this entity points at directly rather than through the asset folders —
   * today only `NpcDefinition.artworkUrl`. Such an entity isn't missing art
   * even with nothing on disk under its id.
   */
  externalUrl?: string;
}

/** `readTools.ts` uses this same expression — zones carry `displayName`, notes carry `title`. */
function labelOf(entry: Record<string, unknown>): string {
  return (entry.name ?? entry.displayName ?? entry.title ?? entry.id) as string;
}

function fromContent(record: Record<string, unknown>): RequiredId[] {
  return Object.values(record).map(raw => {
    const entry = raw as Record<string, unknown>;
    const label = labelOf(entry);
    return { id: entry.id as string, label, nameSlug: slugify(label) };
  });
}

/**
 * The ids a kind is expected to have art for. Mirrors the type dispatch in
 * `readTools.getLiveContentArray`, extended with the sources that aren't
 * draft content types at all — rooms, maps, classes, and the fixed icon sets.
 */
function requiredIdsFor(kind: AssetKind, info: AssetKindInfo, content: ContentStore): RequiredId[] {
  switch (info.idSource) {
    case 'items': return fromContent(content.getAllItems());
    case 'skills': return fromContent(content.getAllSkills());
    case 'monsters': return fromContent(content.getAllMonsters());
    case 'sets': return fromContent(content.getAllSets());
    case 'tileTypes': return fromContent(content.getAllTileTypes());
    case 'maps': return content.getMaps().map(map => ({ id: map.id, label: map.name }));
    // Unreachable while `shop` sits in DEFERRED_ASSET_KINDS; kept so the switch
    // stays exhaustive over AssetIdSource.
    case 'shops': return fromContent(content.getAllShops());
    case 'npcs':
      // An NPC pointing at its own artwork URL already has a portrait, whether
      // or not anything sits in the npc-artwork folder.
      return Object.values(content.getAllNpcs()).map(npc => ({
        id: npc.id,
        label: npc.name,
        nameSlug: slugify(npc.name),
        externalUrl: npc.artworkUrl,
      }));
    case 'zones':
      // Backdrop kinds key off the zone too, and their fallback chain needs to
      // know which zone each entry is, so carry the id through as `zoneIds`.
      return Object.values(content.getAllZones()).map(zone => ({
        id: zone.id,
        label: zone.displayName ?? zone.id,
        zoneIds: [zone.id],
      }));
    case 'classes': {
      const classes: RequiredId[] = ALL_CLASS_NAMES.map(name => ({ id: name, label: name }));
      if (kind === 'class-icon') {
        classes.push(...CLASS_ICON_EXTRA_IDS.map(id => ({ id, label: `${id} (placeholder icon)` })));
      }
      return classes;
    }
    case 'equipSlots': return EQUIP_SLOTS.map(slot => ({ id: slot, label: slot }));
    case 'navIcons': return NAV_ICON_IDS.map(id => ({ id, label: id }));
    case 'fixed': return (info.fixedIds ?? []).map(id => ({ id, label: id }));
    case 'none': return [];
  }
}

/**
 * Ids that may legitimately sit in a kind's folder on top of its required set —
 * per-room overrides. Anything outside both sets is an orphan, usually art left
 * behind by a deleted entity.
 */
function overrideIdsFor(info: AssetKindInfo, content: ContentStore): Set<string> {
  if (!info.overrideIdSource) return new Set();
  const tiles = content.getWorld().tiles;
  if (info.overrideIdSource === 'tiles') return new Set(tiles.map(tile => tile.id));
  return new Set(tiles.map(tile => `${tile.zone}-${tile.col}-${tile.row}`));
}

/**
 * Alternate keys a kind's own fallback chain still resolves — monster art filed
 * under a slug of the monster's name, shop art filed under the zone id the room
 * view actually fetches. The client renders both, so calling either an orphan
 * would invite an admin (or an MCP client acting on the report) to delete art
 * the game is using.
 */
function aliasIdsFor(kind: AssetKind, info: AssetKindInfo, required: RequiredId[]): Set<string> {
  const aliases = new Set<string>();
  for (const fallback of info.fallbacks ?? []) {
    if (fallback.kind !== kind) continue;
    for (const req of required) {
      for (const alias of aliasIdsFrom(req, fallback.idFrom)) aliases.add(alias);
    }
  }
  return aliases;
}

/** The alternate filenames one required id resolves under for a given fallback rule. */
function aliasIdsFrom(req: RequiredId, idFrom: AssetFallback['idFrom']): string[] {
  if (idFrom === 'zoneId') return req.zoneIds ?? [];
  if (idFrom === 'tileType') return req.tileType ? [req.tileType] : [];
  return req.nameSlug ? [req.nameSlug] : [];
}

/**
 * Index a set of ids under the spelling the kind actually stores them by, so
 * `Knight` and `knight` don't read as two different portraits.
 */
function indexIds(kind: AssetKind, ids: string[]): Set<string> {
  return new Set(ids.map(id => canonicalAssetId(kind, id)));
}

export async function computeAssetCoverage(
  content: ContentStore,
  assets: AssetStore,
  options: AssetCoverageOptions = {}
): Promise<AssetCoverageReport> {
  // Deferred kinds are reported on by nobody — see DEFERRED_ASSET_KINDS.
  const kinds: readonly AssetKind[] = options.kind ? [options.kind] : MANAGED_ASSET_KINDS;
  const entryLimit = options.entryLimit ?? 500;

  // Every kind's folder is read once up front — fallback chains cross kinds,
  // so resolving entry by entry would re-read the same folders repeatedly.
  const presentByKind = new Map<AssetKind, Set<string>>();
  await Promise.all(ASSET_KINDS.map(async kind => {
    presentByKind.set(kind, indexIds(kind, await assets.listIds(kind)));
  }));

  const results: AssetKindCoverage[] = [];

  for (const kind of kinds) {
    const info = ASSET_KIND_INFO[kind];
    const present = presentByKind.get(kind) ?? new Set<string>();
    const required = requiredIdsFor(kind, info, content);
    const overrideIds = overrideIdsFor(info, content);

    const entries: AssetCoverageEntry[] = [];
    let presentCount = 0;
    let coveredByFallback = 0;

    for (const req of required) {
      const hasOwnAsset = present.has(canonicalAssetId(kind, req.id));
      let resolvedVia: AssetResolution = hasOwnAsset ? 'own' : 'placeholder';

      if (hasOwnAsset) {
        presentCount++;
      } else {
        for (const fallback of info.fallbacks ?? []) {
          const pool = presentByKind.get(fallback.kind) ?? new Set<string>();
          const hit = aliasIdsFrom(req, fallback.idFrom)
            .some(fallbackId => pool.has(canonicalAssetId(fallback.kind, fallbackId)));
          if (hit) {
            resolvedVia = `fallback:${fallback.kind}`;
            coveredByFallback++;
            break;
          }
        }
        // An entity carrying its own artwork URL renders real art regardless of
        // what is (or isn't) sitting in the folder.
        if (resolvedVia === 'placeholder' && req.externalUrl) {
          resolvedVia = 'external';
          coveredByFallback++;
        }
      }

      if (options.includeEntries && entries.length < entryLimit && (!options.missingOnly || !hasOwnAsset)) {
        entries.push({ id: req.id, label: req.label, hasOwnAsset, resolvedVia });
      }
    }

    // Anything on disk that isn't a required id is either a recognized
    // override, a fallback alias, or an orphan left behind by a deleted entity.
    const requiredKeys = indexIds(kind, required.map(r => r.id));
    const overrideKeys = indexIds(kind, [...overrideIds]);
    const aliasKeys = indexIds(kind, [...aliasIdsFor(kind, info, required)]);
    let overrides = 0;
    const orphans: string[] = [];
    for (const diskId of present) {
      if (requiredKeys.has(diskId)) continue;
      if (overrideKeys.has(diskId) || aliasKeys.has(diskId)) { overrides++; continue; }
      orphans.push(diskId);
    }
    orphans.sort();

    results.push({
      kind,
      label: info.label,
      description: info.description,
      dir: info.dir,
      mount: info.mount,
      idFormat: info.idFormat,
      required: required.length,
      present: presentCount,
      missing: required.length - presentCount,
      coveredByFallback,
      overrides,
      orphans,
      ...(options.includeEntries ? { entries } : {}),
    });
  }

  const summary = results.reduce(
    (acc, kind) => ({
      kinds: acc.kinds + 1,
      required: acc.required + kind.required,
      present: acc.present + kind.present,
      missing: acc.missing + kind.missing,
      coveredByFallback: acc.coveredByFallback + kind.coveredByFallback,
      overrides: acc.overrides + kind.overrides,
      orphans: acc.orphans + kind.orphans.length,
    }),
    { kinds: 0, required: 0, present: 0, missing: 0, coveredByFallback: 0, overrides: 0, orphans: 0 }
  );

  return { generatedAt: new Date().toISOString(), summary, kinds: results };
}
