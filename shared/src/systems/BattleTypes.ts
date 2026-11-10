import type { EquipSlot, ItemDefinition } from './ItemTypes.js';
import type { SetDefinition } from './SetTypes.js';
import type { ShopDefinition } from './ShopTypes.js';
import type { HenchmanOffer } from './HenchmanTypes.js';
import type { RecipeDefinition, CraftQueueState, ActiveJobProgress } from './CraftingTypes.js';
import type { ClientCombatSnapshot, CombatEvent } from './CombatEvents.js';
import type {
  ClientSocialState,
  ClientSocialMessage,
  PlayerListEntry,
  ServerSocialStateMessage,
  ServerChatMessageMessage,
  ServerSyncChatMessage,
  ServerTradeProposedMessage,
  ServerTradeCancelledMessage,
  ServerTradeCompletedMessage,
} from './SocialTypes.js';
import type { SkillLoadout } from './SkillTypes.js';
import type { DungeonRunInfo } from './DungeonTypes.js';
import type { ClientNotificationMessage, ServerNotificationMessage } from './NotificationTypes.js';
import type { RoomEntryFailureKind } from './RoomRequirements.js';
import type { CombatPrefs, ForecastRequestTarget, ForecastResult, ForecastStatus, ForecastTarget } from './ForecastTypes.js';
import type { MasteryEntry, MasterySummary } from './Mastery.js';
import type { AwayLedger } from './AwayTypes.js';


export type BattleTimerState = 'battle' | 'result';
export type BattleResult = 'victory' | 'defeat';
export type PartyState = 'idle' | 'moving' | 'in_battle';

export const RESULT_PAUSE = 600;      // ms to show victory/defeat before movement
export const MOVE_DURATION = 400;     // ms for tile movement (client animation)
export const WIPE_WAIT_MS = 60_000;   // ms before a party's next fight after a wipe in a room
export const GAME_VERSION = '2026.11.09.3'; // Keep in sync with PATCH_NOTES in client

// --- Protocol types (server → client, client → server) ---

export type BattleVisual = 'none' | 'fighting' | 'victory' | 'defeat' | 'retreat';

export interface ServerPartyState {
  col: number;
  row: number;
  state: PartyState;
  targetCol?: number;
  targetRow?: number;
  path: { col: number; row: number }[];
}

export interface ServerBattleState {
  state: BattleTimerState;
  result?: BattleResult;
  visual: BattleVisual;
  duration: number;
  /** Time left before the next fight, while no fight is live. */
  regroupMs?: number;
  /** Always a full snapshot. */
  combat?: ClientCombatSnapshot;
}

/** Live combat stream: events and log lines since the last message, plus an optional snapshot. */
export interface ServerCombatMessage {
  type: 'combat';
  battleId: number;
  snapshot?: ClientCombatSnapshot;
  events: CombatEvent[];
  log: string[];
}

/** Tells the server whether this socket currently shows the combat view. */
export interface ClientCombatViewMessage {
  type: 'combat_view';
  visible: boolean;
}

export interface ClientCharacterState {
  className: string;
  level: number;
  xp: number;
  xpForNextLevel: number;
  maxHp: number;
  gold: number;
  baseDamage: number;
  damageType: string;
  skillLoadout: SkillLoadout;
  /** Skill IDs granted by currently equipped items/sets. Grants gate availability only —
   *  the player still equips granted skills into normal slots; losing the grant clears the slot. */
  grantedSkillIds: string[];
  inventory: Record<string, number>;
  equipment: Record<string, string | null>;
  /** XP rate tracking — in-memory only, resets on server restart. */
  xpRate: { startTime: number; totalXp: number };
  craftLevel: number;
  craftXp: number;
  combatPrefs?: CombatPrefs;
  mastery?: MasterySummary;
}

/** The Hero screen's XP gauge. See docs/architecture/combat.md → XP gauge. */
export interface ClientXpGauge {
  /** `run`: measured since this dungeon run began. */
  basis: 'measuring' | 'estimate' | 'settling' | 'steady' | 'run';
  /** Two significant figures; absent while measuring, and in a run until its first floor is cleared. */
  perHour?: number;
  /** No pack this room can roll pays anyone XP. */
  noXp?: true;
  /** The party wins under half its fights here. */
  losing?: true;
  /** Real ms from this push until the fight under way counts as long; 0 once it does. */
  longFightInMs?: number;
}

export interface ClientResetXpRateMessage {
  type: 'reset_xp_rate';
}

export interface OtherPlayerState {
  username: string;
  col: number;
  row: number;
  /** Which map this player is on. Clients hide players that aren't on the viewer's current map. */
  mapId?: string;
  zone: string;
  className?: string;
  /** The party this player belongs to. Surfaced to the client so the map
   *  modal can group co-located players into per-party boxes. Absent only
   *  in the brief transient window where a session has no party assigned. */
  partyId?: string;
  /** True while this player's party is inside a dungeon (parked at the entrance room). */
  inDungeon?: boolean;
  /** Name of the dungeon this player's party is currently delving (when inDungeon). */
  dungeonName?: string;
}

export type CombatLogType = 'battle' | 'victory' | 'defeat' | 'move' | 'unlock' | 'damage' | 'levelup' | 'retreat' | 'mastery';

export interface CombatLogEntry {
  id: number;
  text: string;
  type: CombatLogType;
}

export interface ServerStateMessage {
  type: 'state';
  username: string;
  party: ServerPartyState;
  battle: ServerBattleState;
  unlocked: string[];
  mapSize: number;
  /** The map the player's party is currently on. The client renders only this map's rooms. */
  currentMapId: string;
  /** Everyone else in this player's zone, which is as far as any reader looks. See docs/architecture/client.md. */
  otherPlayers: OtherPlayerState[];
  combatLog: CombatLogEntry[];
  battleCount: number;
  character: ClientCharacterState | null;
  /** Raw key of the zone the party is in, which is what zone chat addresses. Empty when it isn't in one. */
  zone: string;
  zoneName: string;
  social?: ClientSocialState;
  /** Item definitions for items the player currently owns (inventory + equipment). */
  itemDefinitions: Record<string, ItemDefinition>;
  /** Set definitions for sets that include items the player owns. */
  setDefinitions?: Record<string, SetDefinition>;
  /** Shop definition for the player's current room (if any). */
  shopDefinition?: ShopDefinition;
  /** Henchmen the current room's shop offers for hire. */
  henchmanOffers?: HenchmanOffer[];
  /** Craft queue, progress on the active job, and craft skill. */
  crafting?: ClientCraftingProgress;
  /** Recipes this class can see. Separate from `crafting` because it almost never changes. */
  craftingCatalog?: ClientCraftingCatalog;
  /** Active quests the player has accepted (with live progress / status). */
  activeQuests?: import('./QuestTypes.js').QuestProgressEntry[];
  /** Completed quest history (most recent at the end). */
  completedQuests?: import('./QuestTypes.js').CompletedQuestEntry[];
  /** Last turn-in time per weekly quest — the server's cooldown clock, fed to `canAcceptQuest`. */
  weeklyCompletions?: Record<string, string>;
  /** Quest definitions the player is currently aware of (active + offered by NPC at current room). */
  questDefinitions?: Record<string, import('./QuestTypes.js').QuestDefinition>;
  /** Quest IDs offered by an NPC at the player's current room (for popup display). */
  offeredQuestIds?: string[];
  /** The NPC whose quests `offeredQuestIds` lists, if the current room has one. */
  questGiverNpcId?: string;
  /** Quests some NPC offers that this player can accept now (solo scope ignored). Sorted. */
  availableQuestIds?: string[];
  /** Display-name lookups for IDs referenced by the player's active/offered quests. Tiles are keyed by room GUID. */
  questResolutions?: {
    monsters: Record<string, string>;
    items: Record<string, string>;
    tiles: Record<string, { name: string; zoneName: string }>;
  };
  /** Active dungeon run state (floor progress) — present only while the party is inside a dungeon. */
  dungeon?: DungeonRunInfo;
  /** In memory only: a restart starts it over. */
  xpGauge?: ClientXpGauge;
  /** Server version identifier — changes on restart/deploy, triggers client reload on mismatch. */
  serverVersion: string;
  /** Sent on every state until the client acks it with `ack_recap`. */
  awayRecap?: AwayLedger;
  /** Definitions for the recap's notable items. */
  awayRecapItemDefinitions?: Record<string, ItemDefinition>;
  /**
   * Wire only: fields left out because this socket already holds the same value.
   * `restoreElidedState` fills them back in, so subscribers never see this. See docs/architecture/client.md.
   */
  unchangedFields?: string[];
  /**
   * Wire only: how this socket's copies of the player rosters change. `restoreElidedState` applies it, so
   * subscribers never see this. A state without it holds the rosters itself. See docs/architecture/client.md.
   */
  rosters?: RosterChanges;
}

export interface ClientCraftingCatalog {
  recipes: RecipeDefinition[];
  /** Item definitions for every ingredient and result referenced by `recipes` — needed so the
   *  client can render names even for items the player doesn't own yet. */
  itemDefs: Record<string, ItemDefinition>;
}

export interface ClientCraftingProgress {
  queue: CraftQueueState;
  activeProgress: ActiveJobProgress | null;
  /** Per-class craft skill name (Smithing, Alchemy, etc.). */
  skillName: string;
  skillLevel: number;
  skillXp: number;
  skillXpForNext: number;
}

export type ClientCraftingState = ClientCraftingCatalog & ClientCraftingProgress;

/** What changed in one roster since this socket's last copy. */
export interface RosterChange<T> {
  whole?: T[];
  upserts?: T[];
  removes?: string[];
}

/** A roster missing from here hasn't changed. */
export interface RosterChanges {
  otherPlayers?: RosterChange<OtherPlayerState>;
  allPlayers?: RosterChange<PlayerListEntry>;
  onlinePlayers?: RosterChange<string>;
}

/** WebSocket URL query parameter: this client understands `unchangedFields` and `rosters`. */
export const PARTIAL_STATE_PARAM = 'partialStateV2';

function applyRosterChange<T>(
  previous: T[] | undefined,
  change: RosterChange<T> | undefined,
  keyOf: (entry: T) => string,
  skipKey?: string,
): T[] {
  if (!change) return previous ?? [];
  const byKey = new Map<string, T>();
  if (!change.whole) {
    for (const entry of previous ?? []) byKey.set(keyOf(entry), entry);
  }
  for (const key of change.removes ?? []) byKey.delete(key);
  for (const entry of change.whole ?? change.upserts ?? []) {
    if (keyOf(entry) !== skipKey) byKey.set(keyOf(entry), entry);
  }
  return [...byKey.values()];
}

/** Fills in what the server left out of a state push, from the previous state on the same socket. Mutates `msg`. */
export function restoreElidedState(msg: ServerStateMessage, previous: ServerStateMessage | null): void {
  const target = msg as unknown as Record<string, unknown>;
  const source = previous as unknown as Record<string, unknown> | null;
  for (const field of msg.unchangedFields ?? []) target[field] = source?.[field];
  delete msg.unchangedFields;

  const { rosters } = msg;
  if (!rosters) return;
  delete msg.rosters;
  // The server's roster for a zone includes this player.
  msg.otherPlayers = applyRosterChange(previous?.otherPlayers, rosters.otherPlayers, player => player.username, msg.username);
  if (!msg.social) return;
  const allPlayers = applyRosterChange(previous?.social?.allPlayers, rosters.allPlayers, player => player.username);
  const onlinePlayers = applyRosterChange(previous?.social?.onlinePlayers, rosters.onlinePlayers, username => username);
  // An elided `social` is the previous state's object, which a subscriber may still hold.
  if (msg.social.allPlayers !== allPlayers || msg.social.onlinePlayers !== onlinePlayers) {
    msg.social = { ...msg.social, allPlayers, onlinePlayers };
  }
}

export interface ClientMoveMessage {
  type: 'move';
  col: number;
  row: number;
}

export interface ClientRequestStateMessage {
  type: 'request_state';
}

export interface ClientEquipItemMessage {
  type: 'equip_item';
  itemId: string;
}

export interface ClientUnequipItemMessage {
  type: 'unequip_item';
  slot: EquipSlot;
}

export interface ClientDestroyItemsMessage {
  type: 'destroy_items';
  itemId: string;
  count: number;
}

export interface ClientEquipItemForceDestroyMessage {
  type: 'equip_item_force_destroy';
  itemId: string;
}

export interface ServerEquipBlockedMessage {
  type: 'equip_blocked';
  itemId: string;
  blockedByItemId: string;
  blockedBySlot: EquipSlot;
}

/**
 * A move or a map transition was refused because the party doesn't meet a
 * room's entry requirements. `requirement`/`reason` describe the gate; the
 * kind-specific fields carry the details for clients that want to format
 * their own message. The item fields predate the generalized gate and stay
 * populated for item gates.
 */
export interface ServerMoveBlockedMessage {
  type: 'move_blocked';
  /** Which kind of requirement was unmet. */
  requirement: RoomEntryFailureKind;
  /** Player-facing sentence naming the unmet requirement. */
  reason: string;
  /** Party members who don't satisfy it. */
  missingPlayers: string[];
  /** Item gates only. */
  itemId?: string;
  itemName?: string;
  /** Quest gates only. */
  questId?: string;
  questName?: string;
  /** Level gates only. */
  minLevel?: number;
}

export interface ClientEquipSkillMessage {
  type: 'equip_skill';
  skillId: string;
  slotIndex: number;
}

export interface ClientUnequipSkillMessage {
  type: 'unequip_skill';
  slotIndex: number;
}

/** The player's priority list; empty resets it to the default. Applies from the next fight. */
export interface ClientSetActionOrderMessage {
  type: 'set_action_order';
  actionOrder: string[];
}

/**
 * Machine-readable tag on an `error` message, for the cases a screen needs to react
 * to rather than just log. Most errors carry no code.
 */
export type ServerErrorCode = 'trade_nonce_mismatch' | 'quest_refused' | 'dungeon_entry_refused' | 'chat_refused' | 'gift_refused' | 'travel_refused' | 'party_refused';

export interface ServerForecastMessage {
  type: 'forecast';
  target: ForecastTarget;
  key: string;
  result: ForecastResult | null;
  status: ForecastStatus;
}

export interface ServerBestiaryMessage {
  type: 'bestiary';
  version: number;
  entries: MasteryEntry[];
}

export type ServerMessage =
  | ServerStateMessage
  | ServerCombatMessage
  | ServerSocialStateMessage
  | ServerChatMessageMessage
  | ServerSyncChatMessage
  | ServerEquipBlockedMessage
  | ServerMoveBlockedMessage
  | ServerTradeProposedMessage
  | ServerTradeCancelledMessage
  | ServerTradeCompletedMessage
  | ServerNotificationMessage
  | PlayerProfileMessage
  | ServerForecastMessage
  | ServerBestiaryMessage
  | ServerErrorMessage;

export interface ServerErrorMessage {
  type: 'error';
  message: string;
  code?: ServerErrorCode;
  /** Set on `quest_refused`: the quest the refused accept/turn-in named. */
  questId?: string;
}

export interface ClientViewPlayerMessage {
  type: 'view_player';
  username: string;
}

export interface PlayerProfileMessage {
  type: 'player_profile';
  username: string;
  className: string;
  level: number;
  guildName: string | null;
  equipment: Record<string, string | null>;
  skillLoadout: SkillLoadout;
  itemDefinitions: Record<string, ItemDefinition>;
  setDefinitions?: Record<string, SetDefinition>;
  partyMembers: { username: string; className?: string; level?: number }[];
}

export interface ClientRunMessage {
  type: 'run';
}

/** Owners and leaders turn the party's auto run on or off. */
export interface ClientSetAutoRunMessage {
  type: 'set_auto_run';
  enabled: boolean;
}

export interface ClientShopBuyMessage {
  type: 'shop_buy';
  itemId: string;
}

export interface ClientShopSellMessage {
  type: 'shop_sell';
  itemId: string;
  quantity: number;
}

export interface ClientCraftQueueMessage {
  type: 'craft_queue';
  recipeId: string;
}

export interface ClientCraftCancelMessage {
  type: 'craft_cancel';
  index: number;
}

export interface ClientAcceptQuestMessage {
  type: 'accept_quest';
  questId: string;
}

export interface ClientTurnInQuestMessage {
  type: 'turn_in_quest';
  questId: string;
}

export interface ClientSetClassMessage {
  type: 'set_class';
  className: string;
}

export interface ClientEnterDungeonMessage {
  type: 'enter_dungeon';
  /** Entrance room coordinates (must match the party's current room). */
  col: number;
  row: number;
  /** Dungeon to enter — must match the room's linked `dungeonId`. */
  dungeonId: string;
}

export interface ClientLeaveDungeonMessage {
  type: 'leave_dungeon';
}

/** Travel through one of the current room's transitions (identified by target room GUID). */
export interface ClientEnterTransitionMessage {
  type: 'enter_transition';
  tileId: string;
}

export interface ClientRequestForecastMessage {
  type: 'request_forecast';
  target: ForecastRequestTarget;
}

export interface ClientSetCombatPrefsMessage {
  type: 'set_combat_prefs';
  autoRetreatBelowPct: CombatPrefs['autoRetreatBelowPct'];
}

export interface ClientRequestBestiaryMessage {
  type: 'request_bestiary';
}

export interface ClientAckRecapMessage {
  type: 'ack_recap';
  id: string;
}

/** Page visibility, separate from `combat_view`; a socket that never sends it counts as visible. */
export interface ClientPresenceMessage {
  type: 'presence';
  visible: boolean;
}

export type ClientMessage =
  | ClientMoveMessage
  | ClientCombatViewMessage
  | ClientRequestStateMessage
  | ClientEquipItemMessage
  | ClientUnequipItemMessage
  | ClientDestroyItemsMessage
  | ClientEquipItemForceDestroyMessage
  | ClientSetClassMessage
  | ClientResetXpRateMessage
  | ClientEquipSkillMessage
  | ClientUnequipSkillMessage
  | ClientSetActionOrderMessage
  | ClientRunMessage
  | ClientSetAutoRunMessage
  | ClientViewPlayerMessage
  | ClientShopBuyMessage
  | ClientShopSellMessage
  | ClientCraftQueueMessage
  | ClientCraftCancelMessage
  | ClientAcceptQuestMessage
  | ClientTurnInQuestMessage
  | ClientEnterDungeonMessage
  | ClientLeaveDungeonMessage
  | ClientEnterTransitionMessage
  | ClientRequestForecastMessage
  | ClientSetCombatPrefsMessage
  | ClientRequestBestiaryMessage
  | ClientAckRecapMessage
  | ClientPresenceMessage
  | ClientSocialMessage
  | ClientNotificationMessage;
