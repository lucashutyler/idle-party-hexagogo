import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorldData } from '@idle-party-rpg/shared';
import {
  MONSTER_SKILL_CATALOG,
  SKILL_CARD_TYPE_INFO,
  SKILL_OPTION_CATALOG,
  SKILL_TRIGGER_INFO,
} from '@idle-party-rpg/shared';
import { DRAFT_CONTENT_TYPES } from '../../game/DraftEditor.js';
import type { DraftContentType } from '../../game/DraftEditor.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/** The 14 content types editable through the generic draft-write surface — single source of truth, shared with writeTools.ts. */
const CONTENT_TYPES = DRAFT_CONTENT_TYPES;

/** Per-type field-shape cheat sheet, verbatim — used by `get_content_schema` so the calling AI doesn't have to guess field names. */
const CONTENT_TYPE_DESCRIPTIONS: Record<DraftContentType, string> = {
  monsters: "MonsterDefinition — id, name, hp, damage, damageType ('physical'|'magical'|'holy'), xp, goldMin, goldMax, optional attackInterval (seconds between the monster's actions; default 1, minimum 0.3 — lower = faster attacks; combat is real-time and every unit acts on its own timer), optional description (combat-popup flavor text), optional drops (ItemDrop[]: {itemId, chance, quantity?}), optional resistances (Resistance[]: {damageType, flatReduction, percentReduction} — reduce incoming player damage of that type), optional skills (MonsterSkillEntry[]: {skillId, value, cooldown, castTime?} — skillId must be a key of monsterSkillCatalog (returned alongside this description); value is the damage/heal/DoT amount per the catalog effect; cooldown is SECONDS after use (0 = usable on every action); castTime overrides the catalog's default wind-up in seconds (a cast is telegraphed to players and can be interrupted/countered). On each action a monster uses the first listed skill that is off cooldown and would have an effect, else it auto-attacks; unknown skillIds are skipped), optional passive:true (makes it a \"wall\": never acts, doesn't count toward victory — use for tactical obstacles, not real enemies).",
  items: "ItemDefinition — id, name, rarity ('janky'|'common'|'uncommon'|'rare'|'epic'|'legendary'|'heirloom'), optional slot (EquipSlot union: head/shoulders/chest/bracers/gloves/mainhand/offhand/twohanded/foot/ring/necklace/back/relic — omit entirely for non-equippable items), optional bonusAttackMin/Max, damageReductionMin/Max, magicReductionMin/Max, optional classRestriction (string[] of class names that can equip), optional value (gold sell price), optional grantedSkillIds (skills equippable ONLY while this item is equipped).",
  sets: 'SetDefinition — id, name, itemIds (string[]), optional classRestriction, breakpoints (SetBreakpoint[]: {piecesRequired, bonuses: SetBonuses}). Bonuses do NOT stack across tiers within one set (highest unlocked tier wins) but DO stack across different sets. SetBonuses: cooldownReduction (SECONDS off every active skill cooldown; fractions allowed; effective cooldown never drops below 1 s and never shortens Enemy-casts interrupts), damagePercent, damageResistancePercent, damageReductionMin/Max, magicReductionMin/Max, bonusAttackMin/Max, flatHp, percentHp, optional grantedSkillIds.',
  shops: 'ShopDefinition — id, name, inventory (ShopItem[]: {itemId, stock, price}), optional henchmanIds (string[] of HenchmanDefinition ids this shop offers for hire — hires are free, so there is no price to pair with them).',
  henchmen: "HenchmanDefinition — id, name, optional description (flavour line shown in the hire list), className ('Knight'|'Archer'|'Priest'|'Mage'|'Bard'), level, maxHp, baseDamage, optional damageType ('physical'|'magical'|'holy', overrides the archetype's damage type when set), skillIds (string[] of skill definition ids — the fixed loadout; ids the live server lacks resolve to an empty slot), emoji (REQUIRED, always renders even with no artwork), optional artworkUrl. Stats are FIXED: a henchman never levels, holds no equipment and has no inventory, so the definition is the whole of its power (level is a cosmetic display number — the stats above are authoritative, not derived from it). className is a HIDDEN combat archetype, not a player-facing label: the engine keys class checks off it (Sanctuary targeting, War Cry's targetClass, Martyr, monster all_class skill filters), but the hire UI never shows it. A shop offers henchmen for hire via its own henchmanIds array — there is no room/tile field for henchmen and no separate henchmen-shop content type.",
  recipes: 'RecipeDefinition — id, name, durationSeconds (>0), ingredients (RecipeIngredient[]: {itemId, quantity>0}), result ({itemId, quantity>0}).',
  npcs: 'NpcDefinition — id, name, emoji (REQUIRED, always renders even with no artwork), greeting, optional artworkUrl, optional questIds (string[] quests this NPC offers).',
  quests: "QuestDefinition — id, name, description, scope ('solo' — only acceptable while in a solo party — or 'party_shared'), objectives (kill:{monsterId,count} | collect:{itemId,count, consumed on turn-in} | visit:{tileId}), rewards (xp|gold|item kinds), optional prerequisiteQuestIds, optional requiredLevel, repeat ('once'|'weekly').",
  dungeons: 'DungeonDefinition — id, name, optional description, floors (DungeonFloor[]: {floorNumber, gridShape:{cols,rows}, encounterTable, optional isBoss, optional rewards}), optional entryRequirements ({minLevel?,maxLevel?,requiredItemId?,consumeRequiredItem?,requiredClasses?,minPartySize?,maxPartySize?}), optional firstClearRewards + flat firstClearXp/firstClearGold.',
  zones: 'ZoneDefinition — id, displayName (NOTE: zones use displayName, NOT name), levelRange, encounterTable (EncounterTableEntry[]: {encounterId, weight}).',
  encounters: "EncounterDefinition — id, name, type ('random'|'explicit'), monsterPool (random: {monsterId,min,max}[]), optional placements (explicit type), optional roomMax.",
  tileTypes: 'TileTypeDefinition — id, name, icon (emoji), color (hex like #ff0000), traversable (boolean), optional entryRequirements ({minLevel?,requiredItemId?,requiredQuestIds?}) — the default entry gate for every room of this type, which rooms override field by field; legacy top-level requiredItemId is still honoured and folded into the gate.',
  skills: "SkillDefinition — id, name, description, className, type ('passive'|'active'), unlockLevel (number, or null = grant-only via item/set, never level-learned), sortOrder, passiveEffects[] and/or activeEffects[] — each effect's \"kind\" must be one from skillOptionCatalog (returned alongside this description; also import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared' — Record<string,SkillOptionDefinition> with {kind,slotType,label,description,targeting,params}). Percent params are stored as 0-1 fractions, not 0-100. Combat is real-time (every unit acts about once per second). Active-only timing fields (passives must omit all four): cooldown (REQUIRED for actives, SECONDS after use, fractions allowed, at least 1), optional castTime (seconds of telegraphed wind-up, 0-10, default 0; triggered skills cannot have one), optional warmup (seconds before first use each battle, 0-60; omitted = cooldown minus 1 s for action skills and Enemy-casts interrupts, 0 for other triggered skills), optional trigger (one of the keys of skillTriggerInfo: 'ally_targeted'|'self_hit'|'enemy_cast'|'ally_afflicted'|'ally_low_hp' — makes the skill an off-action reaction instead of using the owner's action). Trigger inference: a skill with a redirect_hit option and no trigger is treated as 'ally_targeted', one with brace_reflect as 'self_hit' (redirect_hit REQUIRES ally_targeted, brace_reflect REQUIRES self_hit; never both in one skill). Each skill is shown to players as a card type derived from its fields (see skillCardTypeInfo): passive → 'triggered' if any passive kind is stun_on_phys_hit/martyr/resurrection/dot_on_auto/overflow/scorch/stacking_same_target/arcane_surge, else 'passive'; trigger enemy_cast (explicit) → 'interrupt'; any other trigger (explicit or inferred) → 'instant'; every active kind in heal_lowest/hot_lowest/cure_debuffs/shield_non_knight → 'support' (held until someone needs it); any party_buff_permanent/enemy_debuff_aoe/chaos → 'enchantment'; else 'attack'.",
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
    case 'henchmen': return Object.values(store.getAllHenchmen());
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
      henchmen: Object.keys(store.getAllHenchmen()).length,
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
      return {
        type: args.type,
        description,
        skillOptionCatalog: SKILL_OPTION_CATALOG,
        skillTriggerInfo: SKILL_TRIGGER_INFO,
        skillCardTypeInfo: SKILL_CARD_TYPE_INFO,
      };
    }
    if (args.type === 'monsters') {
      return { type: args.type, description, monsterSkillCatalog: MONSTER_SKILL_CATALOG };
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
      description: "Field-shape cheat sheet for one content type — what fields it has, which are optional, and their quirks. For 'skills', also includes the full SKILL_OPTION_CATALOG of valid effect kinds plus the trigger and card-type tables; for 'monsters', the MONSTER_SKILL_CATALOG of valid monster skill ids with their default cooldown and cast time.",
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
