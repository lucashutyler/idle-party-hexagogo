import {
  HexGrid,
  HexTile,
  UnlockSystem,
  offsetToCube,
  createCharacter,
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
  addXp,
  addGold,
  calculateMaxHp,
  calculateBaseDamage,
  xpForNextLevel,
  computeEquipmentBonuses,
  computeActiveSetBonuses,
  mergeSetBonusesIntoEquip,
  MAX_STACK,
  addItemToInventory,
  equipItem,
  unequipItem,
  destroyItems,
  equipItemForceDestroy,
  EQUIP_SLOTS,
  isTwoHandedEquipped,
  getOwnedItemIds,
  getEquippedItemIds,
  hasItemEquipped as inventoryHasItemEquipped,
  getZone,
  setAppliesToClass,
  createDefaultSkillLoadout,
  findAttackSkill,
  isActionSkill,
  MAX_ACTION_ORDER_LENGTH,
  reconcileSkillLoadout,
  computeGrantedSkillIds,
  getUnlockedSkillsForLevel,
  equipSkillInSlot,
  unequipSkillFromSlot,
  emptyCraftQueue,
  enqueueRecipe,
  cancelJobAt,
  processCompletions,
  getActiveJobProgress,
  getVisibleRecipes,
  addCraftXp,
  xpForCraftLevel,
  getCraftSkillName,
  emptyNotificationPreferences,
  STATE_LOG_TAIL,
  DEFAULT_COMBAT_PREFS,
  sanitizeCombatPrefs,
  masteryRank,
  masteryRanks,
  masteryBonus,
  isMasteryMoment,
  buildMasteryEntry,
  MASTERY_THRESHOLDS,
  effectiveMonsterTier,
  isAuthoredMonsterLevel,
  clampMonsterLevel,
  createAwayLedger,
  closeAwayLedger,
  isAwayLedgerWorthRecap,
  mergeAwayLedgers,
  recordAwayBattle,
  recordAwayItem,
  recordAwayItemsLost,
  recordAwayRetreat,
  recordAwayMastery,
  recordAwayCloseCall,
  recordAwayRouteStopped,
  addAwayMoment,
  awayRarityRank,
  AWAY_NOTABLE_MIN_RARITY,
  AWAY_MAX_MOMENTS,
  AWAY_MAX_NOTABLE_ITEMS,
  AWAY_MAX_DUNGEONS,
  AWAY_MAX_RETREATS,
  AWAY_MOMENT_PRIORITY,
  acceptableQuestIds,
  nextWeeklyReopening,
  isBlockedUser,
} from '@idle-party-rpg/shared';
import { COMBAT_PACE, paceHitDamage } from '@idle-party-rpg/shared';
import type {
  CombatPrefs,
  DungeonCheckpoint,
  DungeonRunState,
  AwayLedger,
  AwayMoment,
  AwayMomentKind,
  AwayRetreatEntry,
  AwayCloseCall,
  AwayDungeonEntry,
  AwayDungeonOutcome,
  AwayMasteryUp,
  AwayNotableItem,
  ItemRarity,
  MasteryEntry,
  MasteryMonsterInfo,
  MasterySummary,
  MonsterTier,
  HiredHenchman,
  HenchmanOffer,
  ServerStateMessage,
  ServerBattleState,
  ServerPartyState,
  OtherPlayerState,
  CombatLogEntry,
  CharacterState,
  ClassName,
  PartyCombatantInit,
  ClientCharacterState,
  EquipSlot,
  ClientSocialState,
  BlockLevel,
  ChatMessage,
  PartyGridPosition,
  FriendRequest,
  ChatChannelType,
  ItemDefinition,
  SetDefinition,
  ShopDefinition,
  SkillDefinition,
  SkillLoadout,
  SkillContent,
  MailboxEntry,
  CraftQueueState,
  ClientCraftingCatalog,
  ClientCraftingProgress,
  EnqueueError,
  NotificationEntry,
  NotificationPreferences,
  WebPushSubscription,
} from '@idle-party-rpg/shared';
import { randomUUID } from 'crypto';
import type { PlayerSaveData } from './GameStateStore.js';
import type { ContentStore } from './ContentStore.js';
import type { WorldGrids } from './WorldGrids.js';
import { QuestSystem } from './QuestSystem.js';
import type { QuestEvent } from './QuestSystem.js';
import type { QuestDefinition, QuestProgressEntry, CompletedQuestEntry } from '@idle-party-rpg/shared';

const MAX_LOG_ENTRIES = 1000;
const MAX_SAVE_LOG_ENTRIES = 1000;
const MAX_CHAT_HISTORY = 1000;
const MASTERY_RECENT_COUNT = 5;
/** A victory at or below this share of party HP becomes a recap moment. */
const CLOSE_CALL_MOMENT_PCT = 20;

/** A monster credited to kill mastery; the tier is the one it had in the fight. */
export interface KilledMonster {
  id: string;
  name: string;
  tier?: MonsterTier;
}

export class PlayerSession {
  username: string;
  private grids: WorldGrids;
  private content: ContentStore;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private logIdCounter = 0;
  private battleCount = 0;
  private character: CharacterState | null = null;
  private chatHistory: ChatMessage[] = [];
  private friends: string[] = [];
  private outgoingFriendRequests: FriendRequest[] = [];
  private blockedUsers: Record<string, BlockLevel> = {};
  private guildId: string | null = null;
  private partyId: string | null = null;
  /** Dungeon IDs this player has cleared at least once (for one-time first-clear rewards). */
  private clearedDungeons = new Set<string>();
  private dungeonCheckpoints: Record<string, DungeonCheckpoint> = emptyCheckpoints();
  private monsterKills: Record<string, number> = emptyKillCounts();
  /** Monster ids by most recent kill, newest first. In memory only. */
  private recentKills: string[] = [];
  private combatPrefs: CombatPrefs = { ...DEFAULT_COMBAT_PREFS };
  private autoRetreatNotified = false;
  private awayLedger: AwayLedger | null = null;
  private pendingRecap: AwayLedger | null = null;
  private chatSendChannel: ChatChannelType = 'zone';
  private chatDmTarget = '';
  private craftQueue: CraftQueueState = emptyCraftQueue();
  /** Mailbox entries from a save written before MailboxStore existed. */
  private initialMailbox: MailboxEntry[] = [];
  /** Initial notification inbox snapshot from save data; live state lives in NotificationSystem. */
  private initialNotifications: NotificationEntry[] = [];
  /** Callback to fetch the player's live notification inbox from NotificationSystem. */
  getNotifications?: () => NotificationEntry[];
  private notificationPreferences: NotificationPreferences = emptyNotificationPreferences();
  private pushSubscriptions: WebPushSubscription[] = [];
  /** Which chat thread the player is actively looking at right now, if any — ephemeral, not persisted. */
  private chatFocus: { channelType: string; channelId: string } | null = null;
  private availableQuests: { key: string; ids: string[]; computedAt: number; staleAt: number } | null = null;
  /** Per-player quest tracking. */
  quests: QuestSystem;

  /** XP rate tracking — in-memory only, resets on server restart. */
  private xpRateStartTime = Date.now();
  private xpRateXpTotal = 0;

  /** Callback to get social state — set by PlayerManager after construction. */
  getSocialState?: () => ClientSocialState;

  /** Callback to get battle state — set by PlayerManager. */
  getBattleState?: () => ServerBattleState | null;

  /** Callback to get party movement state — set by PlayerManager. */
  getPartyPositionState?: () => ServerPartyState | null;

  /** Callback to get zone — set by PlayerManager. */
  getPartyZone?: () => string | null;

  /** Callback to get the party's current mapId — set by PlayerManager. */
  getPartyMapId?: () => string | null;

  /** Callback to get position — set by PlayerManager. */
  getPartyPosition?: () => { col: number; row: number } | null;

  /** Callback to get the current tile — set by PlayerManager. */
  getCurrentTile?: () => HexTile | null;

  /** Callback to get the remaining movement path — set by PlayerManager. */
  getCurrentPath?: () => HexTile[];

  /** Callback to get the active dungeon run state — set by PlayerManager. */
  getDungeonState?: () => import('@idle-party-rpg/shared').DungeonRunInfo | null;

  constructor(username: string, grids: WorldGrids, content: ContentStore, onQuestEvent?: (event: QuestEvent) => void) {
    this.username = username;
    this.grids = grids;
    this.content = content;
    this.quests = new QuestSystem(username, onQuestEvent);

    const startPos = content.getStartTile();
    const startCoord = offsetToCube(startPos);
    // New players spawn on the world's default map.
    const startTile = this.defaultGrid().getTile(startCoord);

    if (!startTile) {
      throw new Error('Invalid starting position');
    }

    this.unlockSystem = new UnlockSystem(this.defaultGrid(), startTile);
  }

  /** The world's default (spawn) map grid — used for spawn / starting-tile lookups. */
  private defaultGrid(): HexGrid {
    return this.grids.getOrThrow(this.content.getWorld().defaultMapId);
  }

  /** The grid for the map the party is currently on (falls back to the default map). */
  private currentGrid(): HexGrid {
    const mapId = this.getPartyMapId?.() ?? this.content.getWorld().defaultMapId;
    return this.grids.get(mapId) ?? this.defaultGrid();
  }

  /** The map the party is currently on. */
  getMapId(): string {
    return this.getPartyMapId?.() ?? this.content.getWorld().defaultMapId;
  }

  /**
   * Re-seat unlocks on the map the party just switched to and reveal the arrival
   * area. The party's mapId must already be switched before this is called (the
   * grid is resolved from the party's current mapId).
   */
  switchMapGrid(arrivalTile: HexTile): void {
    this.unlockSystem = UnlockSystem.fromKeys(this.currentGrid(), this.getUnlockedKeys());
    this.forceUnlockTileArea(arrivalTile);
  }

  /** Get combat info for the party combat system. Requires character to exist. Without `gridPosition` it is read from the party. */
  getCombatInfo(gridPosition?: PartyGridPosition): PartyCombatantInit {
    if (!this.character) throw new Error('getCombatInfo called on characterless session');
    const baseMaxHp = calculateMaxHp(this.character.level, this.character.className);
    let baseDamage = calculateBaseDamage(this.character.level, this.character.className);
    const rawEquipBonuses = computeEquipmentBonuses(this.character.equipment, this.content.getAllItems(), this.character.level);
    const playerDamageType = CLASS_DEFINITIONS[this.character.className].damageType;

    // Compute set bonuses (filtered by class) and merge flat DR/MR/attack into equipBonuses.
    // Multiplicative bonuses (damagePercent, damageResistancePercent, cooldownReduction)
    // ride along on `setBonuses` so the combat engine can consume them at the right time.
    const setResult = computeActiveSetBonuses(this.character.equipment, this.content.getAllSets(), this.character.className);
    const equipBonuses = mergeSetBonusesIntoEquip(rawEquipBonuses, setResult.bonuses);
    const flatHp = setResult.bonuses.flatHp ?? 0;
    const percentHp = setResult.bonuses.percentHp ?? 0;
    const maxHp = Math.max(1, Math.floor((baseMaxHp + flatHp) * (1 + percentHp / 100)));

    // Resolve equipped skill definitions from live content. Grants are NOT
    // auto-appended here — they only gate which skills can occupy a slot.
    const equippedSkills: (SkillDefinition | null)[] = this.character.skillLoadout.equippedSkills.map(
      id => id ? this.content.getSkill(id) ?? null : null
    );

    const info: PartyCombatantInit = {
      username: this.username,
      maxHp,
      baseDamage,
      playerDamageType,
      equipBonuses,
      setBonuses: setResult.bonuses,
      gridPosition: gridPosition ?? this.partyGridPosition(),
      className: this.character.className,
      level: this.character.level,
      equippedSkills,
    };
    const attack = findAttackSkill(this.character.className, this.content.getAllSkills());
    if (attack) info.attack = attack;
    const actionOrder = this.character.skillLoadout.actionOrder;
    if (actionOrder?.length) info.actionOrder = [...actionOrder];
    const mastery = masteryRanks(this.monsterKills, id => this.monsterTier(id));
    if (Object.keys(mastery).length > 0) info.mastery = mastery;
    return info;
  }

  private partyGridPosition(): PartyGridPosition {
    const member = this.getSocialState?.().party?.members.find(m => m.username === this.username);
    return member?.gridPosition ?? 4;
  }

  /**
   * Handle victory rewards (called by PartyBattleManager with pre-split rewards).
   * Set `options.unlockTiles = false` to skip adjacent-tile unlocking (dungeon
   * floors aren't overworld tiles).
   */
  handleVictory(
    rewards: { xp: number; gold: number; items: string[] },
    tile: HexTile,
    options?: { unlockTiles?: boolean; kills?: number },
  ): void {
    if (!this.character) return;
    this.addLogEntry('Victory!', 'victory');

    if (options?.unlockTiles !== false) {
      const unlocked = this.unlockSystem.unlockAdjacentTiles(tile);
      if (unlocked.length > 0) {
        this.addLogEntry(`${unlocked.length} new room${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
      }
    }

    let goldAdded = 0;
    if (rewards.gold > 0) {
      goldAdded = addGold(this.character, rewards.gold);
      this.addLogEntry(`+${rewards.gold} Gold`, 'victory');
    }

    for (const itemId of rewards.items) {
      const itemDef = this.storeRewardItem(itemId);
      if (itemDef) this.addLogEntry(`Found ${itemDef.name}!`, 'victory');
    }

    const { levelsGained } = addXp(this.character, rewards.xp);
    this.xpRateXpTotal += rewards.xp;
    this.addLogEntry(`+${rewards.xp} XP`, 'victory');
    this.announceLevelUps(levelsGained);
    this.updateAway(l => recordAwayBattle(l, { won: true, xp: rewards.xp, gold: goldAdded, kills: options?.kills ?? 0 }));
  }

  /** Journal lines, recap moment and skill unlocks for levels just gained. */
  private announceLevelUps(levelsGained: number): void {
    if (!this.character || levelsGained <= 0) return;
    for (let i = 0; i < levelsGained; i++) {
      this.addLogEntry(`Level up! Now level ${this.character.level - levelsGained + i + 1}!`, 'levelup');
    }
    this.addAwayMoment('level_up', `Reached level ${this.character.level}`);
    this.autoUnlockSkills();
  }

  /** Add a combat reward item; a full stack counts as lost in the away recap. Returns the definition when stored. */
  private storeRewardItem(itemId: string): ItemDefinition | null {
    if (!this.character) return null;
    const def = this.content.getItem(itemId);
    if (!def) return null;
    if (!addItemToInventory(this.character.inventory, itemId)) {
      this.updateAway(l => recordAwayItemsLost(l, 1));
      return null;
    }
    const rarity = def.rarity ?? 'common';
    this.updateAway(l => recordAwayItem(l, itemId, rarity));
    if (awayRarityRank(rarity) >= awayRarityRank(AWAY_NOTABLE_MIN_RARITY)) {
      this.addAwayMoment('rare_item', `Found ${def.name}`, { itemId });
    }
    return def;
  }

  /** Check if a tile is unlocked for this player. */
  isTileUnlocked(tile: HexTile): boolean {
    return this.unlockSystem.isUnlocked(tile);
  }

  /** Unlocks are keyed by room GUID, so this works for rooms on any map. */
  isTileIdUnlocked(tileId: string): boolean {
    return this.unlockSystem.isUnlockedByKey(tileId);
  }

  /** Returns true if this player has no character (hasn't selected a class yet). */
  isNewPlayer(): boolean {
    return this.character === null;
  }

  /** Returns true if this player has a character (has selected a class). */
  hasCharacter(): boolean {
    return this.character !== null;
  }

  incrementBattleCount(): void {
    this.battleCount++;
  }

  resetXpRate(): void {
    this.xpRateStartTime = Date.now();
    this.xpRateXpTotal = 0;
  }

  /**
   * Get all world tiles with zone display names populated.
   * Client determines fog of war rendering using state.unlocked.
   */
  getWorldData(): {
    startTile: { col: number; row: number };
    defaultMapId: string;
    maps: import('@idle-party-rpg/shared').WorldMapMeta[];
    tiles: import('@idle-party-rpg/shared').WorldTileDefinition[];
  } {
    const world = this.content.getWorld();
    const allZones = this.content.getAllZones();

    return {
      startTile: world.startTile,
      defaultMapId: world.defaultMapId,
      maps: world.maps,
      tiles: world.tiles.map(wt => {
        const zone = getZone(wt.zone, allZones);
        return { ...wt, zoneName: zone?.displayName ?? wt.zone };
      }),
    };
  }

  /**
   * Build item definitions for items the player currently owns (inventory + equipment),
   * plus shop items and every piece of any set the player has at least one piece of —
   * the latter so the set-info popup can render piece names instead of item GUIDs.
   */
  private getOwnedItemDefinitions(setDefs: Record<string, SetDefinition>): Record<string, ItemDefinition> {
    if (!this.character) return {};
    const defs: Record<string, ItemDefinition> = {};

    // Owned items (unequipped + equipped, deduped)
    for (const itemId of getOwnedItemIds(this.character.inventory, this.character.equipment)) {
      const def = this.content.getItem(itemId);
      if (def) defs[itemId] = def;
    }

    // Shop items (so client has defs for buyable items)
    const shop = this.getCurrentShop();
    if (shop) {
      for (const si of shop.inventory) {
        if (!defs[si.itemId]) {
          const def = this.content.getItem(si.itemId);
          if (def) defs[si.itemId] = def;
        }
      }
    }

    // Set pieces — needed so the popup can render names for unowned pieces of a set the player partially owns.
    for (const set of Object.values(setDefs)) {
      for (const itemId of set.itemIds) {
        if (!defs[itemId]) {
          const def = this.content.getItem(itemId);
          if (def) defs[itemId] = def;
        }
      }
    }

    return defs;
  }

  /**
   * Build set definitions for sets the player can activate AND owns at least one piece of.
   * Class-restricted sets that don't include the player's class are excluded — owning a
   * piece of a Knight set as a Bard does nothing for the Bard, so the popup shouldn't
   * mention it on their own item view.
   */
  private getOwnedSetDefinitions(): Record<string, SetDefinition> {
    if (!this.character) return {};
    const ownedItemIds = getOwnedItemIds(this.character.inventory, this.character.equipment);

    const allSets = this.content.getAllSets();
    const result: Record<string, SetDefinition> = {};
    for (const [id, set] of Object.entries(allSets)) {
      if (!setAppliesToClass(set, this.character.className)) continue;
      if (set.itemIds.some(itemId => ownedItemIds.has(itemId))) {
        result[id] = set;
      }
    }
    return result;
  }

  /** Shop for the player's current room. Resolve rooms by GUID — col/row repeat across maps. */
  getCurrentShop(): ShopDefinition | undefined {
    const tileId = this.getCurrentTile?.()?.id;
    if (!tileId) return undefined;
    const tileDef = this.content.getTileById(tileId);
    if (!tileDef?.shopId) return undefined;
    return this.content.getShop(tileDef.shopId);
  }

  getHenchmanOffers(): HenchmanOffer[] {
    const shop = this.getCurrentShop();
    if (!shop?.henchmanIds?.length) return [];
    const offers: HenchmanOffer[] = [];
    for (const id of shop.henchmanIds) {
      const def = this.content.getHenchman(id);
      if (!def) continue;
      offers.push({
        henchmanId: def.id,
        name: def.name,
        description: def.description,
        emoji: def.emoji,
        artworkUrl: def.artworkUrl,
        level: def.level,
        maxHp: def.maxHp,
        baseDamage: paceHitDamage(COMBAT_PACE, def.className, def.baseDamage),
      });
    }
    return offers;
  }

  /** NPC definition for the player's current room, if any. */
  private getCurrentNpc(): import('@idle-party-rpg/shared').NpcDefinition | undefined {
    const tileId = this.getCurrentTile?.()?.id;
    if (!tileId) return undefined;
    const tileDef = this.content.getTileById(tileId);
    if (!tileDef?.npcId) return undefined;
    return this.content.getNpc(tileDef.npcId);
  }

  /** Quests some NPC offers that this player can accept now; recomputed only when an input to that answer changes. */
  private getAvailableQuestIds(
    allQuests: Readonly<Record<string, QuestDefinition>>,
    weeklyCompletions: Record<string, string>,
  ): string[] {
    if (!this.character) return [];
    const key = `${this.content.getQuestRevision()}:${this.quests.getRevision()}:${this.character.level}`;
    const now = Date.now();
    const cached = this.availableQuests;
    if (cached && cached.key === key && now >= cached.computedAt && now < cached.staleAt) return cached.ids;

    const ids = acceptableQuestIds(this.content.getNpcQuestIds(), allQuests, {
      playerLevel: this.character.level,
      activeQuestIds: this.quests.getActiveQuestIds(),
      completedQuestIds: this.quests.getCompletedQuestIds(),
      weeklyCompletions,
      now: new Date(now),
    });
    this.availableQuests = { key, ids, computedAt: now, staleAt: nextWeeklyReopening(weeklyCompletions, now) };
    return ids;
  }

  /** Quest data block for the state message: active progress, completed history, defs, offered IDs. */
  private buildQuestState(): {
    activeQuests: QuestProgressEntry[];
    completedQuests: CompletedQuestEntry[];
    weeklyCompletions: Record<string, string>;
    questDefinitions: Record<string, QuestDefinition>;
    offeredQuestIds: string[];
    questGiverNpcId: string | undefined;
    availableQuestIds: string[];
    questResolutions: {
      monsters: Record<string, string>;
      items: Record<string, string>;
      tiles: Record<string, { name: string; zoneName: string }>;
    };
  } {
    const allQuests = this.content.getQuestCatalog();

    // Recompute collect progress before exposing state
    this.quests.recomputeCollect(allQuests, (itemId) => this.getInventoryCount(itemId));

    const npc = this.getCurrentNpc();
    const offeredQuestIds = npc?.questIds ?? [];
    const weeklyCompletions = this.quests.getWeeklyCompletions();
    const availableQuestIds = this.getAvailableQuestIds(allQuests, weeklyCompletions);

    const activeProgress = this.quests.getActiveProgress();

    // Build a definitions record containing every quest the player has accepted, completed, or is being offered
    const defs: Record<string, QuestDefinition> = {};
    for (const entry of activeProgress) {
      const def = allQuests[entry.questId];
      if (def) defs[entry.questId] = def;
    }
    for (const c of this.quests.getCompleted()) {
      const def = allQuests[c.questId];
      if (def) defs[c.questId] = def;
    }
    for (const qid of offeredQuestIds) {
      const def = allQuests[qid];
      if (def) defs[qid] = def;
    }

    // Resolve display names for every monster/item/tile referenced by these quests + reward items
    const monsterNames: Record<string, string> = {};
    const itemNames: Record<string, string> = {};
    const tileLookups: Record<string, { name: string; zoneName: string }> = {};
    for (const def of Object.values(defs)) {
      for (const obj of def.objectives) {
        if (obj.kind === 'kill') {
          const m = this.content.getMonster(obj.monsterId);
          if (m) monsterNames[obj.monsterId] = m.name;
        } else if (obj.kind === 'collect') {
          const it = this.content.getItem(obj.itemId);
          if (it) itemNames[obj.itemId] = it.name;
        } else if (obj.kind === 'visit') {
          const tile = this.content.getTileById(obj.tileId);
          if (tile) {
            tileLookups[obj.tileId] = { name: tile.name, zoneName: this.content.getZone(tile.zone)?.displayName ?? tile.zone };
          }
        }
      }
      for (const r of def.rewards) {
        if (r.kind === 'item') {
          const it = this.content.getItem(r.itemId);
          if (it) itemNames[r.itemId] = it.name;
        }
      }
    }

    return {
      activeQuests: activeProgress,
      completedQuests: this.quests.getCompleted(),
      weeklyCompletions,
      questDefinitions: defs,
      offeredQuestIds,
      questGiverNpcId: npc?.id,
      availableQuestIds,
      questResolutions: { monsters: monsterNames, items: itemNames, tiles: tileLookups },
    };
  }

  // --- Quest action handlers (called by PlayerManager) ---

  handleAcceptQuest(questId: string, partySize: number): { success: boolean; error?: string } {
    if (!this.character) return { success: false, error: 'No character.' };
    const npc = this.getCurrentNpc();
    if (!npc || !(npc.questIds ?? []).includes(questId)) {
      return { success: false, error: "That quest isn't offered in this room." };
    }
    const def = this.content.getQuest(questId);
    if (!def) return { success: false, error: 'Quest not found.' };

    const reason = this.quests.accept(def, { playerLevel: this.character.level, partySize });
    if (reason) return { success: false, error: reason };
    this.addLogEntry(`Accepted quest: ${def.name}`, 'battle');
    return { success: true };
  }

  handleTurnInQuest(questId: string): { success: boolean; error?: string } {
    if (!this.character) return { success: false, error: 'No character.' };
    const npc = this.getCurrentNpc();
    if (!npc || !(npc.questIds ?? []).includes(questId)) {
      return { success: false, error: 'Turn this quest in to someone who offers it.' };
    }
    const def = this.content.getQuest(questId);
    if (!def) return { success: false, error: 'Quest not found.' };

    const result = this.quests.turnIn(
      questId,
      this.content.getAllQuests(),
      (itemId, count) => this.removeFromInventory(itemId, count),
      (itemId) => this.getInventoryCount(itemId),
    );
    if (!result.success) return { success: false, error: result.error };

    // Grant rewards
    let totalXp = 0;
    let totalGold = 0;
    const grantedItems: string[] = [];
    for (const reward of result.rewards ?? []) {
      if (reward.kind === 'xp') totalXp += reward.amount;
      else if (reward.kind === 'gold') totalGold += reward.amount;
      else if (reward.kind === 'item') {
        for (let i = 0; i < reward.quantity; i++) {
          if (this.addOneToInventory(reward.itemId)) grantedItems.push(reward.itemId);
        }
      }
    }
    if (totalGold > 0) {
      addGold(this.character, totalGold);
      this.addLogEntry(`+${totalGold} Gold (quest reward)`, 'victory');
    }
    for (const itemId of grantedItems) {
      const itemDef = this.content.getItem(itemId);
      if (itemDef) this.addLogEntry(`Quest reward: ${itemDef.name}`, 'victory');
    }
    if (totalXp > 0) {
      const { levelsGained } = addXp(this.character, totalXp);
      this.xpRateXpTotal += totalXp;
      this.addLogEntry(`+${totalXp} XP (quest reward)`, 'victory');
      this.announceLevelUps(levelsGained);
    }
    this.addLogEntry(`Completed quest: ${def.name}`, 'victory');
    return { success: true };
  }

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type' | 'serverVersion'> {
    const battleState = this.getBattleState?.();
    const partyState = this.getPartyPositionState?.();
    const partyZone = this.getPartyZone?.();

    let charState: ClientCharacterState | null = null;
    if (this.character) {
      const baseMaxHp = calculateMaxHp(this.character.level, this.character.className);
      const setResult = computeActiveSetBonuses(this.character.equipment, this.content.getAllSets(), this.character.className);
      const flatHp = setResult.bonuses.flatHp ?? 0;
      const percentHp = setResult.bonuses.percentHp ?? 0;
      const maxHp = Math.max(1, Math.floor((baseMaxHp + flatHp) * (1 + percentHp / 100)));

      charState = {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        xpForNextLevel: xpForNextLevel(this.character.level),
        maxHp,
        gold: this.character.gold,
        baseDamage: calculateBaseDamage(this.character.level, this.character.className),
        damageType: CLASS_DEFINITIONS[this.character.className].damageType,
        skillLoadout: this.character.skillLoadout,
        grantedSkillIds: this.getGrantedSkillIds(),
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
        xpRate: { startTime: this.xpRateStartTime, totalXp: this.xpRateXpTotal },
        craftLevel: this.character.craftLevel,
        craftXp: this.character.craftXp,
        combatPrefs: { ...this.combatPrefs },
        mastery: this.getMasterySummary(),
      };
    }

    const allZones = this.content.getAllZones();
    const zone = partyZone ? getZone(partyZone, allZones) : null;
    const zoneName = zone ? zone.displayName : (partyZone ?? 'Unknown');

    const setDefs = this.getOwnedSetDefinitions();
    const questBlock = this.buildQuestState();
    const recap = this.pendingRecap ? this.recapBlock(this.pendingRecap) : {};

    return {
      ...recap,
      username: this.username,
      party: partyState ?? { col: 0, row: 0, state: 'idle', path: [] },
      battle: battleState ?? { state: 'battle', visual: 'none', duration: 0 },
      unlocked: this.unlockSystem.getUnlockedKeys(),
      mapSize: this.currentGrid().size,
      currentMapId: this.getMapId(),
      otherPlayers,
      combatLog: this.combatLog.slice(-STATE_LOG_TAIL),
      battleCount: this.battleCount,
      character: charState,
      zone: partyZone ?? '',
      zoneName,
      social: this.getSocialState?.(),
      itemDefinitions: this.getOwnedItemDefinitions(setDefs),
      setDefinitions: setDefs,
      shopDefinition: this.getCurrentShop(),
      henchmanOffers: this.getHenchmanOffers(),
      crafting: this.getCraftingProgress(),
      craftingCatalog: this.getCraftingCatalog(),
      activeQuests: questBlock.activeQuests,
      completedQuests: questBlock.completedQuests,
      weeklyCompletions: questBlock.weeklyCompletions,
      questDefinitions: questBlock.questDefinitions,
      offeredQuestIds: questBlock.offeredQuestIds,
      questGiverNpcId: questBlock.questGiverNpcId,
      availableQuestIds: questBlock.availableQuestIds,
      questResolutions: questBlock.questResolutions,
      dungeon: this.getDungeonState?.() ?? undefined,
    };
  }

  private recapBlock(recap: AwayLedger): Pick<ServerStateMessage, 'awayRecap' | 'awayRecapItemDefinitions'> {
    const defs: Record<string, ItemDefinition> = {};
    const itemIds = [...recap.notableItems.map(n => n.itemId), ...recap.moments.map(m => m.itemId)];
    for (const itemId of itemIds) {
      const def = itemId ? this.content.getItem(itemId) : undefined;
      if (itemId && def) defs[itemId] = def;
    }
    return { awayRecap: recap, awayRecapItemDefinitions: defs };
  }

  // ── Crafting ──────────────────────────────────────

  getCraftingCatalog(): ClientCraftingCatalog | undefined {
    if (!this.character) return undefined;
    const visible = getVisibleRecipes(this.content.getAllRecipes(), this.character.className);

    // Collect every item def referenced by visible recipes (ingredients + results), so the
    // client can show readable names even for items the player doesn't own yet.
    const allItems = this.content.getAllItems();
    const itemDefs: Record<string, ItemDefinition> = {};
    for (const recipe of visible) {
      const resultDef = allItems[recipe.result.itemId];
      if (resultDef) itemDefs[recipe.result.itemId] = resultDef;
      for (const ing of recipe.ingredients) {
        const ingDef = allItems[ing.itemId];
        if (ingDef) itemDefs[ing.itemId] = ingDef;
      }
    }

    return { recipes: visible, itemDefs };
  }

  getCraftingProgress(now: number = Date.now()): ClientCraftingProgress | undefined {
    if (!this.character) return undefined;
    return {
      queue: { activeStartedAtMs: this.craftQueue.activeStartedAtMs, jobs: [...this.craftQueue.jobs] },
      activeProgress: getActiveJobProgress(this.content.getAllRecipes(), this.craftQueue, now),
      skillName: getCraftSkillName(this.character.className),
      skillLevel: this.character.craftLevel,
      skillXp: this.character.craftXp,
      skillXpForNext: xpForCraftLevel(this.character.craftLevel),
    };
  }

  /** Process completed jobs and add results to inventory (with combat log entries). Returns true if anything completed. */
  processCraftCompletions(now: number = Date.now()): boolean {
    if (!this.character) return false;
    if (this.craftQueue.jobs.length === 0) return false;
    const recipes = this.content.getAllRecipes();
    const items = this.content.getAllItems();
    const events = processCompletions(recipes, this.character.inventory, this.craftQueue, now);
    if (events.length === 0) return false;
    let totalCraftXp = 0;
    for (const ev of events) {
      const itemDef = items[ev.resultItemId];
      const itemName = itemDef?.name ?? ev.resultItemId;
      if (ev.quantityProduced > 0) {
        const qtyStr = ev.quantityProduced > 1 ? `x${ev.quantityProduced}` : '';
        this.addLogEntry(`Crafted ${itemName}${qtyStr}.`, 'unlock');
      }
      if (ev.quantityLost > 0) {
        this.addLogEntry(`Crafted ${itemName} but inventory full — lost ${ev.quantityLost}.`, 'damage');
      }
      const recipe = recipes[ev.recipeId];
      if (recipe?.xpReward) totalCraftXp += recipe.xpReward;
    }
    if (totalCraftXp > 0) {
      const skillName = getCraftSkillName(this.character.className);
      const result = addCraftXp(this.character, totalCraftXp);
      if (result.leveledUp) {
        this.addLogEntry(`${skillName} reached level ${this.character.craftLevel}!`, 'levelup');
      }
    }
    return true;
  }

  handleCraftQueue(recipeId: string, now: number = Date.now()): { ok: true } | { ok: false; reason: EnqueueError | 'no_character' | 'unknown_recipe' } {
    if (!this.character) return { ok: false, reason: 'no_character' };
    const recipe = this.content.getRecipe(recipeId);
    if (!recipe) return { ok: false, reason: 'unknown_recipe' };
    // Drain completions first so the queue accurately reflects current state.
    this.processCraftCompletions(now);
    const result = enqueueRecipe(
      recipe,
      this.character.inventory,
      this.craftQueue,
      this.character.className,
      this.character.level,
      now,
    );
    if (!result.ok) return result;
    this.addLogEntry(`Started crafting ${recipe.name}.`, 'battle');
    return { ok: true };
  }

  handleCraftCancel(index: number, now: number = Date.now()): boolean {
    if (!this.character) return false;
    this.processCraftCompletions(now);
    const recipes = this.content.getAllRecipes();
    const job = this.craftQueue.jobs[index];
    const recipe = job ? recipes[job.recipeId] : undefined;
    const ok = cancelJobAt(index, recipes, this.character.inventory, this.craftQueue, now);
    if (ok && recipe) {
      this.addLogEntry(`Cancelled craft: ${recipe.name}.`, 'battle');
    }
    return ok;
  }

  getPosition(): { col: number; row: number } {
    return this.getPartyPosition?.() ?? { col: 0, row: 0 };
  }

  getZone(): string {
    return this.getPartyZone?.() ?? 'hatchetmill';
  }

  // ── Social Accessors ──────────────────────────────────────

  getFriends(): string[] { return this.friends; }
  setFriends(friends: string[]): void { this.friends = friends; }

  getOutgoingFriendRequests(): FriendRequest[] { return this.outgoingFriendRequests; }
  setOutgoingFriendRequests(requests: FriendRequest[]): void { this.outgoingFriendRequests = requests; }

  getBlockedUsers(): Record<string, BlockLevel> { return this.blockedUsers; }
  setBlockedUsers(blocked: Record<string, BlockLevel>): void { this.blockedUsers = blocked; }

  blockUser(username: string, level: BlockLevel): void {
    // Object.fromEntries, not assignment: `blocked['__proto__'] = level` is silently dropped.
    this.blockedUsers = Object.fromEntries([...Object.entries(this.blockedUsers), [username, level]]);
  }

  /** Moves a block onto a blocked player's new name, with the chat history it hides. False when they weren't blocked. */
  moveBlockToNewName(oldUsername: string, newUsername: string): boolean {
    if (!isBlockedUser(oldUsername, this.blockedUsers)) return false;
    this.blockedUsers = Object.fromEntries(
      Object.entries(this.blockedUsers).map(([name, level]): [string, BlockLevel] => [name === oldUsername ? newUsername : name, level]),
    );
    this.chatHistory = this.chatHistory.map(message => withRenamedUser(message, oldUsername, newUsername));
    return true;
  }

  getGuildId(): string | null { return this.guildId; }
  setGuildId(id: string | null): void { this.guildId = id; }

  getPartyId(): string | null { return this.partyId; }
  setPartyId(id: string | null): void { this.partyId = id; }

  getChatSendChannel(): ChatChannelType { return this.chatSendChannel; }
  setChatSendChannel(channel: ChatChannelType): void { this.chatSendChannel = channel; }
  getChatDmTarget(): string { return this.chatDmTarget; }
  setChatDmTarget(target: string): void { this.chatDmTarget = target; }

  /** Mailbox entries from an old save file, to be taken into MailboxSystem once. */
  consumeInitialMailbox(): MailboxEntry[] {
    const m = this.initialMailbox;
    this.initialMailbox = [];
    return m;
  }

  /** Notification inbox snapshot from save data — used once at startup to populate NotificationSystem. */
  consumeInitialNotifications(): NotificationEntry[] {
    const n = this.initialNotifications;
    this.initialNotifications = [];
    return n;
  }

  getNotificationPreferences(): NotificationPreferences { return this.notificationPreferences; }
  setNotificationPreferences(prefs: NotificationPreferences): void { this.notificationPreferences = prefs; }

  getPushSubscriptions(): WebPushSubscription[] { return this.pushSubscriptions; }
  addPushSubscription(sub: WebPushSubscription): void {
    if (this.pushSubscriptions.some(s => s.endpoint === sub.endpoint)) return;
    this.pushSubscriptions.push(sub);
  }
  removePushSubscription(endpoint: string): void {
    this.pushSubscriptions = this.pushSubscriptions.filter(s => s.endpoint !== endpoint);
  }

  getChatFocus(): { channelType: string; channelId: string } | null { return this.chatFocus; }
  setChatFocus(focus: { channelType: string; channelId: string } | null): void { this.chatFocus = focus; }

  /** Store a chat message in this player's personal history. */
  addChatMessage(message: ChatMessage): void {
    this.chatHistory.push(message);
    if (this.chatHistory.length > MAX_CHAT_HISTORY) {
      this.chatHistory = this.chatHistory.slice(-MAX_CHAT_HISTORY);
    }
  }

  /** Get all chat history. */
  getChatHistory(): ChatMessage[] {
    return this.chatHistory;
  }

  /** Get messages since a given message ID. Returns found=false if ID not in history. */
  getMessagesSince(sinceId: string): { messages: ChatMessage[]; found: boolean } {
    const idx = this.chatHistory.findIndex(m => m.id === sinceId);
    if (idx === -1) return { messages: [], found: false };
    return { messages: this.chatHistory.slice(idx + 1), found: true };
  }

  /** Returns the count of an item in the unequipped inventory (0 if not present). */
  getInventoryCount(itemId: string): number {
    if (!this.character) return 0;
    // Own keys only: item ids come from clients, and `constructor` is on every object.
    return Object.prototype.hasOwnProperty.call(this.character.inventory, itemId) ? this.character.inventory[itemId] : 0;
  }

  /** Remove one item from the unequipped inventory. Returns false if item not present. */
  removeOneFromInventory(itemId: string): boolean {
    if (!this.character) return false;
    const current = this.character.inventory[itemId] ?? 0;
    if (current <= 0) return false;
    if (current === 1) {
      delete this.character.inventory[itemId];
    } else {
      this.character.inventory[itemId] = current - 1;
    }
    return true;
  }

  /** Add one item to the unequipped inventory. Returns false if stack is full (MAX_STACK). */
  addOneToInventory(itemId: string): boolean {
    if (!this.character) return false;
    return addItemToInventory(this.character.inventory, itemId);
  }

  /** Remove `quantity` items from the unequipped inventory. Returns false if insufficient. */
  removeFromInventory(itemId: string, quantity: number): boolean {
    if (!this.character) return false;
    const current = this.getInventoryCount(itemId);
    if (current < quantity) return false;
    const newCount = current - quantity;
    if (newCount === 0) {
      delete this.character.inventory[itemId];
    } else {
      this.character.inventory[itemId] = newCount;
    }
    return true;
  }

  /** Add `quantity` items to the unequipped inventory. Returns false if it would exceed MAX_STACK. */
  addToInventory(itemId: string, quantity: number): boolean {
    if (!this.character) return false;
    const current = this.character.inventory[itemId] ?? 0;
    if (current + quantity > MAX_STACK) return false;
    this.character.inventory[itemId] = current + quantity;
    return true;
  }

  getGold(): number { return this.character?.gold ?? 0; }

  /** Deduct gold from the character. Returns false if insufficient gold. */
  deductGold(amount: number): boolean {
    if (!this.character) return false;
    if (this.character.gold < amount) return false;
    this.character.gold -= amount;
    return true;
  }

  /** Add gold to the character. */
  grantGold(amount: number): void {
    if (!this.character) return;
    addGold(this.character, amount);
  }

  /**
   * Grant XP from a non-combat source (e.g. dungeon first-clear bonus). Handles
   * level-ups, skill auto-unlocks, and XP-rate tracking. Pass `logText` to emit
   * a combat-log line for the award.
   */
  grantXp(amount: number, logText?: string): void {
    if (!this.character || amount <= 0) return;
    const { levelsGained } = addXp(this.character, amount);
    this.xpRateXpTotal += amount;
    if (logText) this.addLogEntry(logText, 'victory');
    this.announceLevelUps(levelsGained);
  }

  /** {@link grantXp} for combat and dungeon rewards, which also count toward the away recap. */
  grantRewardXp(amount: number, logText?: string, logType: CombatLogEntry['type'] = 'victory'): void {
    if (!this.character || amount <= 0) return;
    const { levelsGained } = addXp(this.character, amount);
    this.xpRateXpTotal += amount;
    if (logText) this.addLogEntry(logText, logType);
    this.announceLevelUps(levelsGained);
    this.updateAway(l => ({ ...l, xp: l.xp + amount }));
  }

  /** Gold from combat and dungeon rewards; returns what was actually added (capped at MAX_GOLD). */
  grantRewardGold(amount: number): number {
    if (!this.character || amount <= 0) return 0;
    const added = addGold(this.character, amount);
    this.updateAway(l => ({ ...l, gold: l.gold + added }));
    return added;
  }

  /** One dungeon reward item; false when the stack is full (counted as lost in the away recap). */
  grantRewardItem(itemId: string): boolean {
    return this.storeRewardItem(itemId) !== null;
  }

  getLevel(): number { return this.character?.level ?? 0; }

  getClassName(): ClassName | null { return this.character?.className ?? null; }
  getSkillLoadout(): SkillLoadout | null { return this.character?.skillLoadout ?? null; }

  // ── Dungeon clear tracking ──────────────────────────────────────

  /** Whether this player has ever cleared the given dungeon (gates first-clear rewards). */
  hasDungeonCleared(dungeonId: string): boolean { return this.clearedDungeons.has(dungeonId); }

  /** Record a dungeon as cleared by this player. */
  markDungeonCleared(dungeonId: string): void { this.clearedDungeons.add(dungeonId); }

  /** All dungeon IDs this player has cleared (for persistence). */
  getClearedDungeons(): string[] { return [...this.clearedDungeons]; }

  getDungeonCheckpoint(dungeonId: string): DungeonCheckpoint | undefined {
    return hasOwn(this.dungeonCheckpoints, dungeonId) ? copyCheckpoint(this.dungeonCheckpoints[dungeonId]) : undefined;
  }

  getDungeonCheckpoints(): Record<string, DungeonCheckpoint> {
    const copy = emptyCheckpoints();
    for (const [id, checkpoint] of Object.entries(this.dungeonCheckpoints)) copy[id] = copyCheckpoint(checkpoint);
    return copy;
  }

  setDungeonCheckpoint(dungeonId: string, checkpoint: DungeonCheckpoint): void {
    this.dungeonCheckpoints[dungeonId] = copyCheckpoint(checkpoint);
  }

  clearDungeonCheckpoint(dungeonId: string): void {
    delete this.dungeonCheckpoints[dungeonId];
  }

  // ── Kill mastery ──────────────────────────────────────

  getMonsterKills(): Record<string, number> { return { ...this.monsterKills }; }

  /** Credit kills (one entry per monster killed); rank-ups go to the journal and the away recap. */
  recordKills(killed: readonly KilledMonster[]): void {
    const tally = new Map<string, { monster: KilledMonster; count: number }>();
    for (const monster of killed) {
      const seen = tally.get(monster.id);
      if (seen) seen.count++;
      else tally.set(monster.id, { monster, count: 1 });
    }
    for (const { monster, count } of tally.values()) {
      const before = killCount(this.monsterKills, monster.id);
      const after = before + count;
      this.monsterKills[monster.id] = after;
      this.recentKills = [monster.id, ...this.recentKills.filter(id => id !== monster.id)].slice(0, MASTERY_RECENT_COUNT);
      const rankFrom = masteryRank(before, monster.tier);
      const rankTo = masteryRank(after, monster.tier);
      if (rankTo <= rankFrom) continue;
      const bonusPct = Math.round(masteryBonus(rankTo) * 100);
      this.addLogEntry(`Mastery rank ${rankTo}: ${monster.name} (+${bonusPct}% against them).`, 'mastery');
      this.updateAway(l => recordAwayMastery(l, { monsterId: monster.id, name: monster.name, rankFrom, rankTo }));
      if (isMasteryMoment(rankTo, monster.tier)) {
        this.addAwayMoment('mastery', `${monster.name} mastery rank ${rankTo}`, { monsterId: monster.id });
      }
    }
  }

  getMasterySummary(): MasterySummary {
    let discovered = 0;
    let mastered = 0;
    let version = 0;
    for (const [id, kills] of Object.entries(this.monsterKills)) {
      version += kills;
      const def = this.content.getMonster(id);
      if (!def) continue;
      discovered++;
      const tier = effectiveMonsterTier(def);
      if (masteryRank(kills, tier) >= MASTERY_THRESHOLDS[tier].length) mastered++;
    }
    const recentIds = this.recentKills.length > 0
      ? this.recentKills
      : Object.entries(this.monsterKills).sort((a, b) => b[1] - a[1]).slice(0, MASTERY_RECENT_COUNT).map(([id]) => id);
    const recent = recentIds
      .map(id => this.masteryEntry(id))
      .filter((e): e is MasteryEntry => e !== null);
    return { discovered, mastered, version, recent };
  }

  /** Every monster this player has killed that still exists in content, by name. */
  getBestiary(): MasteryEntry[] {
    return Object.keys(this.monsterKills)
      .map(id => this.masteryEntry(id))
      .filter((e): e is MasteryEntry => e !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Levels shown are authored only; a monster without one has no level scaling and shows none. */
  private masteryEntry(monsterId: string): MasteryEntry | null {
    const kills = killCount(this.monsterKills, monsterId);
    const def = this.content.getMonster(monsterId);
    if (!def || kills <= 0) return null;
    const info: MasteryMonsterInfo = { name: def.name, tier: effectiveMonsterTier(def) };
    if (isAuthoredMonsterLevel(def.level)) info.level = clampMonsterLevel(def.level);
    return buildMasteryEntry(monsterId, kills, info);
  }

  private monsterTier(monsterId: string): MonsterTier | undefined {
    const def = this.content.getMonster(monsterId);
    return def ? effectiveMonsterTier(def) : undefined;
  }

  // ── Combat preferences ──────────────────────────────────────

  getCombatPrefs(): CombatPrefs { return { ...this.combatPrefs }; }

  /** True only the first time auto-retreat acts for this player (the one-time explanation). */
  noteAutoRetreat(): boolean {
    if (this.autoRetreatNotified) return false;
    this.autoRetreatNotified = true;
    return true;
  }

  /** Returns whether anything changed. */
  setCombatPrefs(prefs: CombatPrefs): boolean {
    const next = sanitizeCombatPrefs(prefs);
    const changed = next.autoRetreatBelowPct !== this.combatPrefs.autoRetreatBelowPct;
    this.combatPrefs = next;
    return changed;
  }

  // ── While you were away ──────────────────────────────────────

  isAway(): boolean { return this.awayLedger !== null; }

  getAwayLedger(): AwayLedger | null { return this.awayLedger; }

  getPendingRecap(): AwayLedger | null { return this.pendingRecap; }

  /** Open a ledger unless one is already open. Characterless players have nothing to recap. */
  beginAway(now: number = Date.now()): void {
    if (this.awayLedger || !this.character) return;
    this.awayLedger = createAwayLedger(randomUUID(), now, this.awayProgress());
  }

  /**
   * Close the open ledger. A long enough absence with something in it becomes (or folds into) the
   * pending recap; anything else is dropped. Returns whether the pending recap changed.
   */
  endAway(now: number = Date.now()): boolean {
    const ledger = this.awayLedger;
    if (!ledger) return false;
    this.awayLedger = null;
    if (!isAwayLedgerWorthRecap(ledger, now)) return false;
    const closed = closeAwayLedger(ledger, now, this.awayProgress());
    // A fresh id, so an ack for the recap the client already showed can't clear what was merged in.
    this.pendingRecap = this.pendingRecap ? { ...mergeAwayLedgers(this.pendingRecap, closed), id: closed.id } : closed;
    return true;
  }

  /** Clears the pending recap when `id` matches it. */
  ackRecap(id: string): boolean {
    if (!this.pendingRecap || this.pendingRecap.id !== id) return false;
    this.pendingRecap = null;
    return true;
  }

  /** Apply a recap update while a ledger is open; a no-op otherwise. */
  recordAway(update: (ledger: AwayLedger) => AwayLedger): void {
    this.updateAway(update);
  }

  addAwayMoment(kind: AwayMomentKind, text: string, refs: { monsterId?: string; itemId?: string } = {}): void {
    this.updateAway(l => addAwayMoment(l, { at: Date.now(), kind, text, ...refs }));
  }

  /** Recap hook for auto-retreat: every retreat counts; a relocation is also a moment. */
  recordRetreat(retreat: AwayRetreatEntry): void {
    this.updateAway(l => recordAwayRetreat(l, retreat));
    if (retreat.kind === 'relocate') {
      const to = retreat.to ? ` to ${retreat.to}` : '';
      this.addAwayMoment('relocate', `Retreated from ${retreat.from}${to} (win chance ${Math.round(retreat.winPct)}%)`);
    }
  }

  recordRouteStopped(where: string): void {
    this.updateAway(l => recordAwayRouteStopped(l, Date.now(), where));
  }

  /** Keeps the lowest-HP victory; a new low at or below CLOSE_CALL_MOMENT_PCT is also a moment. */
  recordCloseCall(call: AwayCloseCall): void {
    const ledger = this.awayLedger;
    if (!ledger) return;
    const previous = ledger.closestCall?.hpPct;
    this.awayLedger = recordAwayCloseCall(ledger, call);
    if (call.hpPct <= CLOSE_CALL_MOMENT_PCT && (previous === undefined || call.hpPct < previous)) {
      this.addAwayMoment('closest_call', `Won with ${call.hpPct}% health left against ${call.vs}`);
    }
  }

  private updateAway(update: (ledger: AwayLedger) => AwayLedger): void {
    if (this.awayLedger) this.awayLedger = update(this.awayLedger);
  }

  private awayProgress(): { level: number; xpFrac: number } {
    if (!this.character) return { level: 0, xpFrac: 0 };
    const need = xpForNextLevel(this.character.level);
    return { level: this.character.level, xpFrac: need > 0 ? Math.min(1, Math.max(0, this.character.xp / need)) : 0 };
  }

  /** Returns publicly visible profile data (no HP, damage, gold, inventory). */
  getPublicProfile(): { className: string; level: number; equipment: Record<string, string | null>; skillLoadout: SkillLoadout } | null {
    if (!this.character) return null;
    return {
      className: this.character.className,
      level: this.character.level,
      equipment: { ...this.character.equipment },
      skillLoadout: {
        unlockedSkills: this.character.skillLoadout.unlockedSkills,
        equippedSkills: [...this.character.skillLoadout.equippedSkills],
      },
    };
  }

  /** Set class for a new character. Only works if no character exists yet. */
  setClass(className: ClassName): boolean {
    if (this.character !== null) return false;
    this.character = createCharacter(className, this.skillContent());
    return true;
  }

  /** Admin: force-change class, keeping level, XP, gold, and inventory. Unequips all gear. */
  forceSetClass(className: ClassName): void {
    if (!this.character) {
      // Admin creating a character for a player who hasn't chosen yet
      this.character = createCharacter(className, this.skillContent());
      this.autoUnlockSkills();
      this.addLogEntry(`Class set to ${className}!`, 'battle');
      return;
    }
    // Unequip all gear back to inventory (skip offhand if same as mainhand — 2H weapon)
    for (const slot of EQUIP_SLOTS) {
      const itemId = this.character.equipment[slot];
      if (itemId) {
        const skip = slot === 'offhand' && itemId === this.character.equipment.mainhand;
        if (!skip) {
          this.character.inventory[itemId] = (this.character.inventory[itemId] ?? 0) + 1;
        }
        this.character.equipment[slot] = null;
      }
    }
    this.character.className = className;
    this.character.skillLoadout = createDefaultSkillLoadout(className, this.skillContent());
    this.autoUnlockSkills();
    this.addLogEntry(`Class changed to ${className}!`, 'battle');
  }

  // ── Skill System ──────────────────────────────────────

  /** Live skill content (definitions + per-class slot schedules) from the content store. */
  private skillContent(): SkillContent {
    return {
      skills: this.content.getAllSkills(),
      slotSchedules: this.content.getAllSkillSlotSchedules(),
    };
  }

  /** Skill IDs granted by currently equipped items/sets. Grants gate availability only. */
  getGrantedSkillIds(): string[] {
    if (!this.character) return [];
    return computeGrantedSkillIds(
      this.character.equipment,
      this.content.getAllItems(),
      this.content.getAllSets(),
      this.character.className,
    );
  }

  /**
   * Auto-unlock all skills the player qualifies for based on level, then
   * reconcile the equipped loadout against current content (schedule length,
   * removed/edited skills, lost grants).
   */
  autoUnlockSkills(): void {
    if (!this.character) return;
    const skillContent = this.skillContent();
    this.character.skillLoadout.unlockedSkills = getUnlockedSkillsForLevel(this.character.className, this.character.level, skillContent);
    this.character.skillLoadout = reconcileSkillLoadout(
      this.character.skillLoadout,
      this.character.className,
      this.character.level,
      this.getGrantedSkillIds(),
      skillContent,
    );
  }

  handleEquipSkill(skillId: string, slotIndex: number): boolean {
    if (!this.character) return false;
    const result = equipSkillInSlot(
      skillId,
      slotIndex,
      this.character.className,
      this.character.level,
      this.character.skillLoadout,
      this.getGrantedSkillIds(),
      this.skillContent(),
    );
    if (!result) return false;
    this.character.skillLoadout.equippedSkills = result;
    return true;
  }

  handleUnequipSkill(slotIndex: number): boolean {
    if (!this.character) return false;
    const newEquipped = unequipSkillFromSlot(slotIndex, this.character.skillLoadout.equippedSkills);
    this.character.skillLoadout.equippedSkills = newEquipped;
    return true;
  }

  /** Replace the priority list. Every id must be the player's own attack skill or an action skill they own; empty resets it. */
  handleSetActionOrder(actionOrder: unknown): boolean {
    if (!this.character) return false;
    if (!Array.isArray(actionOrder) || actionOrder.length > MAX_ACTION_ORDER_LENGTH) return false;
    if (!actionOrder.every((id): id is string => typeof id === 'string')) return false;
    if (new Set(actionOrder).size !== actionOrder.length) return false;

    const { className, skillLoadout } = this.character;
    const granted = this.getGrantedSkillIds();
    const owned = (id: string): boolean => {
      const skill = this.content.getSkill(id);
      if (!skill) return false;
      if (skill.type === 'attack') return skill.id === findAttackSkill(className, this.content.getAllSkills())?.id;
      return isActionSkill(skill) && ((skill.className === className && skillLoadout.unlockedSkills.includes(id)) || granted.includes(id));
    };
    if (!actionOrder.every(owned)) return false;

    if (actionOrder.length > 0) skillLoadout.actionOrder = actionOrder;
    else delete skillLoadout.actionOrder;
    return true;
  }

  addLogEntry(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ id: ++this.logIdCounter, text, type });
    if (this.combatLog.length > MAX_LOG_ENTRIES) {
      this.combatLog.shift();
    }
  }

  /** The newest journal entry of this type (the journal survives restarts). */
  lastLogEntryOfType(type: CombatLogEntry['type']): CombatLogEntry | undefined {
    for (let i = this.combatLog.length - 1; i >= 0; i--) {
      if (this.combatLog[i].type === type) return this.combatLog[i];
    }
    return undefined;
  }

  /** Force-unlock a tile and its adjacent tiles (for relocation after deploy). */
  forceUnlockTileArea(tile: HexTile): void {
    this.unlockSystem.forceUnlock(tile);
    const neighbors = this.currentGrid().getTraversableNeighbors(tile.coord);
    for (const neighbor of neighbors) {
      this.unlockSystem.forceUnlock(neighbor);
    }
  }

  /**
   * Master reset: reset character to level 1 with 0 XP (keeping class),
   * clear inventory/equipment, move to start tile, reset unlocks and combat log.
   */
  resetForMasterReset(startTile: HexTile): void {
    if (this.character) {
      this.character = createCharacter(this.character.className, this.skillContent());
    }

    this.battleCount = 0;
    this.combatLog = [];
    this.logIdCounter = 0;
    // Master reset returns everyone to the default map's start tile.
    this.unlockSystem = new UnlockSystem(this.defaultGrid(), startTile);
    this.partyId = null;
    this.clearedDungeons.clear();
    this.dungeonCheckpoints = emptyCheckpoints();
    this.monsterKills = emptyKillCounts();
    this.recentKills = [];
    this.awayLedger = null;
    this.pendingRecap = null;

    this.addLogEntry('The world has been reset! Starting fresh...', 'battle');
  }

  getStartingTile(): HexTile {
    const startPos = this.content.getStartTile();
    const startCoord = offsetToCube(startPos);
    const tile = this.defaultGrid().getTile(startCoord);
    if (!tile) throw new Error('Invalid starting position');
    return tile;
  }

  getUnlockedKeys(): string[] {
    return this.unlockSystem.getUnlockedKeys();
  }

  toSaveData(movementData?: {
    position: { col: number; row: number };
    mapId: string;
    target: { col: number; row: number } | null;
    movementQueue: { col: number; row: number }[];
  }, partyInfo?: {
    role: 'owner' | 'leader' | 'member';
    gridPosition: number;
  }, dungeonRun?: DungeonRunState | null, partyHenchmen?: HiredHenchman[]): PlayerSaveData {
    const pos = movementData?.position ?? this.getPosition();

    return {
      username: this.username,
      battleCount: this.battleCount,
      combatLog: this.combatLog.slice(-MAX_SAVE_LOG_ENTRIES),
      unlockedKeys: this.unlockSystem.getUnlockedKeys(),
      position: { col: pos.col, row: pos.row },
      mapId: movementData?.mapId ?? this.getMapId(),
      target: movementData?.target ?? null,
      movementQueue: movementData?.movementQueue ?? [],
      character: this.character ? {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        gold: this.character.gold,
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
        skillLoadout: { ...this.character.skillLoadout },
        craftLevel: this.character.craftLevel,
        craftXp: this.character.craftXp,
      } : undefined,
      friends: [...this.friends],
      outgoingFriendRequests: [...this.outgoingFriendRequests],
      blockedUsers: { ...this.blockedUsers },
      guildId: this.guildId,
      partyId: this.partyId,
      partyRole: partyInfo?.role,
      partyGridPosition: partyInfo?.gridPosition,
      chatHistory: this.chatHistory.slice(-MAX_CHAT_HISTORY),
      chatSendChannel: this.chatSendChannel,
      chatDmTarget: this.chatDmTarget,
      craftQueue: { activeStartedAtMs: this.craftQueue.activeStartedAtMs, jobs: [...this.craftQueue.jobs] },
      activeQuests: this.quests.toSaveData().active,
      completedQuests: this.quests.toSaveData().completed,
      weeklyCompletions: this.quests.toSaveData().weeklyCompletions,
      dungeonRun: dungeonRun ?? undefined,
      partyHenchmen: partyHenchmen?.length ? partyHenchmen : undefined,
      clearedDungeons: [...this.clearedDungeons],
      dungeonCheckpoints: this.getDungeonCheckpoints(),
      monsterKills: { ...this.monsterKills },
      combatPrefs: { ...this.combatPrefs },
      autoRetreatNotified: this.autoRetreatNotified || undefined,
      awayLedger: this.awayLedger,
      pendingRecap: this.pendingRecap,
      notifications: this.getNotifications ? this.getNotifications() : this.initialNotifications,
      notificationPreferences: this.notificationPreferences,
      pushSubscriptions: [...this.pushSubscriptions],
    };
  }

  /**
   * Restore a PlayerSession from saved data.
   * Battle timer is NOT started here — PartyBattleManager handles that.
   */
  static fromSaveData(
    data: PlayerSaveData,
    grids: WorldGrids,
    content: ContentStore,
    onQuestEvent?: (event: QuestEvent) => void,
  ): PlayerSession {
    // Build session via Object.create to bypass constructor
    const session = Object.create(PlayerSession.prototype) as PlayerSession;
    (session as { username: string }).username = data.username;
    session['grids'] = grids;
    session['content'] = content;
    // Resolve the grid for the saved map (legacy saves → default map) for unlock seeding.
    const grid = grids.get(data.mapId ?? content.getWorld().defaultMapId) ?? grids.getOrThrow(content.getWorld().defaultMapId);
    session['battleCount'] = data.battleCount;
    session.quests = new QuestSystem(data.username, onQuestEvent);
    session.quests.loadFromSaveData({
      active: data.activeQuests ?? [],
      completed: data.completedQuests ?? [],
      weeklyCompletions: data.weeklyCompletions ?? {},
    });
    // Migrate old log entries without IDs and restore the counter
    const restoredLog = data.combatLog.slice(-MAX_LOG_ENTRIES);
    let maxId = 0;
    for (const entry of restoredLog) {
      if (!entry.id) entry.id = ++maxId;
      else if (entry.id > maxId) maxId = entry.id;
    }
    session['combatLog'] = restoredLog;
    session['logIdCounter'] = maxId;
    // Migrate old cube-key-based unlocks ("q,r,s") to tile GUIDs
    let unlockedKeys = data.unlockedKeys;
    if (unlockedKeys.length > 0 && unlockedKeys[0].split(',').length === 3) {
      // Old format: cube coordinate keys — map to tile GUIDs via grid lookup
      const migrated: string[] = [];
      for (const cubeKey of unlockedKeys) {
        const tile = grid.getTileByKey(cubeKey);
        if (tile) migrated.push(tile.id);
      }
      unlockedKeys = migrated;
    }
    session['unlockSystem'] = UnlockSystem.fromKeys(grid, unlockedKeys);

    // Restore character — null if class is invalid/legacy (forces class selection)
    const savedClassName = data.character?.className;
    const isValidClass = savedClassName && ALL_CLASS_NAMES.includes(savedClassName as ClassName);

    if (data.character && isValidClass) {
      const className = savedClassName as ClassName;

      // Migrate skill loadout from old saves. Content is loaded before session
      // restore (GameLoop.init), so the store-backed skill content is available.
      const skillLoadout: SkillLoadout = data.character.skillLoadout
        ? { ...data.character.skillLoadout, equippedSkills: [...data.character.skillLoadout.equippedSkills] }
        : createDefaultSkillLoadout(className, {
            skills: content.getAllSkills(),
            slotSchedules: content.getAllSkillSlotSchedules(),
          });

      session['character'] = {
        className,
        level: data.character.level,
        xp: data.character.xp,
        gold: data.character.gold ?? 0,
        inventory: data.character.inventory ? { ...data.character.inventory } : {},
        equipment: data.character.equipment
          ? { ...data.character.equipment }
          : { head: null, shoulders: null, chest: null, bracers: null, gloves: null, mainhand: null, offhand: null, foot: null, ring: null, necklace: null, back: null, relic: null },
        skillLoadout,
        craftLevel: data.character.craftLevel ?? 1,
        craftXp: data.character.craftXp ?? 0,
      };
    } else {
      // Invalid or legacy class — no character (will force class selection on login)
      session['character'] = null;
    }

    // Auto-unlock skills for current level and reconcile the equipped loadout
    // against current content — pads/truncates to the class schedule (replaces
    // the old pad-to-5 migration) and drops removed or no-longer-available skills.
    if (session['character']) {
      session.autoUnlockSkills();
    }

    // Restore social state
    session['friends'] = data.friends ? [...data.friends] : [];
    session['outgoingFriendRequests'] = data.outgoingFriendRequests ? [...data.outgoingFriendRequests] : [];
    session['blockedUsers'] = data.blockedUsers ? { ...data.blockedUsers } : {};
    session['guildId'] = data.guildId ?? null;
    session['partyId'] = null; // Parties are transient, not restored across restarts
    session['clearedDungeons'] = new Set(data.clearedDungeons ?? []);
    session['dungeonCheckpoints'] = sanitizeCheckpoints(data.dungeonCheckpoints);
    session['monsterKills'] = sanitizeKillCounts(data.monsterKills);
    session['recentKills'] = [];
    session['combatPrefs'] = sanitizeCombatPrefs(data.combatPrefs);
    session['autoRetreatNotified'] = data.autoRetreatNotified === true;
    const level = data.character?.level ?? 0;
    session['awayLedger'] = sanitizeLedger(data.awayLedger, level);
    session['pendingRecap'] = sanitizeLedger(data.pendingRecap, level);
    session['chatHistory'] = data.chatHistory ? [...data.chatHistory] : [];
    session['chatSendChannel'] = (data.chatSendChannel as ChatChannelType) ?? 'zone';
    session['chatDmTarget'] = data.chatDmTarget ?? '';
    session['initialMailbox'] = data.mailbox ? [...data.mailbox] : [];
    session['initialNotifications'] = data.notifications ? [...data.notifications] : [];
    session['notificationPreferences'] = data.notificationPreferences ?? emptyNotificationPreferences();
    session['pushSubscriptions'] = data.pushSubscriptions ? [...data.pushSubscriptions] : [];
    session['chatFocus'] = null;

    // Restore craft queue (lazy completion happens on next tick)
    session['craftQueue'] = data.craftQueue
      ? { activeStartedAtMs: data.craftQueue.activeStartedAtMs, jobs: [...data.craftQueue.jobs] }
      : emptyCraftQueue();

    // XP rate tracking — auto-start from session restore time
    session['xpRateStartTime'] = Date.now();
    session['xpRateXpTotal'] = 0;

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    if (!this.character) return false;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId, this.content.getAllItems(), this.character.className);
    if (result.success) this.reconcileLoadoutAfterEquipmentChange();
    return result.success;
  }

  /** Re-validate the equipped skill loadout after an equipment change — a lost grant must null its slot. */
  private reconcileLoadoutAfterEquipmentChange(): void {
    if (!this.character) return;
    this.character.skillLoadout = reconcileSkillLoadout(
      this.character.skillLoadout,
      this.character.className,
      this.character.level,
      this.getGrantedSkillIds(),
      this.skillContent(),
    );
  }

  /** Check if the player has a specific item equipped in any slot. */
  hasItemEquipped(itemId: string): boolean {
    if (!this.character) return false;
    return inventoryHasItemEquipped(itemId, this.character.equipment);
  }

  /** Every item ID currently equipped — used to evaluate room entry gates. */
  getEquippedItemIds(): Set<string> {
    if (!this.character) return new Set();
    return getEquippedItemIds(this.character.equipment);
  }

  /** Get item IDs locked by the current tile and remaining path (required for traversal). */
  getLockedItemIds(): string[] {
    const locked = new Set<string>();
    const tile = this.getCurrentTile?.();
    if (tile?.requiredItemId) locked.add(tile.requiredItemId);
    const path = this.getCurrentPath?.() ?? [];
    for (const t of path) {
      if (t.requiredItemId) locked.add(t.requiredItemId);
    }
    return [...locked];
  }

  handleUnequipItem(slot: EquipSlot): { success: boolean; lockedByTile?: boolean } {
    if (!this.character) return { success: false };
    if (!EQUIP_SLOTS.includes(slot)) return { success: false };

    // Check if the equipped item in this slot is locked by tile traversal
    const equippedInSlot = this.character.equipment[slot];
    if (equippedInSlot) {
      const lockedIds = this.getLockedItemIds();
      if (lockedIds.includes(equippedInSlot)) return { success: false, lockedByTile: true };
    }

    const result = unequipItem(this.character.inventory, this.character.equipment, slot, this.content.getAllItems());
    if (result.success) this.reconcileLoadoutAfterEquipmentChange();
    return { success: result.success };
  }

  /** Check why equip failed — returns the blocking item info if inventory full. */
  getEquipBlockInfo(itemId: string): { blockedByItemId: string; blockedBySlot: EquipSlot } | null {
    if (!this.character) return null;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return null;

    const slot = def.equipSlot;

    const is2H = slot === 'twohanded';

    // If a 2H weapon is equipped and we're touching mainhand/offhand/twohanded, check that
    if ((slot === 'mainhand' || slot === 'offhand' || is2H) && isTwoHandedEquipped(this.character.equipment, this.content.getAllItems())) {
      const twoHandId = this.character.equipment.mainhand!;
      const current = this.character.inventory[twoHandId] ?? 0;
      if (current >= 99) {
        return { blockedByItemId: twoHandId, blockedBySlot: 'mainhand' };
      }
      return null;
    }

    // If equipping a 2H weapon, also check offhand stack
    if (is2H) {
      const offhandItem = this.character.equipment.offhand;
      if (offhandItem && (this.character.inventory[offhandItem] ?? 0) >= 99) {
        return { blockedByItemId: offhandItem, blockedBySlot: 'offhand' };
      }
      const mainhandItem = this.character.equipment.mainhand;
      if (mainhandItem && (this.character.inventory[mainhandItem] ?? 0) >= 99) {
        return { blockedByItemId: mainhandItem, blockedBySlot: 'mainhand' };
      }
    }

    // For twohanded items, check mainhand slot (since that's where it maps in the equipment record)
    const effectiveSlot = is2H ? 'mainhand' : slot;
    const currentEquipped = this.character.equipment[effectiveSlot];
    if (!currentEquipped) return null;

    // Check if the old item's stack is at max
    const current = this.character.inventory[currentEquipped] ?? 0;
    if (current >= 99) {
      return { blockedByItemId: currentEquipped, blockedBySlot: slot };
    }
    return null;
  }

  handleEquipItemForceDestroy(itemId: string): boolean {
    if (!this.character) return false;
    const def = this.content.getItem(itemId);
    if (!def || !def.equipSlot) return false;

    const result = equipItemForceDestroy(
      this.character.inventory, this.character.equipment, itemId, this.content.getAllItems(), this.character.className
    );
    if (result.success) this.reconcileLoadoutAfterEquipmentChange();
    return result.success;
  }

  handleDestroyItems(itemId: string, count: number): boolean {
    if (!this.character) return false;
    const result = destroyItems(this.character.inventory, itemId, count);
    return result.success;
  }

}

function copyCheckpoint(checkpoint: DungeonCheckpoint): DungeonCheckpoint {
  return { ...checkpoint, rewardedPhases: [...checkpoint.rewardedPhases] };
}

/** Copies rather than mutates: every recipient's history holds the same message object. */
function withRenamedUser(message: ChatMessage, oldUsername: string, newUsername: string): ChatMessage {
  const isSender = message.senderUsername === oldUsername;
  const isDmPartner = message.channelType === 'dm' && message.channelId === oldUsername;
  if (!isSender && !isDmPartner) return message;
  return {
    ...message,
    senderUsername: isSender ? newUsername : message.senderUsername,
    channelId: isDmPartner ? newUsername : message.channelId,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Keyed by free-form monster ids, so it must not inherit keys such as `constructor`. */
function emptyKillCounts(): Record<string, number> {
  return Object.create(null) as Record<string, number>;
}

function killCount(kills: Record<string, number>, monsterId: string): number {
  return hasOwn(kills, monsterId) ? kills[monsterId] : 0;
}

function sanitizeKillCounts(raw: unknown): Record<string, number> {
  const kills = emptyKillCounts();
  if (!isRecord(raw)) return kills;
  for (const [id, count] of Object.entries(raw)) {
    if (isNonNegativeInteger(count) && count > 0) kills[id] = count;
  }
  return kills;
}

/** Keyed by free-form dungeon ids, like the kill counts. */
function emptyCheckpoints(): Record<string, DungeonCheckpoint> {
  return Object.create(null) as Record<string, DungeonCheckpoint>;
}

function sanitizeCheckpoints(raw: unknown): Record<string, DungeonCheckpoint> {
  const checkpoints = emptyCheckpoints();
  if (!isRecord(raw)) return checkpoints;
  for (const [dungeonId, value] of Object.entries(raw)) {
    if (!isRecord(value) || !isNonNegativeInteger(value.floorIndex) || typeof value.at !== 'number' || !Number.isFinite(value.at)) continue;
    checkpoints[dungeonId] = {
      floorIndex: value.floorIndex,
      phase: isNonNegativeInteger(value.phase) ? value.phase : 0,
      wipes: isNonNegativeInteger(value.wipes) ? value.wipes : 0,
      rewardedPhases: Array.isArray(value.rewardedPhases) ? value.rewardedPhases.filter((k): k is string => typeof k === 'string') : [],
      at: value.at,
    };
  }
  return checkpoints;
}

const AWAY_DUNGEON_OUTCOMES: readonly AwayDungeonOutcome[] = ['cleared', 'ejected', 'left', 'in_progress'];

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function count(value: unknown): number {
  return isFiniteNumber(value) && value > 0 ? value : 0;
}

function clamp(value: unknown, max: number): number {
  return isFiniteNumber(value) ? Math.min(max, Math.max(0, value)) : 0;
}

function recordsOf<T>(raw: unknown, parse: (value: Record<string, unknown>) => T | null): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap(value => {
    const parsed = isRecord(value) ? parse(value) : null;
    return parsed ? [parsed] : [];
  });
}

function sanitizeRarity(value: unknown): ItemRarity | undefined {
  return typeof value === 'string' && awayRarityRank(value as ItemRarity) >= 0 ? value as ItemRarity : undefined;
}

function sanitizeNotable(v: Record<string, unknown>): AwayNotableItem | null {
  if (typeof v.itemId !== 'string' || count(v.count) <= 0) return null;
  const item: AwayNotableItem = { itemId: v.itemId, count: count(v.count) };
  const rarity = sanitizeRarity(v.rarity);
  if (rarity) item.rarity = rarity;
  return item;
}

function sanitizeMasteryUp(v: Record<string, unknown>): AwayMasteryUp | null {
  if (typeof v.monsterId !== 'string' || typeof v.name !== 'string') return null;
  return { monsterId: v.monsterId, name: v.name, rankFrom: count(v.rankFrom), rankTo: count(v.rankTo) };
}

function sanitizeDungeonEntry(v: Record<string, unknown>): AwayDungeonEntry | null {
  const outcome = AWAY_DUNGEON_OUTCOMES.find(o => o === v.outcome);
  if (typeof v.dungeonId !== 'string' || typeof v.name !== 'string' || !outcome) return null;
  const entry: AwayDungeonEntry = { dungeonId: v.dungeonId, name: v.name, outcome, wipes: count(v.wipes) };
  if (count(v.checkpoint) > 0) entry.checkpoint = count(v.checkpoint);
  return entry;
}

function sanitizeRetreatEntry(v: Record<string, unknown>): AwayRetreatEntry | null {
  const kind = v.kind === 'skip' || v.kind === 'relocate' ? v.kind : null;
  if (!isFiniteNumber(v.at) || !kind || typeof v.from !== 'string') return null;
  const entry: AwayRetreatEntry = { at: v.at, kind, from: v.from, winPct: clamp(v.winPct, 100) };
  if (typeof v.to === 'string') entry.to = v.to;
  return entry;
}

function sanitizeMoment(v: Record<string, unknown>): AwayMoment | null {
  const kind = typeof v.kind === 'string' && hasOwn(AWAY_MOMENT_PRIORITY, v.kind) ? v.kind as AwayMomentKind : null;
  if (!isFiniteNumber(v.at) || !kind || typeof v.text !== 'string') return null;
  const moment: AwayMoment = { at: v.at, kind, text: v.text };
  if (typeof v.monsterId === 'string') moment.monsterId = v.monsterId;
  if (typeof v.itemId === 'string') moment.itemId = v.itemId;
  return moment;
}

/** Rebuilt field by field: a malformed save must not reach the recap code, which trusts every field. */
function sanitizeLedger(raw: unknown, level: number): AwayLedger | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || !isFiniteNumber(raw.since)) return null;
  const items: Partial<Record<ItemRarity, number>> = {};
  if (isRecord(raw.items)) {
    for (const [key, n] of Object.entries(raw.items)) {
      const rarity = sanitizeRarity(key);
      if (rarity && count(n) > 0) items[rarity] = count(n);
    }
  }
  const notableItems = recordsOf(raw.notableItems, sanitizeNotable).slice(0, AWAY_MAX_NOTABLE_ITEMS);
  const masteryUps = recordsOf(raw.masteryUps, sanitizeMasteryUp);
  const dungeons = recordsOf(raw.dungeons, sanitizeDungeonEntry).slice(-AWAY_MAX_DUNGEONS);
  const retreatLog = recordsOf(raw.retreatLog, sanitizeRetreatEntry).slice(-AWAY_MAX_RETREATS);
  const moments = recordsOf(raw.moments, sanitizeMoment).slice(-AWAY_MAX_MOMENTS);

  const ledger: AwayLedger = {
    id: raw.id,
    since: raw.since,
    battles: count(raw.battles),
    wins: count(raw.wins),
    losses: count(raw.losses),
    retreats: count(raw.retreats),
    skips: count(raw.skips),
    xp: count(raw.xp),
    gold: count(raw.gold),
    levelFrom: isFiniteNumber(raw.levelFrom) && raw.levelFrom >= 0 ? raw.levelFrom : level,
    levelTo: isFiniteNumber(raw.levelTo) && raw.levelTo >= 0 ? raw.levelTo : level,
    xpFracFrom: clamp(raw.xpFracFrom, 1),
    xpFracTo: clamp(raw.xpFracTo, 1),
    items,
    notableItems,
    itemsLost: count(raw.itemsLost),
    kills: count(raw.kills),
    masteryUps,
    dungeons,
    retreatLog,
    moments,
  };
  if (isFiniteNumber(raw.until)) ledger.until = raw.until;
  const stopped = raw.routeStopped;
  if (isRecord(stopped) && isFiniteNumber(stopped.at) && typeof stopped.where === 'string') {
    ledger.routeStopped = { at: stopped.at, where: stopped.where };
  }
  const call = raw.closestCall;
  if (isRecord(call) && isFiniteNumber(call.hpPct) && typeof call.vs === 'string' && typeof call.where === 'string') {
    ledger.closestCall = { hpPct: call.hpPct, vs: call.vs, where: call.where };
  }
  return ledger;
}
