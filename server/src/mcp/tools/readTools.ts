import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorldData } from '@idle-party-rpg/shared';
import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared';
import { DRAFT_CONTENT_TYPES } from '../../game/DraftEditor.js';
import type { DraftContentType } from '../../game/DraftEditor.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/** The 13 content types editable through the generic draft-write surface — single source of truth, shared with writeTools.ts. */
const CONTENT_TYPES = DRAFT_CONTENT_TYPES;

/** Per-type field-shape cheat sheet, verbatim — used by `get_content_schema` so the calling AI doesn't have to guess field names. */
const CONTENT_TYPE_DESCRIPTIONS: Record<DraftContentType, string> = {
  monsters: "MonsterDefinition — id, name, hp, damage, damageType ('physical'|'magical'), xp, goldMin, goldMax, optional description (combat-popup flavor text), optional drops (ItemDrop[]: {itemId, chance, quantity?}), optional passive:true (makes it a \"wall\": never attacks, doesn't count toward victory — use for tactical obstacles, not real enemies).",
  items: "ItemDefinition — id, name, rarity ('janky'|'common'|'uncommon'|'rare'|'epic'|'legendary'|'heirloom'), optional slot (EquipSlot union: head/shoulders/chest/bracers/gloves/mainhand/offhand/twohanded/foot/ring/necklace/back/relic — omit entirely for non-equippable items), optional bonusAttackMin/Max, damageReductionMin/Max, magicReductionMin/Max, optional classRestriction (string[] of class names that can equip), optional value (gold sell price), optional grantedSkillIds (skills equippable ONLY while this item is equipped).",
  sets: 'SetDefinition — id, name, itemIds (string[]), optional classRestriction, breakpoints (SetBreakpoint[]: {piecesRequired, bonuses: SetBonuses}). Bonuses do NOT stack across tiers within one set (highest unlocked tier wins) but DO stack across different sets. SetBonuses: cooldownReduction, damagePercent, damageResistancePercent, damageReductionMin/Max, magicReductionMin/Max, bonusAttackMin/Max, flatHp, percentHp, optional grantedSkillIds.',
  shops: 'ShopDefinition — id, name, inventory (ShopItem[]: {itemId, stock, price}).',
  recipes: 'RecipeDefinition — id, name, durationSeconds (>0), ingredients (RecipeIngredient[]: {itemId, quantity>0}), result ({itemId, quantity>0}).',
  npcs: 'NpcDefinition — id, name, emoji (REQUIRED, always renders even with no artwork), greeting, optional artworkUrl, optional questIds (string[] quests this NPC offers).',
  quests: "QuestDefinition — id, name, description, scope ('solo' — only acceptable while in a solo party — or 'party_shared'), objectives (kill:{monsterId,count} | collect:{itemId,count, consumed on turn-in} | visit:{tileId}), rewards (xp|gold|item kinds), optional prerequisiteQuestIds, optional requiredLevel, repeat ('once'|'weekly').",
  dungeons: 'DungeonDefinition — id, name, optional description, floors (DungeonFloor[]: {floorNumber, gridShape:{cols,rows}, encounterTable, optional isBoss, optional rewards}), optional entryRequirements ({minLevel?,maxLevel?,requiredItemId?,consumeRequiredItem?,requiredClasses?,minPartySize?,maxPartySize?}), optional firstClearRewards + flat firstClearXp/firstClearGold.',
  zones: 'ZoneDefinition — id, displayName (NOTE: zones use displayName, NOT name), levelRange, encounterTable (EncounterTableEntry[]: {encounterId, weight}).',
  encounters: "EncounterDefinition — id, name, type ('random'|'explicit'), monsterPool (random: {monsterId,min,max}[]), optional placements (explicit type), optional roomMax.",
  tileTypes: 'TileTypeDefinition — id, name, icon (emoji), color (hex like #ff0000), traversable (boolean), optional requiredItemId (item required to enter any tile of this type, overridable per-tile).',
  skills: "SkillDefinition — id, className, type ('passive'|'active'), unlockLevel (number, or null = grant-only via item/set, never level-learned), sortOrder, cooldown (actives only), passiveEffects[] and/or activeEffects[] — each effect's \"kind\" must be one from SKILL_OPTION_CATALOG (import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared' — Record<string,SkillOptionDefinition> with {kind,slotType,label,description,targeting,params}). Percent params are stored as 0-1 fractions, not 0-100.",
  designNotes: 'DesignNote — id, title, body (markdown), optional tags (string[]), author (server fills this from the token label, do not accept from caller input), createdAt/updatedAt (server fills, ISO timestamps via new Date().toISOString()).',
};

function versionNotFoundError(versionId: string): string {
  return `Version '${versionId}' no longer exists — it may have been deleted between calls. Stop and check with the user before proceeding.`;
}

/** Reads a type's array from the live `ContentStore` (design notes included). */
function getLiveContentArray(deps: McpToolDeps, type: DraftContentType): unknown[] {
  const store = deps.contentStore();
  switch (type) {
    case 'monsters': return Object.values(store.getAllMonsters());
    case 'items': return Object.values(store.getAllItems());
    case 'sets': return Object.values(store.getAllSets());
    case 'shops': return Object.values(store.getAllShops());
    case 'recipes': return Object.values(store.getAllRecipes());
    case 'npcs': return Object.values(store.getAllNpcs());
    case 'quests': return Object.values(store.getAllQuests());
    case 'dungeons': return Object.values(store.getAllDungeons());
    case 'zones': return Object.values(store.getAllZones());
    case 'encounters': return Object.values(store.getAllEncounters());
    case 'tileTypes': return Object.values(store.getAllTileTypes());
    case 'skills': return Object.values(store.getAllSkills());
    case 'designNotes': return Object.values(store.getAllDesignNotes());
  }
}

/**
 * Resolves a content type's array against either a draft snapshot (`versionId` given) or
 * live content (`versionId` omitted). Shared by `list_content` and `get_content` so both
 * honor the same "halt on phantom version" rule.
 */
async function resolveContentArray(
  deps: McpToolDeps,
  type: DraftContentType,
  versionId: string | undefined
): Promise<{ array: unknown[] } | { error: string }> {
  if (!versionId) return { array: getLiveContentArray(deps, type) };
  const version = deps.versionStore().get(versionId);
  if (!version) return { error: versionNotFoundError(versionId) };
  const snapshot = await deps.versionStore().loadSnapshot(versionId);
  return { array: deps.draftEditor.getContentArray(type, snapshot) };
}

function worldResult(world: WorldData, mapId: string | undefined) {
  return {
    maps: world.maps,
    defaultMapId: world.defaultMapId,
    startTile: world.startTile,
    tiles: mapId ? world.tiles.filter(t => t.mapId === mapId) : world.tiles,
  };
}

export async function getOverview(deps: McpToolDeps) {
  try {
    const store = deps.contentStore();
    const counts = {
      monsters: Object.keys(store.getAllMonsters()).length,
      items: Object.keys(store.getAllItems()).length,
      zones: Object.keys(store.getAllZones()).length,
      encounters: Object.keys(store.getAllEncounters()).length,
      sets: Object.keys(store.getAllSets()).length,
      shops: Object.keys(store.getAllShops()).length,
      tileTypes: Object.keys(store.getAllTileTypes()).length,
      recipes: Object.keys(store.getAllRecipes()).length,
      npcs: Object.keys(store.getAllNpcs()).length,
      quests: Object.keys(store.getAllQuests()).length,
      dungeons: Object.keys(store.getAllDungeons()).length,
      skills: Object.keys(store.getAllSkills()).length,
      designNotes: Object.keys(store.getAllDesignNotes()).length,
    };
    const versionStore = deps.versionStore();
    const versions = versionStore.getAll().map(v => ({ id: v.id, name: v.name, status: v.status, isActive: v.isActive }));
    const activeVersionId = versionStore.getActiveVersionId();
    return { counts, versions, activeVersionId };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function listVersions(deps: McpToolDeps) {
  try {
    const versionStore = deps.versionStore();
    return { versions: versionStore.getAll(), activeVersionId: versionStore.getActiveVersionId() };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function listContent(deps: McpToolDeps, args: { type: DraftContentType; versionId?: string }) {
  try {
    const resolved = await resolveContentArray(deps, args.type, args.versionId);
    if ('error' in resolved) return { error: resolved.error };
    const entries = (resolved.array as Array<Record<string, unknown>>).map(entry => ({
      id: entry.id as string,
      label: (entry.name ?? entry.displayName ?? entry.title ?? entry.id) as string,
    }));
    return { type: args.type, versionId: args.versionId ?? null, count: entries.length, entries };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getContent(deps: McpToolDeps, args: { type: DraftContentType; id: string; versionId?: string }) {
  try {
    const resolved = await resolveContentArray(deps, args.type, args.versionId);
    if ('error' in resolved) return { error: resolved.error };
    const entry = (resolved.array as Array<{ id: string }>).find(e => e.id === args.id);
    if (!entry) return { error: `Not found: ${args.type} "${args.id}".` };
    return entry;
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getWorld(deps: McpToolDeps, args: { versionId?: string; mapId?: string }) {
  try {
    if (args.versionId) {
      const version = deps.versionStore().get(args.versionId);
      if (!version) return { error: versionNotFoundError(args.versionId) };
      const snapshot = await deps.versionStore().loadSnapshot(args.versionId);
      return worldResult(snapshot.world, args.mapId);
    }
    return worldResult(deps.contentStore().getWorld(), args.mapId);
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getContentSchema(args: { type: DraftContentType }) {
  try {
    const description = CONTENT_TYPE_DESCRIPTIONS[args.type];
    if (args.type === 'skills') {
      return { type: args.type, description, skillOptionCatalog: SKILL_OPTION_CATALOG };
    }
    return { type: args.type, description };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerReadTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'get_overview',
    {
      description: 'Content-catalog counts per type (monsters, items, zones, etc.) from live content, plus the list of content versions and which one is active.',
      inputSchema: {},
    },
    async () => {
      const result = await getOverview(deps);
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_versions',
    {
      description: 'List all content versions (drafts and published) and the currently active version id.',
      inputSchema: {},
    },
    async () => {
      const result = await listVersions(deps);
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_content',
    {
      description: 'List a light index (id + label) of every entry of one content type, either from live content or from a draft version snapshot.',
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to list.'),
        versionId: z.string().optional().describe('If given, list from this draft/version snapshot instead of live content.'),
      },
    },
    async (args) => {
      const result = await listContent(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_content',
    {
      description: 'Fetch the full definition of a single content entry by id, either from live content or from a draft version snapshot.',
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to look in.'),
        id: z.string().describe('The id of the entry to fetch.'),
        versionId: z.string().optional().describe('If given, look in this draft/version snapshot instead of live content.'),
      },
    },
    async (args) => {
      const result = await getContent(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_world',
    {
      description: 'Fetch world data (maps, default map, start tile, and rooms/tiles), either from live content or from a draft version snapshot. Optionally filter tiles to one map.',
      inputSchema: {
        versionId: z.string().optional().describe('If given, read world data from this draft/version snapshot instead of live content.'),
        mapId: z.string().optional().describe('If given, only return tiles belonging to this map.'),
      },
    },
    async (args) => {
      const result = await getWorld(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_content_schema',
    {
      description: "Field-shape cheat sheet for one content type — what fields it has, which are optional, and their quirks. For 'skills', also includes the full SKILL_OPTION_CATALOG of valid effect kinds.",
      inputSchema: {
        type: z.enum(CONTENT_TYPES).describe('Which content type to describe.'),
      },
    },
    async (args) => {
      const result = await getContentSchema(args);
      return toolResult(result);
    }
  );
}
