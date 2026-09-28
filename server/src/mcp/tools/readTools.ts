import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { WorldData } from '@idle-party-rpg/shared';
import {
  ARMOR_K,
  BOSS_TARGET_SECONDS,
  DEFAULT_CHECKPOINT_REWARD_FRACTION,
  DEFAULT_MAX_WIPES,
  DUNGEON_CHECKPOINT_TTL_MS,
  ELITE_DPS_MULTIPLIER,
  ELITE_HP_MULTIPLIER,
  ENRAGE_MAX_STACKS,
  ENRAGE_STEP_PERCENT,
  ENRAGE_STEP_SECONDS,
  ENRAGE_TIER_DEFAULTS,
  GOLD_PER_XP,
  LEVEL_CON_INFO,
  LEVEL_GAP_MAX,
  LEVEL_GAP_MIN,
  MASTERY_BONUS_PER_RANK,
  MASTERY_THRESHOLDS,
  MAX_MITIGATION,
  MONSTER_SKILL_CATALOG,
  MONSTER_TIERS,
  RAID_TARGET_SECONDS,
  REFERENCE_PARTY,
  REFERENCE_PARTY_STEADY_DPS,
  ROLE_MODIFIERS,
  SKILL_CARD_TYPE_INFO,
  SKILL_OPTION_CATALOG,
  SKILL_TRIGGER_INFO,
  TIER_DEFAULT_ATTACK_INTERVAL,
  TIER_HP_RATIOS,
  TIER_XP_BONUS,
  TRASH_DPS_PER_CLASS_HP,
  TRASH_HP_PER_CLASS_DAMAGE,
  XP_CON_FACTOR,
  XP_INCOME_DOUBLING_LEVELS,
  XP_INCOME_PARTY_L10_PER_DAY,
  XP_INCOME_SOLO_L1_PER_DAY,
  suggestMonsterStats,
} from '@idle-party-rpg/shared';
import { ENRAGE_LIMITS, MAX_WIPES_LIMIT, MONSTER_LEVEL_MAX, MONSTER_LEVEL_MIN } from '../../admin/contentChecks.js';
import { DRAFT_CONTENT_TYPES } from '../../game/DraftEditor.js';
import type { DraftContentType } from '../../game/DraftEditor.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/** The 14 content types editable through the generic draft-write surface — single source of truth, shared with writeTools.ts. */
const CONTENT_TYPES = DRAFT_CONTENT_TYPES;

/** Per-type field-shape cheat sheet, verbatim — used by `get_content_schema` so the calling AI doesn't have to guess field names. */
const CONTENT_TYPE_DESCRIPTIONS: Record<DraftContentType, string> = {
  monsters: "MonsterDefinition — id, name, hp, damage, damageType ('physical'|'magical'|'holy'), xp, goldMin, goldMax, optional attackInterval (seconds between the monster's actions; default 1, minimum 0.3 — lower = faster attacks; combat is real-time and every unit acts on its own timer), optional description (combat-popup flavor text), optional drops (ItemDrop[]: {itemId, chance, quantity?}), optional resistances (Resistance[]: {damageType, flatReduction, percentReduction} — reduce incoming player damage of that type), optional skills (MonsterSkillEntry[]: {skillId, value, cooldown, castTime?} — skillId must be a key of monsterSkillCatalog (returned alongside this description); value is the damage/heal/DoT amount per the catalog effect; cooldown is SECONDS after use (0 = usable on every action); castTime overrides the catalog's default wind-up in seconds (a cast is telegraphed to players and can be interrupted/countered). On each action a monster uses the first listed skill that is off cooldown and would have an effect, else it auto-attacks; unknown skillIds are skipped), optional passive:true (makes it a \"wall\": never acts, doesn't count toward victory — use for tactical obstacles, not real enemies), optional level (whole number 1-200), optional tier ('trash'|'elite'|'boss'|'raid', absent = 'trash'), optional enrage ({afterSeconds, stepSeconds?, stepPercent?, maxStacks?}). LEVEL: an authored level turns on level-relative scaling against players — damage between a player and the monster is multiplied by a level-gap factor (0.5-1.5, steeper at higher levels), armor/resistance ratings are judged against the attacker's level, players see a level badge with a difficulty colour, and players far above it earn less XP (trivial x0.25, easy x0.75). NO LEVEL = NO LEVEL SCALING: the monster fights exactly on its raw stats against every player, with no gap factor and no XP reduction, and players see no level number. Nothing is inferred for an unset level; set one deliberately (suggestMonsterStats in levelScaling.statTemplates gives on-level stats). TIER: never inferred from HP or from a dungeon floor's isBoss flag. Elite/boss/raid fights get a live win forecast; boss/raid monsters get a boss bar, can carry dungeon checkpoints, stall out only after 180 s without progress (30 s otherwise), and enrage by default. ENRAGE: outgoing damage (autos, skills, DoTs) x (1 + stacks x stepPercent); the first stack lands at afterSeconds, then one every stepSeconds (default 30) up to maxStacks (default 30); stepPercent is a FRACTION (default 0.10 = +10 % per stack). Absent = the tier default (boss 480 s, raid 3600 s, trash/elite never); an explicit enrage applies on any tier. See levelScaling (returned alongside this description) for templates, con bands, mastery thresholds and defaults.",
  items: "ItemDefinition — id, name, rarity ('janky'|'common'|'uncommon'|'rare'|'epic'|'legendary'|'heirloom'), optional slot (EquipSlot union: head/shoulders/chest/bracers/gloves/mainhand/offhand/twohanded/foot/ring/necklace/back/relic — omit entirely for non-equippable items), optional bonusAttackMin/Max, damageReductionMin/Max, magicReductionMin/Max, optional classRestriction (string[] of class names that can equip), optional value (gold sell price), optional grantedSkillIds (skills equippable ONLY while this item is equipped).",
  sets: 'SetDefinition — id, name, itemIds (string[]), optional classRestriction, breakpoints (SetBreakpoint[]: {piecesRequired, bonuses: SetBonuses}). Bonuses do NOT stack across tiers within one set (highest unlocked tier wins) but DO stack across different sets. SetBonuses: cooldownReduction (SECONDS off every active skill cooldown; fractions allowed; effective cooldown never drops below 1 s and never shortens Enemy-casts interrupts), damagePercent, damageResistancePercent, damageReductionMin/Max, magicReductionMin/Max, bonusAttackMin/Max, flatHp, percentHp, optional grantedSkillIds.',
  shops: 'ShopDefinition — id, name, inventory (ShopItem[]: {itemId, stock, price}), optional henchmanIds (string[] of HenchmanDefinition ids this shop offers for hire — hires are free, so there is no price to pair with them).',
  henchmen: "HenchmanDefinition — id, name, optional description (flavour line shown in the hire list), className ('Knight'|'Archer'|'Priest'|'Mage'|'Bard'), level, maxHp, baseDamage, optional damageType ('physical'|'magical'|'holy', overrides the archetype's damage type when set), skillIds (string[] of skill definition ids — the fixed loadout; ids the live server lacks resolve to an empty slot), emoji (REQUIRED, always renders even with no artwork), optional artworkUrl. Stats are FIXED: a henchman never levels, holds no equipment and has no inventory, so the definition is the whole of its power (level is a cosmetic display number — the stats above are authoritative, not derived from it). className is a HIDDEN combat archetype, not a player-facing label: the engine keys class checks off it (Sanctuary targeting, War Cry's targetClass, Martyr, monster all_class skill filters), but the hire UI never shows it. A shop offers henchmen for hire via its own henchmanIds array — there is no room/tile field for henchmen and no separate henchmen-shop content type.",
  recipes: 'RecipeDefinition — id, name, durationSeconds (>0), ingredients (RecipeIngredient[]: {itemId, quantity>0}), result ({itemId, quantity>0}).',
  npcs: 'NpcDefinition — id, name, emoji (REQUIRED, always renders even with no artwork), greeting, optional artworkUrl, optional questIds (string[] quests this NPC offers).',
  quests: "QuestDefinition — id, name, description, scope ('solo' — only acceptable while in a solo party — or 'party_shared'), objectives (kill:{monsterId,count} | collect:{itemId,count, consumed on turn-in} | visit:{tileId}), rewards (xp|gold|item kinds), optional prerequisiteQuestIds, optional requiredLevel, repeat ('once'|'weekly').",
  dungeons: "DungeonDefinition — id, name, optional description, floors (DungeonFloor[]: {floorNumber, gridShape:{cols,rows}, encounterTable, optional isBoss (HUD badge only — boss behaviour comes from the monster's tier), optional rewards, optional checkpoints, optional maxWipes, optional checkpointRewardFraction}), optional entryRequirements ({minLevel?,maxLevel?,requiredItemId?,consumeRequiredItem?,requiredClasses?,minPartySize?,maxPartySize?}), optional firstClearRewards + flat firstClearXp/firstClearGold. BOSS CHECKPOINTS: checkpoints is a list of boss-HP fractions, strictly between 0 and 1 in descending order (e.g. [0.66, 0.33]); they apply to every fight on the floor that includes a non-passive boss- or raid-tier monster, whether an explicit encounter places it or a random pool rolls it (several bosses share one pooled HP fraction), so at least one encounter on the floor's table must be able to field one — fights without a boss get no checkpoints. Each checkpoint reached pays every member checkpointRewardFraction (0-1, default 0.15) of the boss's xp and average gold, once per run. A wipe anywhere on that floor, boss fight or not, regroups the party at its last checkpoint (the boss restarts at that HP fraction) up to maxWipes times (whole number 0-20, default 3); one more wipe ejects the party and the checkpoint is lost. Leaving mid-fight on that floor counts as a wipe. Leaving the dungeon keeps the checkpoint for 7 days and re-entering resumes from it (the entry requirements and entry item still apply). maxWipes/checkpointRewardFraction have no effect without checkpoints. See checkpointDefaults (returned alongside this description).",
  zones: 'ZoneDefinition — id, displayName (NOTE: zones use displayName, NOT name), levelRange, encounterTable (EncounterTableEntry[]: {encounterId, weight}).',
  encounters: "EncounterDefinition — id, name, type ('random'|'explicit'), monsterPool (random: {monsterId,min,max}[]), optional placements (explicit type), optional roomMax.",
  tileTypes: 'TileTypeDefinition — id, name, icon (emoji), color (hex like #ff0000), traversable (boolean), optional entryRequirements ({minLevel?,requiredItemId?,requiredQuestIds?}) — the default entry gate for every room of this type, which rooms override field by field; legacy top-level requiredItemId is still honoured and folded into the gate.',
  skills: "SkillDefinition — id, name, description, className, type ('passive'|'active'), unlockLevel (number, or null = grant-only via item/set, never level-learned), sortOrder, passiveEffects[] and/or activeEffects[] — each effect's \"kind\" must be one from skillOptionCatalog (returned alongside this description; also import { SKILL_OPTION_CATALOG } from '@idle-party-rpg/shared' — Record<string,SkillOptionDefinition> with {kind,slotType,label,description,targeting,params}). Percent params are stored as 0-1 fractions, not 0-100. Combat is real-time (every unit acts about once per second). Active-only timing fields (passives must omit all four): cooldown (REQUIRED for actives, SECONDS after use, fractions allowed, at least 1), optional castTime (seconds of telegraphed wind-up, 0-10, default 0; triggered skills cannot have one), optional warmup (seconds before first use each battle, 0-60; omitted = cooldown minus 1 s for action skills and Enemy-casts interrupts, 0 for other triggered skills), optional trigger (one of the keys of skillTriggerInfo: 'ally_targeted'|'self_hit'|'enemy_cast'|'ally_afflicted'|'ally_low_hp' — makes the skill an off-action reaction instead of using the owner's action). Trigger inference: a skill with a redirect_hit option and no trigger is treated as 'ally_targeted', one with brace_reflect as 'self_hit' (redirect_hit REQUIRES ally_targeted, brace_reflect REQUIRES self_hit; never both in one skill). Each skill is shown to players as a card type derived from its fields (see skillCardTypeInfo): passive → 'triggered' if any passive kind is stun_on_phys_hit/martyr/resurrection/dot_on_auto/overflow/scorch/stacking_same_target/arcane_surge, else 'passive'; trigger enemy_cast (explicit) → 'interrupt'; any other trigger (explicit or inferred) → 'instant'; every active kind in heal_lowest/hot_lowest/cure_debuffs/shield_non_knight → 'support' (held until someone needs it); any party_buff_permanent/enemy_debuff_aoe/chaos → 'enchantment'; else 'attack'.",
  designNotes: 'DesignNote — id, title, body (markdown), optional tags (string[]), author (server fills this from the token label, do not accept from caller input), createdAt/updatedAt (server fills, ISO timestamps via new Date().toISOString()).',
};

const TEMPLATE_EXAMPLE_LEVELS = [1, 5, 10, 15, 20, 25, 30, 40, 50, 60, 80, 100];

/** Reference numbers returned with the monsters schema so an authoring AI can pick levels, tiers and stats. */
const LEVEL_SCALING_REFERENCE = {
  levels: {
    min: MONSTER_LEVEL_MIN,
    max: MONSTER_LEVEL_MAX,
    unset: 'No level set = no level scaling: raw stats against every player, no gap factor, no XP reduction, no level shown to players.',
    levelGap: `Damage between an authored-level monster and a player is multiplied by a level-gap factor clamped to ${LEVEL_GAP_MIN}-${LEVEL_GAP_MAX}; the slope per level of difference grows with the lower level.`,
    mitigation: `Armor/resistance rating R mitigates R / (R + ${ARMOR_K} x attacker level), capped at ${MAX_MITIGATION * 100} %. A monster's resistance flatReduction is such a rating; percentReduction is a straight percent (capped at 75 %).`,
  },
  tiers: {
    values: MONSTER_TIERS,
    absent: 'trash',
    hpHint: `Tier is never set automatically. validate_draft's info list suggests a tier when a monster's HP is at least these multiples of trash-template HP at its level: ${JSON.stringify(TIER_HP_RATIOS)}.`,
  },
  enrageDefaults: {
    byTier: ENRAGE_TIER_DEFAULTS,
    stepSeconds: ENRAGE_STEP_SECONDS,
    stepPercent: ENRAGE_STEP_PERCENT,
    maxStacks: ENRAGE_MAX_STACKS,
    limits: ENRAGE_LIMITS,
  },
  levelCon: {
    bands: 'Delta = monster level - player level. Player level >= 10: deadly >= +5, hard +3..+4, even -2..+2, easy down to -(5 + floor(player level / 10)), trivial below. Player level < 10: deadly >= +3, hard +2, the rest as above.',
    labels: LEVEL_CON_INFO,
    xpFactor: XP_CON_FACTOR,
  },
  mastery: {
    killThresholdsByTier: MASTERY_THRESHOLDS,
    bonusPerRank: MASTERY_BONUS_PER_RANK,
    effect: 'Each rank a player holds against a monster: damage dealt to it +2 %, damage taken from it -2 %.',
  },
  statTemplates: {
    function: 'suggestMonsterStats(level, tier, role?) -> {hp, damage, attackInterval, xp, goldMin, goldMax}; on-level starting points, tune from there.',
    trash: `HP = ${TRASH_HP_PER_CLASS_DAMAGE} x class-average damage, DPS = ${TRASH_DPS_PER_CLASS_HP} x class-average HP (fight length stays roughly level-independent).`,
    elite: `Trash template with ${ELITE_HP_MULTIPLIER}x HP and ${ELITE_DPS_MULTIPLIER}x DPS.`,
    bossAndRaid: `HP = the reference party's steady DPS x ${BOSS_TARGET_SECONDS} s (boss) or x ${RAID_TARGET_SECONDS} s (raid); a smaller party takes proportionally longer.`,
    referenceParty: REFERENCE_PARTY,
    referencePartySteadyDps: REFERENCE_PARTY_STEADY_DPS,
    xp: `Daily income model (${XP_INCOME_SOLO_L1_PER_DAY}/day at L1 solo, ${XP_INCOME_PARTY_L10_PER_DAY}/day at L10 in a party, x2 every ${XP_INCOME_DOUBLING_LEVELS} levels above) spread over the reference kill time, x tier bonus ${JSON.stringify(TIER_XP_BONUS)}. Gold averages ${GOLD_PER_XP} x xp, +-30 %.`,
    defaultAttackInterval: TIER_DEFAULT_ATTACK_INTERVAL,
    roles: ROLE_MODIFIERS,
    examples: TEMPLATE_EXAMPLE_LEVELS.map(level => ({
      level,
      trash: suggestMonsterStats(level, 'trash'),
      elite: suggestMonsterStats(level, 'elite'),
      boss: suggestMonsterStats(level, 'boss'),
      raid: suggestMonsterStats(level, 'raid'),
    })),
  },
};

const CHECKPOINT_REFERENCE = {
  maxWipes: { default: DEFAULT_MAX_WIPES, min: 0, max: MAX_WIPES_LIMIT },
  checkpointRewardFraction: { default: DEFAULT_CHECKPOINT_REWARD_FRACTION, min: 0, max: 1 },
  checkpointExpiryDays: DUNGEON_CHECKPOINT_TTL_MS / 86_400_000,
  example: { checkpoints: [0.66, 0.33], maxWipes: DEFAULT_MAX_WIPES },
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
      return { type: args.type, description, monsterSkillCatalog: MONSTER_SKILL_CATALOG, levelScaling: LEVEL_SCALING_REFERENCE };
    }
    if (args.type === 'dungeons') {
      return { type: args.type, description, checkpointDefaults: CHECKPOINT_REFERENCE };
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
      description: "Field-shape cheat sheet for one content type — what fields it has, which are optional, and their quirks. For 'skills', also includes the full SKILL_OPTION_CATALOG of valid effect kinds plus the trigger and card-type tables; for 'monsters', the MONSTER_SKILL_CATALOG of valid monster skill ids with their default cooldown and cast time plus levelScaling (level range and what an unset level means, tiers, enrage defaults, level-con bands, mastery thresholds, and suggestMonsterStats templates with worked examples); for 'dungeons', checkpointDefaults (maxWipes, checkpointRewardFraction, checkpoint expiry).",
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
