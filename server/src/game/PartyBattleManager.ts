import {
  HexTile,
  offsetToCube,
  cubeToOffset,
  createPartyCombatState,
  createEncounter,
  getZone,
  rollDrops,
  validateDungeonEntry,
  rollDungeonRewards,
  rewardAppliesToClass,
  validateRoomEntry,
  buildHenchmanCombatant,
  henchmanDisplayNames,
  buildClientCombatSnapshot,
  floorCheckpoints,
  floorMaxWipes,
  floorCheckpointRewardFraction,
  clampCheckpointPhase,
  checkpointPhaseKey,
  isDungeonCheckpointFresh,
  effectiveMonsterTier,
  isBossTier,
  xpConFactor,
  recordAwayBattle,
  recordAwayDungeon,
  pickWeightedEncounter,
  partyKey as partyKeyOf,
  RUN_AVAILABLE_MS,
} from '@idle-party-rpg/shared';
import type {
  BattleResult,
  CombatSetup,
  CombatMonster,
  PartyCombatantInit,
  PartyCombatState,
  PartyGridPosition,
  ServerPartyState,
  ServerBattleState,
  ServerCombatMessage,
  DungeonDefinition,
  DungeonFloor,
  DungeonRunInfo,
  DungeonRunState,
  DungeonCheckpoint,
  DungeonEntryMemberInfo,
  DungeonReward,
  AwayDungeonOutcome,
  AwayRetreatEntry,
  RoomEntryMemberInfo,
  RoomEntryLabels,
  RoomEntryFailure,
  RoomEntryRequirements,
  HiredHenchman,
  HenchmanDefinition,
  EncounterDefinition,
  EncounterTableEntry,
  MonsterDefinition,
  MonsterInstance,
  ZoneDefinition,
  ForecastRequestTarget,
  ForecastResult,
  ServerForecastMessage,
  PartyAutoRetreatInfo,
  DungeonForecastStart,
} from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';
import { ServerBattleTimer } from './ServerBattleTimer.js';
import type { CombatFlush } from './ServerBattleTimer.js';
import { dungeonForecastKey, liveForecastKey, roomForecastKey } from './ForecastService.js';
import type { ForecastService, ForecastWork } from './ForecastService.js';
import { AUTO_RETREAT_SKIP_WINDOW, decideAutoRetreat, pickRetreatTarget } from './AutoRetreat.js';
import type { RelocateCause, RetreatCandidate } from './AutoRetreat.js';
import type { PlayerSession } from './PlayerSession.js';
import type { ContentStore } from './ContentStore.js';
import type { WorldGrids } from './WorldGrids.js';

export type { DungeonRunState } from '@idle-party-rpg/shared';

/** XP a victory pays when the finished fight is no longer available to total up. */
const FALLBACK_VICTORY_XP = 10;
/** A live forecast re-runs at most this long after a checkpoint or a party member falling. */
export const LIVE_FORECAST_DEBOUNCE_MS = 3000;
const AUTO_RETREAT_NOTICE = 'Auto-retreat kept your party out of a losing fight. Change it in Options.';

/** What an overworld fight was rolled from, for auto-retreat. */
interface OverworldBattle {
  battleId: number;
  tileId: string;
  /** The table entry the encounter came from ('' for the fallback pack). */
  entryId: string;
  players: PartyCombatantInit[];
  partyKey?: string;
  roomKey?: string;
  decided?: boolean;
}

interface ForecastPlan {
  key: string;
  build: () => ForecastWork;
}

interface PendingRetreat {
  battleId: number;
  kind: 'skip' | 'relocate';
  winPct: number;
  cause?: RelocateCause;
  target?: HexTile;
}

/** The live forecast of the party's current fight: the latest result and the job still running. */
interface LiveForecastState {
  battleId: number;
  result: ForecastResult | null;
  pendingKey: string | null;
}

interface PartyBattleEntry {
  partyId: string;
  serverParty: ServerParty;
  battleTimer: ServerBattleTimer;
  members: Set<string>;
  /** Present only while the party is inside a dungeon. */
  dungeonRun?: DungeonRunState;
  /** The current fight, when it is in the overworld. */
  battle?: OverworldBattle;
  /** No auto-retreat while the party stays in this room. */
  retreatHold?: { tileId: string };
  pendingRetreat?: PendingRetreat;
  /** One flag per recent overworld battle: whether auto-retreat skipped it. */
  recentSkips: boolean[];
  precheckKey?: string;
  liveForecastTimer?: ReturnType<typeof setTimeout>;
  live?: LiveForecastState;
}

type Notifier = (username: string, eventKey: string, vars: { title: string; body: string }) => void;

/** Result of a dungeon entry attempt. */
export type DungeonEntryResult = { success: true } | { success: false; error: string };

export interface CombatSendOptions {
  /** A congested socket may skip this message (anything without a full snapshot). */
  droppable: boolean;
}

export interface CombatDelivery {
  /** Whether any of this player's sockets shows the combat view right now. */
  isWatching: (username: string) => boolean;
  /** Sends to this player's sockets that show the combat view. */
  sendRaw: (username: string, payload: string, opts: CombatSendOptions) => void;
}

export class PartyBattleManager {
  private entries = new Map<string, PartyBattleEntry>();
  private grids: WorldGrids;
  private content: ContentStore;
  private getSession: (username: string) => PlayerSession | undefined;
  private broadcastToMember: (username: string) => void;
  private onMembersMoved?: (members: ReadonlySet<string>) => void;
  private getPartyHenchmen: (partyId: string) => HiredHenchman[] = () => [];
  private dismissHenchmenOffMap: (partyId: string, mapId: string) => HiredHenchman[] = () => [];
  private getGridPosition: (partyId: string, username: string) => PartyGridPosition | undefined = () => undefined;
  private delivery: CombatDelivery = { isWatching: () => false, sendRaw: () => {} };
  private forecaster: ForecastService | null = null;
  private autoRetreatPolicy: (partyId: string) => PartyAutoRetreatInfo | null = () => null;
  private notify: Notifier = () => {};
  private keyingParty = false;

  constructor(
    grids: WorldGrids,
    content: ContentStore,
    getSession: (username: string) => PlayerSession | undefined,
    broadcastToMember: (username: string) => void,
    onMembersMoved?: (members: ReadonlySet<string>) => void,
  ) {
    this.grids = grids;
    this.content = content;
    this.getSession = getSession;
    this.broadcastToMember = broadcastToMember;
    this.onMembersMoved = onMembersMoved;
  }

  /** Wire the henchmen roster callbacks. Called once by PlayerManager at boot. */
  setHenchmenCallbacks(
    getPartyHenchmen: (partyId: string) => HiredHenchman[],
    dismissHenchmenOffMap: (partyId: string, mapId: string) => HiredHenchman[],
  ): void {
    this.getPartyHenchmen = getPartyHenchmen;
    this.dismissHenchmenOffMap = dismissHenchmenOffMap;
  }

  /** Wire the live combat stream to the sockets. Called once by PlayerManager at boot. */
  setCombatDelivery(delivery: CombatDelivery): void {
    this.delivery = delivery;
  }

  /** Wire the party roster's grid positions. Unwired, each session reads its own from social state. */
  setGridPositionLookup(lookup: (partyId: string, username: string) => PartyGridPosition | undefined): void {
    this.getGridPosition = lookup;
  }

  /** Wire the forecaster. Without one, forecasts are unavailable and auto-retreat never acts. */
  setForecaster(forecaster: ForecastService | null): void {
    this.forecaster = forecaster;
  }

  /** Wire who decides a party's auto-retreat threshold (its owner). Unwired, auto-retreat is off. */
  setAutoRetreatPolicy(policy: (partyId: string) => PartyAutoRetreatInfo | null): void {
    this.autoRetreatPolicy = policy;
  }

  setNotifier(notify: Notifier): void {
    this.notify = notify;
  }

  /**
   * Build the battle timer for a party and register the entry. Shared by
   * {@link createEntry} and {@link createEntryFromSave} so movement gating and
   * battle callbacks can never drift between fresh and restored parties.
   */
  private registerEntry(partyId: string, serverParty: ServerParty, members: Set<string>): void {
    const battleTimer = new ServerBattleTimer(
      serverParty,
      () => this.createCombatForParty(partyId),
      {
        onBattleStart: () => {
          for (const m of members) {
            this.getSession(m)?.incrementBattleCount();
          }
          this.afterBattleStart(partyId);
        },
        onStateChange: () => {
          for (const m of members) {
            this.broadcastToMember(m);
          }
        },
        onCombatFlush: (flush) => {
          this.deliverCombat(members, flush);
          this.watchLiveForecastTriggers(partyId, flush);
        },
        onBattleEnd: (result: BattleResult) => {
          this.handleBattleEnd(partyId, result);
        },
        onPhase: (battleId, phase) => this.handleBossPhase(partyId, battleId, phase),
        onRetreat: (battleId) => this.applyRetreat(partyId, battleId),
        onMove: () => {
          const allQuests = this.content.getAllQuests();
          const tileId = serverParty.tile.id;
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              const allZones = this.content.getAllZones();
              const zone = getZone(serverParty.tile.zone, allZones);
              const zName = zone ? zone.displayName : serverParty.tile.zone;
              const tileDef = this.content.getTileById(serverParty.tile.id);
              const rName = tileDef?.name ?? '';
              s.addLogEntry(`Moved to ${zName}${rName ? `, ${rName}` : ''}`, 'move');
              s.quests.applyVisit(tileId, allQuests);
            }
          }
          this.onMembersMoved?.(members);
        },
        canMoveToNextTile: () => {
          const nextTile = serverParty.nextTile;
          if (!nextTile) return false;
          // Fog of war only. Entry requirements are checked when the move is
          // requested (handleMove validates every room in the path), so there
          // is nothing to re-decide per step.
          for (const m of members) {
            const s = this.getSession(m);
            if (s && s.isTileUnlocked(nextTile)) return true;
          }
          return false;
        },
      },
      partyId,
    );

    this.entries.set(partyId, { partyId, serverParty, battleTimer, members, recentSkips: [] });
  }

  /** Create a party battle entry and start fighting. */
  createEntry(partyId: string, username: string, startTile: HexTile, mapId: string): void {
    if (this.entries.has(partyId)) return;

    const serverParty = new ServerParty(this.grids.getOrThrow(mapId), startTile, mapId);
    this.registerEntry(partyId, serverParty, new Set([username]));
    this.startEntry(partyId);
  }

  /** Start a registered party's battle loop (idempotent). Restored entries wait for this until fully assembled. */
  startEntry(partyId: string): void {
    this.entries.get(partyId)?.battleTimer.start();
  }

  /** Create a party battle entry from saved movement state (for restoring). Does not start fighting — call {@link startEntry}. */
  createEntryFromSave(
    partyId: string,
    username: string,
    currentTile: HexTile,
    targetTile: HexTile | null,
    movementQueue: HexTile[],
    mapId: string,
  ): void {
    if (this.entries.has(partyId)) return;

    const serverParty = ServerParty.restore(this.grids.getOrThrow(mapId), currentTile, targetTile, movementQueue, mapId);
    this.registerEntry(partyId, serverParty, new Set([username]));
  }

  /** Add a member to an existing party battle. They join the next combat cycle. */
  addMember(partyId: string, username: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.members.add(username);
    this.clearRetreatHold(partyId);
  }

  /** Remove a member from a party battle. Does not create a new solo entry — caller should do that. */
  removeMember(partyId: string, username: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.settlePendingResult();
    entry.members.delete(username);
    this.clearRetreatHold(partyId);

    if (entry.members.size === 0) {
      this.destroyEntry(partyId);
    }
  }

  /** Restart the current battle for a party (e.g., after a member changes class). */
  restartBattle(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    this.clearRetreatHold(partyId);
    entry.battleTimer.settlePendingResult();
    entry.battleTimer.restartBattle();
  }

  /** Let auto-retreat act again: a player moved the party, its roster changed, or the owner changed the setting. */
  clearRetreatHold(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.retreatHold = undefined;
    entry.recentSkips = [];
  }

  /** Whether the party may Run right now (overworld fight, far enough in, not already won or lost). */
  canEscape(partyId: string): boolean {
    const entry = this.entries.get(partyId);
    if (!entry || entry.dungeonRun) return false;
    return entry.battleTimer.canEscape();
  }

  /** Escape the current battle for a party. No rewards given. */
  escapeBattle(partyId: string): boolean {
    const entry = this.entries.get(partyId);
    if (!entry) return false;
    if (!this.canEscape(partyId)) return false;

    for (const m of entry.members) {
      const s = this.getSession(m);
      if (s) s.addLogEntry('Escaped the battle!', 'battle');
    }

    entry.battleTimer.escapeBattle();

    for (const m of entry.members) {
      this.broadcastToMember(m);
    }
    return true;
  }

  /** Destroy a party battle entry and stop its timers. A won-but-unshown fight is paid out first. */
  destroyEntry(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.settlePendingResult();
    entry.battleTimer.destroy();
    if (entry.liveForecastTimer) clearTimeout(entry.liveForecastTimer);
    entry.liveForecastTimer = undefined;
    this.entries.delete(partyId);
  }

  /** A full-snapshot combat message for a (re)connecting socket, or null when no fight is live. */
  buildCombatResync(partyId: string): ServerCombatMessage | null {
    const timer = this.entries.get(partyId)?.battleTimer;
    const combat = timer?.currentCombat;
    if (!timer || !combat || !timer.isLive) return null;
    timer.flushPending();
    return {
      type: 'combat',
      battleId: timer.battleId,
      snapshot: buildClientCombatSnapshot(combat, timer.battleId, true),
      events: [],
      log: timer.recentLog,
    };
  }

  /** Handle move request. Returns the unmet requirement if the path is gated. */
  handleMove(partyId: string, col: number, row: number): { success: true } | { success: false; blocked?: RoomEntryFailure } {
    const entry = this.entries.get(partyId);
    if (!entry) return { success: false };

    // Parties are locked inside a dungeon instance — no overworld movement.
    if (entry.dungeonRun) return { success: false };

    const coord = offsetToCube({ col, row });
    const tile = this.grids.getOrThrow(entry.serverParty.currentMapId).getTile(coord);
    if (!tile || !tile.isTraversable) return { success: false };

    // Snapshot first: setDestination overwrites the queue, so a refused move
    // must put the party's previous path back rather than strand it.
    const previousPath = entry.serverParty.remainingPath;
    const success = entry.serverParty.setDestination(tile);
    if (!success) return { success: false };

    const blocked = this.validatePathRequirements(entry);
    if (blocked) {
      entry.serverParty.restoreMovementQueue(previousPath);
      return { success: false, blocked };
    }

    this.clearRetreatHold(partyId);
    for (const m of entry.members) {
      this.broadcastToMember(m);
    }
    return { success: true };
  }

  /**
   * Travel through the transition on the party's current room to its linked
   * (mapId, tileId): swap the party's grid + position, reveal the arrival area
   * for every member, and start a fresh battle on the new map.
   */
  enterTransition(partyId: string, targetTileId: string): { success: true } | { success: false; error: string; blocked?: RoomEntryFailure } {
    const entry = this.entries.get(partyId);
    if (!entry) return { success: false, error: 'No party.' };
    entry.battleTimer.settlePendingResult();
    if (entry.dungeonRun) return { success: false, error: "Can't travel from inside a dungeon." };

    const fromDef = this.content.getTileById(entry.serverParty.tile.id);
    // The current room must actually offer a transition to the requested target.
    const link = fromDef?.transitions?.find(t => t.tileId === targetTileId);
    if (!link) return { success: false, error: 'Nothing to enter here.' };

    const destGrid = this.grids.get(link.mapId);
    const destDef = this.content.getTileById(link.tileId);
    if (!destGrid || !destDef || destDef.mapId !== link.mapId) {
      return { success: false, error: 'That passage leads nowhere right now.' };
    }

    let destTile = destGrid.getTileById(link.tileId);
    if (!destTile) {
      // Defensive: tile exists in content but not the grid — fall back to the map's start tile.
      const meta = this.content.getWorld().maps.find(m => m.id === link.mapId);
      if (meta) destTile = destGrid.getTile(offsetToCube(meta.startTile));
      if (!destTile) return { success: false, error: 'That passage leads nowhere right now.' };
    }

    // A transition is a door into a room: the link's own gate and the
    // destination room's gate both apply.
    const blocked = this.checkRoomEntry(entry.members, link.entryRequirements)
      ?? this.checkRoomEntry(entry.members, destTile.entryRequirements);
    if (blocked) return { success: false, error: blocked.reason, blocked };

    entry.serverParty.switchMap(destGrid, destTile, link.mapId);
    this.announceHenchmenLeft(entry, this.dismissHenchmenOffMap(partyId, link.mapId));

    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      session.switchMapGrid(destTile);
      session.addLogEntry(`Traveled to ${destDef.name}.`, 'move');
    }

    // New map → fresh encounter.
    entry.battleTimer.restartBattle();
    for (const m of entry.members) this.broadcastToMember(m);
    return { success: true };
  }

  private announceHenchmenLeft(entry: PartyBattleEntry, dismissed: HiredHenchman[]): void {
    if (dismissed.length === 0) return;
    for (const hired of dismissed) {
      const name = this.content.getHenchman(hired.henchmanId)?.name ?? 'Your henchman';
      for (const username of entry.members) {
        this.getSession(username)?.addLogEntry(`${name} parts ways with the party.`, 'move');
      }
    }
  }

  /**
   * Per-member facts for the shared room-entry validator. A member with no live
   * session satisfies nothing — the same conservative rule the item gate has
   * always applied.
   */
  private buildMemberInfos(members: ReadonlySet<string>): RoomEntryMemberInfo[] {
    const infos: RoomEntryMemberInfo[] = [];
    for (const username of members) {
      const session = this.getSession(username);
      if (!session) {
        infos.push({ username, level: 0, equippedItemIds: new Set(), completedQuestIds: new Set() });
        continue;
      }
      infos.push({
        username,
        level: session.getLevel(),
        equippedItemIds: session.getEquippedItemIds(),
        completedQuestIds: session.quests.getCompletedQuestIds(),
      });
    }
    return infos;
  }

  /** Content-backed display names so gate rejections read as player-facing prose. */
  private roomLabels(): RoomEntryLabels {
    return {
      itemName: id => this.content.getItem(id)?.name,
      questName: id => this.content.getQuest(id)?.name,
    };
  }

  /**
   * Whether this party satisfies a room's entry requirements. Used after a
   * content change to find parties standing in a room that just became gated.
   */
  checkPartyRoomEntry(partyId: string, tile: HexTile): RoomEntryFailure | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    return this.checkRoomEntry(entry.members, tile.entryRequirements);
  }

  /** Evaluate one gate against a party. Returns the unmet requirement, or null. */
  private checkRoomEntry(members: ReadonlySet<string>, reqs: RoomEntryRequirements | undefined): RoomEntryFailure | null {
    if (!reqs) return null;
    return validateRoomEntry(reqs, this.buildMemberInfos(members), this.roomLabels());
  }

  /**
   * Check every room in the party's queued path against its entry
   * requirements. All members must satisfy every gate. Member info is built
   * once and reused across the path.
   */
  private validatePathRequirements(entry: PartyBattleEntry): RoomEntryFailure | null {
    const path = entry.serverParty.remainingPath;
    if (!path.some(tile => tile.entryRequirements)) return null;

    const infos = this.buildMemberInfos(entry.members);
    const labels = this.roomLabels();
    for (const tile of path) {
      const failure = validateRoomEntry(tile.entryRequirements, infos, labels);
      if (failure) return failure;
    }
    return null;
  }

  /** Get the party's current position. */
  getPosition(partyId: string): { col: number; row: number } | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    return cubeToOffset(entry.serverParty.position);
  }

  /** Get the party's current tile. */
  getTile(partyId: string): HexTile | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    return entry.serverParty.tile;
  }

  /** Get the party's remaining movement path. */
  getPath(partyId: string): HexTile[] {
    const entry = this.entries.get(partyId);
    if (!entry) return [];
    return entry.serverParty.remainingPath;
  }

  /** Get zone string for the party's current tile. */
  getZone(partyId: string): string | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    return entry.serverParty.tile.zone;
  }

  /** Get the ServerPartyState for the state message. */
  getPartyState(partyId: string): ServerPartyState | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    return entry.serverParty.toJSON();
  }

  /** Get the ServerBattleState for the state message. */
  getBattleState(partyId: string): ServerBattleState | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;

    const timer = entry.battleTimer;
    const combat = timer.currentCombat;
    return {
      state: timer.currentState,
      result: timer.lastResult,
      visual: timer.visual,
      duration: timer.currentDuration,
      combat: combat ? buildClientCombatSnapshot(combat, timer.battleId, true) : undefined,
    };
  }

  /** Get movement save data for a party (used for PlayerSession save). */
  getMovementSaveData(partyId: string): {
    position: { col: number; row: number };
    mapId: string;
    target: { col: number; row: number } | null;
    movementQueue: { col: number; row: number }[];
  } | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    const json = entry.serverParty.toJSON();
    return {
      position: { col: json.col, row: json.row },
      mapId: entry.serverParty.currentMapId,
      target: json.targetCol !== undefined && json.targetRow !== undefined
        ? { col: json.targetCol, row: json.targetRow }
        : null,
      movementQueue: json.path,
    };
  }

  /** Get the map the party is currently on. */
  getMapId(partyId: string): string | null {
    return this.entries.get(partyId)?.serverParty.currentMapId ?? null;
  }

  /** Check if two parties are at the same tile. */
  areSameTile(partyIdA: string, partyIdB: string): boolean {
    const a = this.entries.get(partyIdA);
    const b = this.entries.get(partyIdB);
    if (!a || !b) return false;
    const posA = cubeToOffset(a.serverParty.position);
    const posB = cubeToOffset(b.serverParty.position);
    return posA.col === posB.col && posA.row === posB.row;
  }

  /** Get all party IDs. */
  getAllPartyIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Get members of a party. */
  getMembers(partyId: string): Set<string> | undefined {
    return this.entries.get(partyId)?.members;
  }

  /** Relocate a party to a new tile, restarting its battle. */
  relocateParty(partyId: string, newTile: HexTile, mapId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.settlePendingResult();
    // A forced relocation (e.g. content deploy) ends any active dungeon run —
    // otherwise the party stays movement-locked on a fresh tile fighting stale
    // dungeon-floor encounters.
    if (entry.dungeonRun) this.endRunByLeaving(entry, entry.dungeonRun);
    entry.dungeonRun = undefined;
    if (entry.serverParty.currentMapId !== mapId) {
      // Relocation crosses to a different map (e.g. the party's map was deleted).
      entry.serverParty.switchMap(this.grids.getOrThrow(mapId), newTile, mapId);
      this.announceHenchmenLeft(entry, this.dismissHenchmenOffMap(partyId, mapId));
    } else {
      entry.serverParty.relocateTo(newTile);
    }
    entry.battleTimer.restartBattle();
  }

  /**
   * After a grid rebuild, re-resolve all parties' tile references against their
   * own map. The grid objects are the same but tiles inside them are new instances.
   * Parties whose map vanished are left for relocateDisplacedParties to handle.
   */
  refreshAllPartyTiles(grids: WorldGrids): void {
    for (const entry of this.entries.values()) {
      const grid = grids.get(entry.serverParty.currentMapId);
      if (!grid) continue;
      const pos = cubeToOffset(entry.serverParty.position);
      const coord = offsetToCube(pos);
      const freshTile = grid.getTile(coord);
      if (freshTile) {
        // Re-set to the same position but with fresh tile reference
        entry.serverParty.relocateTo(freshTile);
      }
    }
  }

  /** Recap hook for auto-retreat: counts the retreat for every member of the party. */
  recordRetreat(partyId: string, retreat: AwayRetreatEntry): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    for (const username of entry.members) this.getSession(username)?.recordRetreat(retreat);
  }

  /** Recap hook for a party whose queued route was abandoned (e.g. by an auto-retreat relocation). */
  recordRouteStopped(partyId: string, where: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    for (const username of entry.members) this.getSession(username)?.recordRouteStopped(where);
  }

  /** The party's fighters as the next battle would build them (members, then henchmen). No side effects. */
  buildPartyCombatants(partyId: string): PartyCombatantInit[] {
    const entry = this.entries.get(partyId);
    if (!entry) return [];

    const players: PartyCombatantInit[] = [];
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session?.hasCharacter()) continue;
      players.push(session.getCombatInfo(this.getGridPosition(partyId, username)));
    }

    const hires = this.getPartyHenchmen(partyId)
      .map(hired => ({ hired, def: this.content.getHenchman(hired.henchmanId) }))
      .filter((h): h is { hired: HiredHenchman; def: HenchmanDefinition } => !!h.def);
    const names = henchmanDisplayNames(hires.map(h => h.def.name), players.map(p => p.username));
    hires.forEach(({ hired, def }, i) => {
      players.push(buildHenchmanCombatant(def, hired, id => this.content.getSkill(id), names[i]));
    });
    return players;
  }

  /** The weighted table a fight in this room rolls from: its own, else its zone's (empty → the fallback pack). */
  resolveEncounterTable(tileId: string, zoneId?: string): EncounterTableEntry[] {
    const tileDef = this.content.getTileById(tileId);
    if (tileDef?.encounterTable?.length) return tileDef.encounterTable;
    const zone = zoneId ?? tileDef?.zone;
    return (zone ? this.content.getAllZones()[zone]?.encounterTable : undefined) ?? [];
  }

  /** Digest of the party's forecast inputs (`GamePartyInfo.forecastKey`); undefined without a forecaster. */
  forecastKey(partyId: string): string | undefined {
    // Re-entrant through getCombatInfo → social state when a member's grid slot is unknown.
    if (!this.forecaster || this.keyingParty) return undefined;
    this.keyingParty = true;
    try {
      const players = this.buildPartyCombatants(partyId);
      return players.length > 0 ? partyKeyOf(players) : undefined;
    } finally {
      this.keyingParty = false;
    }
  }

  /**
   * Answer a player's forecast request for a room on their map or a dungeon whose entrance they
   * have found. The reply echoes `target`; a queued job replies again when it finishes. A dungeon
   * forecast starts from `entrant`'s saved progress: whoever would take the party in.
   */
  requestForecast(
    partyId: string,
    requester: string,
    target: ForecastRequestTarget,
    reply: (message: ServerForecastMessage) => void,
    entrant: string = requester,
  ): void {
    const send = (status: ServerForecastMessage['status'], key = '', result: ForecastResult | null = null): void => {
      reply({ type: 'forecast', target, key, result, status });
    };
    const svc = this.forecaster;
    const entry = this.entries.get(partyId);
    const session = this.getSession(requester);
    if (!svc || !entry || !session?.hasCharacter() || !entry.members.has(requester)) return send('unavailable');
    if (!svc.allowRequest(requester)) return send('unavailable');

    const request = target.kind === 'room'
      ? this.roomRequest(entry, session, target.tileId)
      : this.dungeonRequest(entry, session, target.dungeonId, this.getSession(entrant) ?? session);
    if (request === 'denied' || request === 'unavailable') return send(request);

    const answer = svc.request({
      key: request.key,
      priority: 'explicit',
      build: request.build,
      supersede: { group: `explicit:${requester}`, previous: 'demote' },
      onDone: (result) => send(result ? 'ok' : 'unavailable', request.key, result),
    });
    if (answer.status === 'ok') send('ok', request.key, answer.result);
    else send(answer.status, request.key);
  }

  // --- Private ---

  private createCombatForParty(partyId: string): PartyCombatState {
    const entry = this.entries.get(partyId);
    const allMonsters = this.content.getAllMonsters();
    const allZones = this.content.getAllZones();
    const allEncounters = this.content.getAllEncounters();

    if (!entry) {
      // Fallback: empty combat
      return createPartyCombatState([], createEncounter(undefined, allMonsters, allZones, allEncounters));
    }

    const players = this.buildPartyCombatants(partyId);
    const zone = entry.serverParty.tile.zone;
    entry.battle = undefined;

    // Inside a dungeon: encounters come from the current floor's table, not the tile.
    if (entry.dungeonRun) {
      const run = entry.dungeonRun;
      const floor = this.content.getDungeon(run.dungeonId)?.floors[run.currentFloorIndex];
      if (floor) {
        const monsters = createEncounter(zone, allMonsters, allZones, allEncounters, floor.encounterTable);
        return createPartyCombatState(players, monsters, this.checkpointSetup(run, floor));
      }
      // Dungeon/floor vanished (e.g. content deploy) — abandon the run so the
      // party isn't stuck (movement stays blocked while dungeonRun is set) and
      // fall through to a normal tile encounter at their current position.
      entry.dungeonRun = undefined;
    }

    const tileId = entry.serverParty.tile.id;
    const table = this.resolveEncounterTable(tileId, zone);
    const rolled = rollEncounter(zone, allMonsters, allZones, allEncounters, table);
    entry.battle = { battleId: entry.battleTimer.battleId, tileId, entryId: rolled.entryId, players };
    entry.recentSkips = [...entry.recentSkips, false].slice(-AUTO_RETREAT_SKIP_WINDOW);

    return createPartyCombatState(players, rolled.monsters);
  }

  /** Boss-phase setup for a checkpoint floor, resuming at the run's (clamped) checkpoint. */
  private checkpointSetup(run: DungeonRunState, floor: DungeonFloor): CombatSetup {
    const thresholds = floorCheckpoints(floor);
    if (thresholds.length === 0) return {};
    const resumePhase = clampCheckpointPhase(run.checkpointPhase, floor);
    run.checkpointPhase = resumePhase > 0 ? resumePhase : undefined;
    return { bossPhases: resumePhase > 0 ? { thresholds, resumePhase } : { thresholds } };
  }

  private handleBattleEnd(partyId: string, result: BattleResult): void {
    const entry = this.entries.get(partyId);
    if (!entry || entry.members.size === 0) return;

    if (result === 'victory') {
      this.payVictory(entry);
    } else {
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.addLogEntry('Defeat...', 'defeat');
        session.recordAway(l => recordAwayBattle(l, { won: false }));
      }

      // Dungeon: a wipe fails the run — eject the party to the entrance room.
      if (entry.dungeonRun) {
        this.handleDungeonDefeat(entry);
      }
    }
  }

  private payVictory(entry: PartyBattleEntry): void {
    const combat = entry.battleTimer.currentCombat;
    const members = Array.from(entry.members);
    const partySize = members.length;

    let totalGold = 0;
    if (combat) {
      for (const m of combat.monsters) {
        const def = this.content.getMonster(m.id);
        if (def) {
          totalGold += def.goldMin + Math.floor(Math.random() * (def.goldMax - def.goldMin + 1));
        }
      }
    }
    const xpMultiplier = this.partyXpMultiplier(members);
    const splitGold = Math.ceil(totalGold / partySize);

    // Roll item drops once, randomly assign each to a party member
    const memberItems: Map<string, string[]> = new Map();
    for (const u of members) memberItems.set(u, []);

    if (combat) {
      for (const m of combat.monsters) {
        const def = this.content.getMonster(m.id);
        if (def?.drops) {
          const dropped = rollDrops(def.drops);
          for (const itemId of dropped) {
            const itemDef = this.content.getItem(itemId);
            let eligible = members;
            if (itemDef?.classRestriction && itemDef.classRestriction.length > 0) {
              const matching = members.filter(u => {
                const s = this.getSession(u);
                const cn = s?.getClassName();
                return cn && itemDef.classRestriction!.includes(cn);
              });
              if (matching.length > 0) eligible = matching;
            }
            const recipient = eligible[Math.floor(Math.random() * eligible.length)];
            memberItems.get(recipient)!.push(itemId);
          }
        }
      }
    }

    // Mastery and the recap count monsters actually killed; XP/gold/drops/quests still cover every monster.
    const killed = combat ? combat.monsters.filter(m => !m.passive && !(m.currentHp > 0)) : [];
    const anyoneAway = members.some(u => this.getSession(u)?.isAway());
    const closeCall = combat && anyoneAway ? this.closeCall(entry, combat) : null;

    for (const username of members) {
      const session = this.getSession(username);
      if (!session) continue;
      const baseXp = combat ? this.memberXp(combat.monsters, session.getLevel()) : FALLBACK_VICTORY_XP;
      session.handleVictory(
        { xp: Math.ceil((baseXp * xpMultiplier) / partySize), gold: splitGold, items: memberItems.get(username)! },
        entry.serverParty.tile,
        // Dungeon floors aren't overworld tiles — don't unlock neighbours mid-run.
        { unlockTiles: !entry.dungeonRun, kills: killed.length },
      );
      session.recordKills(killed.map(m => ({ id: m.id, name: m.name, tier: m.tier })));
      if (closeCall) session.recordCloseCall(closeCall);
    }

    // Quest hooks: credit every monster to every party member with active kill objectives.
    if (combat) {
      const allQuests = this.content.getAllQuests();
      for (const m of combat.monsters) {
        for (const username of members) {
          const session = this.getSession(username);
          if (!session) continue;
          session.quests.applyKill(m.id, allQuests);
        }
      }
    }

    // Dungeon: grant floor rewards, then advance to the next floor or complete the run.
    if (entry.dungeonRun) {
      this.handleDungeonFloorCleared(entry);
    }
  }

  /** XP a member earns from these monsters before the split: authored-level monsters pay by con. */
  private memberXp(monsters: readonly CombatMonster[], memberLevel: number): number {
    let xp = 0;
    for (const m of monsters) {
      if (!Number.isFinite(m.xp)) continue;
      const level = m.level;
      const authored = m.levelSource === 'authored' && typeof level === 'number' && Number.isFinite(level);
      xp += authored ? m.xp * xpConFactor(level, 'authored', memberLevel) : m.xp;
    }
    return xp;
  }

  /** 1 + every equipped `xp_bonus` passive's flat value across the party (e.g. Bard Inspiration). */
  private partyXpMultiplier(members: readonly string[]): number {
    let xpMultiplier = 1;
    for (const username of members) {
      const loadout = this.getSession(username)?.getSkillLoadout();
      if (!loadout) continue;
      for (const skillId of loadout.equippedSkills) {
        if (!skillId) continue;
        const skill = this.content.getSkill(skillId);
        for (const effect of skill?.passiveEffects ?? []) {
          if (effect.kind === 'xp_bonus') xpMultiplier += effect.flatValue ?? 0;
        }
      }
    }
    return xpMultiplier;
  }

  private closeCall(entry: PartyBattleEntry, combat: PartyCombatState): { hpPct: number; vs: string; where: string } | null {
    const frac = combat.minPartyHpFrac;
    if (typeof frac !== 'number' || !Number.isFinite(frac)) return null;
    const names = [...new Set(combat.monsters.filter(m => !m.passive).map(m => m.name))];
    return {
      hpPct: Math.max(0, Math.round(frac * 100)),
      vs: names.slice(0, 3).join(', ') || 'monsters',
      where: this.describeLocation(entry),
    };
  }

  /** "Goblin Warren, floor 3" inside a dungeon, else the room's name (or its zone's). */
  private describeLocation(entry: PartyBattleEntry): string {
    const run = entry.dungeonRun;
    if (run) {
      const dungeon = this.content.getDungeon(run.dungeonId);
      if (dungeon) return `${dungeon.name}, floor ${run.currentFloorIndex + 1}`;
    }
    return this.roomName(entry.serverParty.tile);
  }

  /** The room's name, else its zone's. */
  private roomName(tile: HexTile): string {
    const name = this.content.getTileById(tile.id)?.name;
    if (name) return name;
    return getZone(tile.zone, this.content.getAllZones())?.displayName ?? tile.zone;
  }

  private deliverCombat(members: ReadonlySet<string>, flush: CombatFlush): void {
    const recipients: string[] = [];
    for (const m of members) {
      if (this.delivery.isWatching(m)) recipients.push(m);
    }
    if (recipients.length === 0) return;

    const message: ServerCombatMessage = {
      type: 'combat',
      battleId: flush.battleId,
      events: flush.events,
      log: flush.log,
    };
    if (flush.snapshot) {
      message.snapshot = buildClientCombatSnapshot(flush.combat, flush.battleId, flush.snapshot === 'full');
    }
    const payload = JSON.stringify(message);
    const opts: CombatSendOptions = { droppable: flush.snapshot !== 'full' };
    for (const m of recipients) this.delivery.sendRaw(m, payload, opts);
  }

  // --- Forecasts & auto-retreat ---

  private roomRequest(entry: PartyBattleEntry, session: PlayerSession, tileId: string): ForecastPlan | 'denied' | 'unavailable' {
    const mapId = entry.serverParty.currentMapId;
    const tileDef = this.content.getTileById(tileId);
    if (!tileDef || tileDef.mapId !== mapId || !this.grids.get(mapId)?.getTileById(tileId)) return 'denied';
    if (!session.isTileIdUnlocked(tileId)) return 'denied';
    const players = this.buildPartyCombatants(entry.partyId);
    if (players.length === 0) return 'unavailable';
    const pk = partyKeyOf(players);
    return { key: roomForecastKey(this.content.contentEpoch, pk, tileId), build: () => this.roomWork(players, pk, tileId) };
  }

  private dungeonRequest(
    entry: PartyBattleEntry,
    session: PlayerSession,
    dungeonId: string,
    entrant: PlayerSession,
  ): ForecastPlan | 'denied' | 'unavailable' {
    const dungeon = this.content.getDungeon(dungeonId);
    const entrance = this.content.getWorld().tiles.find(t => t.dungeonId === dungeonId && session.isTileIdUnlocked(t.id));
    if (!dungeon || !entrance) return 'denied';
    const players = this.buildPartyCombatants(entry.partyId);
    if (players.length === 0) return 'unavailable';
    const pk = partyKeyOf(players);
    const start = this.dungeonForecastStart(entry, entrant, dungeon);
    const fallbackTable = this.content.getAllZones()[entrance.zone]?.encounterTable ?? [];
    return {
      key: dungeonForecastKey(this.content.contentEpoch, pk, dungeonId, start),
      build: () => ({
        input: {
          kind: 'dungeon',
          players,
          dungeon,
          monsters: this.content.getAllMonsters(),
          encounters: this.content.getAllEncounters(),
          fallbackTable,
          start,
        },
        opts: { partyKey: pk },
      }),
    };
  }

  /** Where a run would start: the party's own run, else the entrant's stored checkpoint. */
  private dungeonForecastStart(entry: PartyBattleEntry, entrant: PlayerSession, dungeon: DungeonDefinition): Required<DungeonForecastStart> {
    const run = entry.dungeonRun;
    const floor = run?.dungeonId === dungeon.id ? dungeon.floors[run.currentFloorIndex] : undefined;
    if (run && floor) {
      return { floorIndex: run.currentFloorIndex, phase: clampCheckpointPhase(run.checkpointPhase, floor), wipes: run.wipes ?? 0 };
    }
    const checkpoint = this.usableCheckpoint(entrant.getDungeonCheckpoint(dungeon.id), dungeon);
    return checkpoint
      ? { floorIndex: checkpoint.floorIndex, phase: checkpoint.phase, wipes: checkpoint.wipes }
      : { floorIndex: 0, phase: 0, wipes: 0 };
  }

  private roomWork(players: PartyCombatantInit[], pk: string, tileId: string): ForecastWork {
    return {
      input: {
        kind: 'room',
        players,
        table: this.resolveEncounterTable(tileId),
        monsters: this.content.getAllMonsters(),
        encounters: this.content.getAllEncounters(),
      },
      opts: { partyKey: pk },
    };
  }

  /** Forecasting must never break a fight: its failures are logged and dropped. */
  private guardForecast<T>(what: string, fn: () => T): T | undefined {
    try {
      return fn();
    } catch (err) {
      console.error(`[PartyBattleManager] forecasting (${what}) failed:`, err);
      return undefined;
    }
  }

  private afterBattleStart(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry || !this.forecaster) return;
    this.guardForecast('battle start', () => {
      this.startLiveForecast(entry);
      this.checkAutoRetreat(entry);
    });
  }

  /** Decide from the room's cached forecast, or queue one and decide when it lands (if the fight is still on). */
  private checkAutoRetreat(entry: PartyBattleEntry): void {
    const svc = this.forecaster;
    const battle = entry.battle;
    if (!svc || !battle || entry.dungeonRun || battle.players.length === 0) return;
    if (battle.battleId !== entry.battleTimer.battleId) return;
    const belowPct = this.retreatThreshold(entry);
    if (belowPct <= 0 || this.holdApplies(entry)) return;

    const pk = partyKeyOf(battle.players);
    const key = roomForecastKey(this.content.contentEpoch, pk, battle.tileId);
    battle.partyKey = pk;
    battle.roomKey = key;
    const cached = svc.get(key);
    if (cached) {
      this.decideRetreat(entry, battle, cached, belowPct);
      return;
    }
    if (entry.precheckKey === key) return;
    const answer = svc.request({
      key,
      priority: 'precheck',
      build: () => this.roomWork(battle.players, pk, battle.tileId),
      onDone: (result) => this.guardForecast('pre-check', () => this.onPrecheckDone(entry, key, result)),
    });
    if (answer.status === 'pending') entry.precheckKey = key;
  }

  private onPrecheckDone(entry: PartyBattleEntry, key: string, result: ForecastResult | null): void {
    if (entry.precheckKey === key) entry.precheckKey = undefined;
    const battle = entry.battle;
    if (!result || this.entries.get(entry.partyId) !== entry || !battle || battle.roomKey !== key || battle.decided) return;
    if (entry.dungeonRun || !entry.battleTimer.isFighting(battle.battleId)) return;
    const belowPct = this.retreatThreshold(entry);
    if (belowPct <= 0 || this.holdApplies(entry)) return;
    this.decideRetreat(entry, battle, result, belowPct);
  }

  private decideRetreat(entry: PartyBattleEntry, battle: OverworldBattle, room: ForecastResult, belowPct: number): void {
    battle.decided = true;
    const decision = decideAutoRetreat(room, battle.entryId, belowPct, entry.recentSkips.filter(Boolean).length);
    if (decision.kind === 'none') return;
    const timer = entry.battleTimer;
    const combat = timer.currentCombat;
    if (!combat || !timer.isFighting(battle.battleId)) return;

    let pending: PendingRetreat = { battleId: battle.battleId, kind: 'skip', winPct: decision.winPct };
    if (decision.kind === 'relocate') {
      const target = this.findRetreatTarget(entry, battle, belowPct);
      if (target === null) {
        this.holdHere(entry);
        return;
      }
      if (target !== 'wait') pending = { ...pending, kind: 'relocate', cause: decision.cause, target };
    }
    entry.pendingRetreat = pending;
    const reason = pending.target ? 'Your party falls back to a safer room.' : 'Your party slips away from the fight.';
    timer.scheduleRetreat(battle.battleId, RUN_AVAILABLE_MS - combat.elapsedMs, reason);
  }

  /**
   * An adjacent room on this map that a member has found, the party may enter, and whose forecast is
   * known to clear the threshold. 'wait' while neighbours are still being forecast.
   */
  private findRetreatTarget(entry: PartyBattleEntry, battle: OverworldBattle, belowPct: number): HexTile | 'wait' | null {
    const svc = this.forecaster;
    const grid = this.grids.get(entry.serverParty.currentMapId);
    if (!svc || !grid) return null;
    const pk = battle.partyKey ?? partyKeyOf(battle.players);
    const here = entry.serverParty.tile;
    const previousId = entry.serverParty.previousTile?.id;
    const epoch = this.content.contentEpoch;
    const candidates: RetreatCandidate[] = [];
    for (const tile of grid.getAllNeighbors(here.coord)) {
      if (!tile.isTraversable || tile.id === here.id) continue;
      if (![...entry.members].some(u => this.getSession(u)?.isTileUnlocked(tile))) continue;
      if (this.checkRoomEntry(entry.members, tile.entryRequirements)) continue;
      candidates.push({ tile, forecast: svc.get(roomForecastKey(epoch, pk, tile.id)), previous: tile.id === previousId });
    }
    const pick = pickRetreatTarget(candidates, belowPct);
    if (pick.kind === 'target') return pick.tile;
    if (pick.kind === 'none') return null;
    let queued = false;
    for (const { tile } of pick.unknown) {
      const answer = svc.request({
        key: roomForecastKey(epoch, pk, tile.id),
        priority: 'precheck',
        build: () => this.roomWork(battle.players, pk, tile.id),
      });
      if (answer.status !== 'unavailable') queued = true;
    }
    return queued ? 'wait' : null;
  }

  /** Nowhere safer to go: fight on in this room, and journal it unless that is already the latest retreat line. */
  private holdHere(entry: PartyBattleEntry): void {
    entry.retreatHold = { tileId: entry.serverParty.tile.id };
    const text = `Nowhere safer to retreat from ${this.describeLocation(entry)} — fighting on`;
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (session && session.lastLogEntryOfType('retreat')?.text !== text) session.addLogEntry(text, 'retreat');
    }
  }

  /** The timer is ending the fight as a retreat: set the route, then journal, recap and the first-time notice. */
  private applyRetreat(partyId: string, battleId: number): void {
    const entry = this.entries.get(partyId);
    const pending = entry?.pendingRetreat;
    if (!entry || !pending || pending.battleId !== battleId) return;
    entry.pendingRetreat = undefined;
    const from = this.describeLocation(entry);
    const pct = Math.round(pending.winPct);
    const at = Date.now();

    const target = pending.target && this.grids.get(entry.serverParty.currentMapId)?.getTileById(pending.target.id);
    if (pending.kind === 'relocate' && target) {
      if (entry.serverParty.hasDestination) this.recordRouteStopped(partyId, from);
      entry.serverParty.retreatTo(target);
      entry.retreatHold = { tileId: target.id };
      entry.recentSkips = [];
      const to = this.roomName(target);
      const why = pending.cause === 'skips'
        ? '(lost-cause fights kept coming up)'
        : `— ${from} was too dangerous (win chance ${pct}%)`;
      this.logToMembers(entry, `Auto-retreat moved your party from ${from} to ${to} ${why}`, 'retreat');
      this.recordRetreat(partyId, { at, kind: 'relocate', from, to, winPct: pending.winPct });
    } else {
      entry.recentSkips = [...entry.recentSkips.slice(0, -1), true];
      const names = opponentNames(entry.battleTimer.currentCombat);
      this.logToMembers(entry, `Avoided ${names} (win chance ${pct}%)`, 'retreat');
      this.recordRetreat(partyId, { at, kind: 'skip', from, winPct: pending.winPct });
    }

    for (const username of entry.members) {
      if (this.getSession(username)?.noteAutoRetreat()) {
        this.notify(username, 'auto_retreat', { title: 'Auto-retreat', body: AUTO_RETREAT_NOTICE });
      }
    }
  }

  private retreatThreshold(entry: PartyBattleEntry): number {
    return this.autoRetreatPolicy(entry.partyId)?.belowPct ?? 0;
  }

  /** A hold lasts while the party stays in its room. */
  private holdApplies(entry: PartyBattleEntry): boolean {
    const hold = entry.retreatHold;
    if (!hold) return false;
    if (hold.tileId === entry.serverParty.tile.id) return true;
    entry.retreatHold = undefined;
    return false;
  }

  private logToMembers(entry: PartyBattleEntry, text: string, type: 'retreat'): void {
    for (const username of entry.members) this.getSession(username)?.addLogEntry(text, type);
  }

  /**
   * Live-forecast messages for a socket that starts showing a fight mid-way: the latest result and
   * any re-forecast still running, else a newly queued forecast (elite, boss and raid fights only).
   */
  liveForecastResync(partyId: string): ServerForecastMessage[] {
    const entry = this.entries.get(partyId);
    if (!entry || !this.forecaster) return [];
    const timer = entry.battleTimer;
    const combat = timer.currentCombat;
    const battleId = timer.battleId;
    if (!combat || !timer.isLive || !timer.isFighting(battleId) || !isToughFight(combat)) return [];
    const live = entry.live?.battleId === battleId ? entry.live : undefined;
    const target = { kind: 'battle' as const, battleId };
    const messages: ServerForecastMessage[] = [];
    if (live?.result) messages.push({ type: 'forecast', target, key: live.result.key, result: live.result, status: 'ok' });
    if (live?.pendingKey) messages.push({ type: 'forecast', target, key: live.pendingKey, result: null, status: 'pending' });
    if (messages.length > 0) return messages;
    const queued = this.guardForecast('live resync', () => this.startLiveForecast(entry, false));
    return queued ? [queued] : [];
  }

  /**
   * Queue a forecast of the fight in progress when someone is watching it (elite, boss and raid fights
   * only). The pending notice goes to the watchers when `announce`, and is returned either way.
   */
  private startLiveForecast(entry: PartyBattleEntry, announce = true): ServerForecastMessage | null {
    const svc = this.forecaster;
    const timer = entry.battleTimer;
    const combat = timer.currentCombat;
    const battleId = timer.battleId;
    if (!svc || !combat || !timer.isFighting(battleId) || !isToughFight(combat)) return null;
    if (![...entry.members].some(u => this.delivery.isWatching(u))) return null;

    const key = liveForecastKey(battleId, combat.elapsedMs);
    const pk = this.forecastKey(entry.partyId);
    const answer = svc.request({
      key,
      priority: 'live',
      cache: false,
      supersede: { group: `live:${entry.partyId}`, previous: 'drop' },
      build: () => ({ input: { kind: 'battle', state: combat }, opts: pk ? { partyKey: pk } : undefined }),
      onDone: (result) => this.guardForecast('live forecast', () => this.deliverLiveForecast(entry, battleId, key, result)),
    });
    if (answer.status !== 'pending') return null;
    const previous = entry.live?.battleId === battleId ? entry.live.result : null;
    entry.live = { battleId, result: previous, pendingKey: key };
    const pending: ServerForecastMessage = { type: 'forecast', target: { kind: 'battle', battleId }, key, result: null, status: 'pending' };
    if (announce) this.sendToViewers(entry, pending);
    return pending;
  }

  private deliverLiveForecast(entry: PartyBattleEntry, battleId: number, key: string, result: ForecastResult | null): void {
    const live = entry.live?.battleId === battleId ? entry.live : undefined;
    if (live?.pendingKey === key) live.pendingKey = null;
    if (!result || this.entries.get(entry.partyId) !== entry) return;
    const timer = entry.battleTimer;
    const combat = timer.currentCombat;
    if (timer.battleId !== battleId || !timer.isLive || !combat || combat.finished) return;
    entry.live = { battleId, result, pendingKey: live?.pendingKey ?? null };
    this.sendToViewers(entry, { type: 'forecast', target: { kind: 'battle', battleId }, key, result, status: 'ok' });
  }

  private sendToViewers(entry: PartyBattleEntry, message: ServerForecastMessage): void {
    const payload = JSON.stringify(message);
    for (const username of entry.members) {
      if (this.delivery.isWatching(username)) this.delivery.sendRaw(username, payload, { droppable: false });
    }
  }

  /** A checkpoint or a fallen party member changes the odds: re-forecast shortly after (debounced). */
  private watchLiveForecastTriggers(partyId: string, flush: CombatFlush): void {
    if (!this.forecaster) return;
    if (!flush.events.some(e => e.kind === 'phase' || (e.kind === 'death' && e.dst?.side === 'player'))) return;
    const entry = this.entries.get(partyId);
    if (!entry || entry.liveForecastTimer || !isToughFight(flush.combat)) return;
    const battleId = flush.battleId;
    entry.liveForecastTimer = setTimeout(() => {
      entry.liveForecastTimer = undefined;
      if (this.entries.get(partyId) !== entry || entry.battleTimer.battleId !== battleId) return;
      this.guardForecast('live re-forecast', () => this.startLiveForecast(entry));
    }, LIVE_FORECAST_DEBOUNCE_MS);
  }

  // --- Dungeon runtime ---

  /**
   * Attempt to enter a dungeon with the party currently standing on its
   * entrance room. Validates entry requirements, consumes the entry item if
   * configured, and starts floor 1 — or `requester`'s stored checkpoint when it
   * is still valid. The whole party enters together.
   */
  enterDungeon(partyId: string, dungeonId: string, requester?: string): DungeonEntryResult {
    const entry = this.entries.get(partyId);
    if (!entry) return { success: false, error: 'No party.' };
    entry.battleTimer.settlePendingResult();
    if (entry.dungeonRun) return { success: false, error: 'Already in a dungeon.' };
    if (this.getPartyHenchmen(partyId).length > 0) {
      return { success: false, error: 'Dismiss your henchmen before entering.' };
    }

    const dungeon = this.content.getDungeon(dungeonId);
    if (!dungeon) return { success: false, error: 'Dungeon not found.' };

    // The party must be standing on a room linked to this dungeon.
    const tile = entry.serverParty.tile;
    const tileDef = this.content.getTileById(tile.id);
    if (tileDef?.dungeonId !== dungeonId) {
      return { success: false, error: 'You must be at the dungeon entrance.' };
    }

    const req = dungeon.entryRequirements;
    const requiredItemId = req?.requiredItemId;
    const consumes = !!req?.consumeRequiredItem;

    // Gather per-member info for the shared validator.
    const memberInfos: DungeonEntryMemberInfo[] = [];
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      const className = session.getClassName();
      if (!className) return { success: false, error: `${username} has no class yet.` };
      let hasRequiredItem = true;
      if (requiredItemId) {
        const inInventory = session.getInventoryCount(requiredItemId) >= 1;
        // Consumed items must come from inventory; otherwise equipped also counts.
        hasRequiredItem = consumes ? inInventory : (inInventory || session.hasItemEquipped(requiredItemId));
      }
      memberInfos.push({ username, level: session.getLevel(), className, hasRequiredItem });
    }

    const requiredItemName = requiredItemId ? this.content.getItem(requiredItemId)?.name : undefined;
    const reason = validateDungeonEntry(dungeon, memberInfos, requiredItemName);
    if (reason) return { success: false, error: reason };

    // Consume the entry item from every member (validation guarantees it's present).
    if (requiredItemId && consumes) {
      for (const username of entry.members) {
        this.getSession(username)?.removeOneFromInventory(requiredItemId);
      }
    }

    // Drop any in-flight overworld movement so a leftover destination can't pull
    // the party off the floor when a battle resolves.
    entry.serverParty.clearDestination();

    const entrance = cubeToOffset(entry.serverParty.position);
    const resume = requester ? this.resumeCheckpoint(requester, dungeon) : null;
    entry.dungeonRun = resume
      ? {
        dungeonId,
        currentFloorIndex: resume.floorIndex,
        entrance,
        checkpointPhase: resume.phase > 0 ? resume.phase : undefined,
        wipes: resume.wipes,
        rewardedPhases: [...resume.rewardedPhases],
      }
      : { dungeonId, currentFloorIndex: 0, entrance };

    const totalFloors = dungeon.floors.length;
    const floorNumber = entry.dungeonRun.currentFloorIndex + 1;
    const text = resume
      ? `Entered ${dungeon.name} — resuming at floor ${floorNumber} of ${totalFloors}${resume.phase > 0 ? `, checkpoint ${resume.phase}` : ''}.`
      : `Entered ${dungeon.name} — floor 1 of ${totalFloors}!`;
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      session.addLogEntry(text, 'battle');
    }
    this.recordDungeonOutcome(entry, dungeon, 'in_progress');

    // Rebuild combat from the starting floor.
    entry.battleTimer.restartBattle();
    for (const m of entry.members) this.broadcastToMember(m);
    return { success: true };
  }

  /** Voluntarily leave (bail out of) the current dungeon, returning to the entrance room. */
  leaveDungeon(partyId: string): boolean {
    const entry = this.entries.get(partyId);
    if (!entry || !entry.dungeonRun) return false;
    entry.battleTimer.settlePendingResult();

    // Settling can finish or fail the run on its own (last floor cleared, wipe).
    if (entry.dungeonRun) {
      const dungeon = this.content.getDungeon(entry.dungeonRun.dungeonId);
      const name = dungeon?.name ?? 'the dungeon';
      this.endRunByLeaving(entry, entry.dungeonRun);
      for (const username of entry.members) {
        this.getSession(username)?.addLogEntry(`Left ${name}.`, 'move');
      }
      this.exitDungeon(entry, this.resolveEntranceTile(entry));
    }
    // Mid-battle bail-out — restart so overworld combat resumes immediately.
    entry.battleTimer.restartBattle();
    for (const m of entry.members) this.broadcastToMember(m);
    return true;
  }

  /** Get the client-facing dungeon run info for the state message (null if not in a dungeon). */
  getDungeonRunInfo(partyId: string): DungeonRunInfo | null {
    const entry = this.entries.get(partyId);
    if (!entry || !entry.dungeonRun) return null;
    const dungeon = this.content.getDungeon(entry.dungeonRun.dungeonId);
    if (!dungeon) return null;
    const run = entry.dungeonRun;
    const floor = dungeon.floors[run.currentFloorIndex];
    const info: DungeonRunInfo = {
      dungeonId: run.dungeonId,
      name: dungeon.name,
      floor: run.currentFloorIndex + 1,
      totalFloors: dungeon.floors.length,
      isBossFloor: !!floor?.isBoss,
    };
    const checkpoints = floorCheckpoints(floor);
    if (checkpoints.length > 0) {
      info.checkpoints = checkpoints;
      info.checkpointPhase = clampCheckpointPhase(run.checkpointPhase, floor);
      info.wipes = run.wipes ?? 0;
      info.maxWipes = floorMaxWipes(floor);
    }
    return info;
  }

  /** Get dungeon run save data for a party (used for PlayerSession save). */
  getDungeonSaveData(partyId: string): DungeonRunState | null {
    const run = this.entries.get(partyId)?.dungeonRun;
    if (!run) return null;
    return copyRun(run);
  }

  /**
   * Restore a saved dungeon run onto an already-created battle entry (startup).
   * Validates the dungeon/floor still exist and clamps the checkpoint to the
   * floor as authored now; a running timer restarts on the saved floor.
   */
  restoreDungeonRun(partyId: string, run: DungeonRunState): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    const dungeon = this.content.getDungeon(run.dungeonId);
    // Content may have changed under us — drop the run if the dungeon/floor is gone.
    const floorIndex = run.currentFloorIndex;
    if (!dungeon || !Number.isInteger(floorIndex) || floorIndex < 0 || floorIndex >= dungeon.floors.length) return;
    entry.serverParty.clearDestination();
    entry.dungeonRun = sanitizeRun(run, dungeon.floors[floorIndex]);
    if (entry.battleTimer.isStarted) entry.battleTimer.restartBattle();
  }

  // --- Private dungeon helpers ---

  /** Resolve the entrance HexTile for a run, falling back to the party's current tile. */
  private resolveEntranceTile(entry: PartyBattleEntry): HexTile {
    if (entry.dungeonRun) {
      // The entrance is on the party's current map — a dungeon run never switches maps.
      const grid = this.grids.get(entry.serverParty.currentMapId);
      const tile = grid?.getTile(offsetToCube(entry.dungeonRun.entrance));
      if (tile) return tile;
    }
    return entry.serverParty.tile;
  }

  /**
   * End a dungeon run: clear run state and relocate the party to `toTile`.
   * Does NOT touch the battle timer — callers decide whether to restart (bail-out)
   * or let the in-flight result→next-battle cycle pick up overworld combat.
   */
  private exitDungeon(entry: PartyBattleEntry, toTile: HexTile): void {
    entry.dungeonRun = undefined;
    entry.serverParty.relocateTo(toTile);
  }


  /** Victory inside a dungeon: grant floor rewards, then advance or complete. */
  private handleDungeonFloorCleared(entry: PartyBattleEntry): void {
    const run = entry.dungeonRun;
    if (!run) return;
    const dungeon = this.content.getDungeon(run.dungeonId);
    if (!dungeon) {
      this.exitDungeon(entry, this.resolveEntranceTile(entry));
      return;
    }

    const floor = dungeon.floors[run.currentFloorIndex];

    // Bonus floor-clear rewards (per member, in addition to monster loot).
    if (floor?.rewards && floor.rewards.length > 0) {
      this.grantDungeonRewards(entry, floor.rewards, 'Floor reward');
    }

    const floorWipes = run.wipes ?? 0;
    if (floorCheckpoints(floor).length > 0) {
      run.checkpointPhase = undefined;
      run.wipes = undefined;
      for (const username of entry.members) this.getSession(username)?.clearDungeonCheckpoint(dungeon.id);
    }
    run.currentFloorIndex += 1;

    if (run.currentFloorIndex >= dungeon.floors.length) {
      // Final floor cleared — dungeon complete.
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.addLogEntry(`Cleared ${dungeon.name}!`, 'victory');
        session.clearDungeonCheckpoint(dungeon.id);
        // One-time first-clear rewards, per player.
        if (!session.hasDungeonCleared(dungeon.id)) {
          session.markDungeonCleared(dungeon.id);
          session.addAwayMoment('first_clear', `First clear of ${dungeon.name}`);
          if (dungeon.firstClearGold && dungeon.firstClearGold > 0) {
            session.grantRewardGold(dungeon.firstClearGold);
            session.addLogEntry(`First-clear bonus: +${dungeon.firstClearGold} Gold!`, 'victory');
          }
          if (dungeon.firstClearXp && dungeon.firstClearXp > 0) {
            session.grantRewardXp(dungeon.firstClearXp, `First-clear bonus: +${dungeon.firstClearXp} XP!`);
          }
          const eligibleFirstClear = (dungeon.firstClearRewards ?? []).filter(r => rewardAppliesToClass(r, session.getClassName()));
          const drops = rollDungeonRewards(eligibleFirstClear);
          for (const { itemId, quantity } of drops) {
            const itemDef = this.content.getItem(itemId);
            if (!itemDef) continue;
            for (let i = 0; i < quantity; i++) {
              if (session.grantRewardItem(itemId)) {
                session.addLogEntry(`First-clear reward: ${itemDef.name}!`, 'victory');
              }
            }
          }
        }
      }
      this.recordDungeonOutcome(entry, dungeon, 'cleared', floorWipes);
      this.exitDungeon(entry, this.resolveEntranceTile(entry));
    } else {
      const nextFloor = run.currentFloorIndex + 1;
      for (const username of entry.members) {
        this.getSession(username)?.addLogEntry(`Descending to floor ${nextFloor} of ${dungeon.floors.length}...`, 'battle');
      }
      // dungeonRun persists; the next triggerBattle builds the next floor's encounter.
    }
  }

  /**
   * Defeat inside a dungeon. On a checkpoint floor the party regroups (the next fight
   * resumes at the checkpoint) until the wipe budget runs out, then it is ejected and
   * the checkpoint is lost. Anywhere else it is ejected to the entrance room.
   */
  private handleDungeonDefeat(entry: PartyBattleEntry): void {
    const run = entry.dungeonRun;
    if (!run) return;
    const dungeon = this.content.getDungeon(run.dungeonId);
    const name = dungeon?.name ?? 'the dungeon';
    const floor = dungeon?.floors[run.currentFloorIndex];

    if (dungeon && floorCheckpoints(floor).length > 0) {
      const wipes = (run.wipes ?? 0) + 1;
      run.wipes = wipes;
      const maxWipes = floorMaxWipes(floor);
      if (wipes <= maxWipes) {
        const phase = run.checkpointPhase ?? 0;
        const left = maxWipes - wipes;
        const where = phase > 0 ? `at checkpoint ${phase}` : 'for another attempt';
        const retries = left === 0 ? 'no retries' : `${left} ${left === 1 ? 'retry' : 'retries'}`;
        const text = `Your party regroups ${where} — ${retries} left.`;
        for (const username of entry.members) this.getSession(username)?.addLogEntry(text, 'checkpoint');
        this.recordDungeonOutcome(entry, dungeon, 'in_progress');
        return;
      }
      this.recordDungeonOutcome(entry, dungeon, 'ejected');
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.addLogEntry('The boss recovers — your checkpoint is lost.', 'defeat');
        session.clearDungeonCheckpoint(dungeon.id);
        session.addAwayMoment('eject', `Driven out of ${name} — the checkpoint was lost`);
      }
      this.exitDungeon(entry, this.resolveEntranceTile(entry));
      return;
    }

    if (dungeon) this.recordDungeonOutcome(entry, dungeon, 'ejected');
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      session.addLogEntry(`Wiped in ${name} — driven back to the entrance.`, 'defeat');
      session.addAwayMoment('eject', `Driven out of ${name}`);
    }
    this.exitDungeon(entry, this.resolveEntranceTile(entry));
  }

  /** Called from the battle step the moment the boss crosses a checkpoint, so a restart can't lose it. */
  private handleBossPhase(partyId: string, battleId: number, phase: number): void {
    const entry = this.entries.get(partyId);
    const run = entry?.dungeonRun;
    if (!entry || !run || entry.battleTimer.battleId !== battleId) return;
    const dungeon = this.content.getDungeon(run.dungeonId);
    const floor = dungeon?.floors[run.currentFloorIndex];
    const total = floorCheckpoints(floor).length;
    if (!dungeon || !floor || total === 0) return;

    const reached = Math.min(Math.floor(phase), total);
    const previous = run.checkpointPhase ?? 0;
    if (!(reached > previous)) return;
    run.checkpointPhase = reached;
    for (let k = previous + 1; k <= reached; k++) this.payCheckpoint(entry, run, floor, k);

    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      session.addLogEntry(`Checkpoint ${reached} of ${total} reached in ${dungeon.name} — progress saved.`, 'checkpoint');
      session.addAwayMoment('checkpoint', `Reached checkpoint ${reached} of ${total} in ${dungeon.name}`);
    }
    this.recordDungeonOutcome(entry, dungeon, 'in_progress');
    for (const m of entry.members) this.broadcastToMember(m);
  }

  /** A share of the bosses' XP and average gold, split like a kill, paid once per run per checkpoint. */
  private payCheckpoint(entry: PartyBattleEntry, run: DungeonRunState, floor: DungeonFloor, phase: number): void {
    const key = checkpointPhaseKey(run.currentFloorIndex, phase);
    const rewarded = run.rewardedPhases ?? [];
    if (rewarded.includes(key)) return;
    run.rewardedPhases = [...rewarded, key];

    const combat = entry.battleTimer.currentCombat;
    const bosses = (combat?.bossPhases?.bossIndices ?? [])
      .map(i => combat?.monsters[i])
      .filter((m): m is CombatMonster => !!m);
    if (bosses.length === 0) return;

    const fraction = floorCheckpointRewardFraction(floor);
    const members = [...entry.members];
    const xpMultiplier = this.partyXpMultiplier(members);
    let averageGold = 0;
    for (const boss of bosses) {
      const def = this.content.getMonster(boss.id);
      const avg = def ? (def.goldMin + def.goldMax) / 2 : 0;
      if (Number.isFinite(avg) && avg > 0) averageGold += avg;
    }
    const gold = Math.floor((averageGold * fraction) / members.length);

    for (const username of members) {
      const session = this.getSession(username);
      if (!session) continue;
      const xp = Math.floor((this.memberXp(bosses, session.getLevel()) * xpMultiplier * fraction) / members.length);
      const goldAdded = session.grantRewardGold(gold);
      const parts = [xp > 0 ? `+${xp} XP` : '', goldAdded > 0 ? `+${goldAdded} Gold` : ''].filter(Boolean);
      if (parts.length === 0) continue;
      const text = `Checkpoint ${phase} reward: ${parts.join(', ')}`;
      if (xp > 0) session.grantRewardXp(xp, text, 'checkpoint');
      else session.addLogEntry(text, 'checkpoint');
    }
  }

  /** Leaving mid-run (Leave, forced relocation): progress on a checkpoint floor is stored on every member. */
  private endRunByLeaving(entry: PartyBattleEntry, run: DungeonRunState): void {
    const dungeon = this.content.getDungeon(run.dungeonId);
    if (!dungeon) return;
    const floor = dungeon.floors[run.currentFloorIndex];
    if (floorCheckpoints(floor).length > 0) {
      const checkpoint: DungeonCheckpoint = {
        floorIndex: run.currentFloorIndex,
        phase: clampCheckpointPhase(run.checkpointPhase, floor),
        wipes: run.wipes ?? 0,
        rewardedPhases: [...(run.rewardedPhases ?? [])],
        at: Date.now(),
      };
      const text = `Progress saved: floor ${checkpoint.floorIndex + 1}${checkpoint.phase > 0 ? ` · checkpoint ${checkpoint.phase}` : ''}.`;
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.setDungeonCheckpoint(dungeon.id, checkpoint);
        session.addLogEntry(text, 'checkpoint');
      }
    }
    this.recordDungeonOutcome(entry, dungeon, 'left');
  }

  /**
   * `username`'s stored checkpoint for this dungeon, validated and clamped against the dungeon as
   * authored now. A stale or no-longer-valid checkpoint is deleted and the run starts fresh.
   */
  private resumeCheckpoint(username: string, dungeon: DungeonDefinition): DungeonCheckpoint | null {
    const session = this.getSession(username);
    const checkpoint = session?.getDungeonCheckpoint(dungeon.id);
    if (!session || !checkpoint) return null;
    const usable = this.usableCheckpoint(checkpoint, dungeon);
    if (!usable) session.clearDungeonCheckpoint(dungeon.id);
    return usable;
  }

  /** A stored checkpoint clamped to the dungeon as authored now, or null when it can no longer be resumed. */
  private usableCheckpoint(checkpoint: DungeonCheckpoint | undefined, dungeon: DungeonDefinition): DungeonCheckpoint | null {
    if (!checkpoint) return null;
    const floor = Number.isInteger(checkpoint.floorIndex) ? dungeon.floors[checkpoint.floorIndex] : undefined;
    const valid = !!floor
      && isDungeonCheckpointFresh(checkpoint, Date.now())
      && floorCheckpoints(floor).length > 0
      && this.floorHasBoss(floor);
    if (!valid) return null;
    return {
      ...checkpoint,
      phase: clampCheckpointPhase(checkpoint.phase, floor),
      wipes: Number.isInteger(checkpoint.wipes) && checkpoint.wipes > 0 ? checkpoint.wipes : 0,
    };
  }

  /** Whether any encounter on the floor's table can field a boss- or raid-tier monster. */
  private floorHasBoss(floor: DungeonFloor): boolean {
    const encounters = this.content.getAllEncounters();
    return floor.encounterTable.some(({ encounterId }) => {
      const encounter = encounters[encounterId];
      if (!encounter) return false;
      const ids = encounter.type === 'explicit'
        ? (encounter.placements ?? []).map(p => p.monsterId)
        : (encounter.monsterPool ?? []).map(p => p.monsterId);
      return ids.some(id => {
        const def = this.content.getMonster(id);
        return !!def && isBossTier(effectiveMonsterTier(def));
      });
    });
  }

  private recordDungeonOutcome(
    entry: PartyBattleEntry,
    dungeon: DungeonDefinition,
    outcome: AwayDungeonOutcome,
    wipes: number = entry.dungeonRun?.wipes ?? 0,
  ): void {
    const phase = entry.dungeonRun?.checkpointPhase;
    const record = { dungeonId: dungeon.id, name: dungeon.name, outcome, wipes, ...(phase ? { checkpoint: phase } : {}) };
    for (const username of entry.members) this.getSession(username)?.recordAway(l => recordAwayDungeon(l, record));
  }

  /** Roll a reward table once per member (respecting per-reward class restrictions) and grant the results. */
  private grantDungeonRewards(entry: PartyBattleEntry, rewards: DungeonReward[], label: string): void {
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      const className = session.getClassName();
      const eligible = rewards.filter(r => rewardAppliesToClass(r, className));
      const drops = rollDungeonRewards(eligible);
      for (const { itemId, quantity } of drops) {
        const itemDef = this.content.getItem(itemId);
        if (!itemDef) continue;
        for (let i = 0; i < quantity; i++) {
          if (session.grantRewardItem(itemId)) {
            session.addLogEntry(`${label}: ${itemDef.name}!`, 'victory');
          }
        }
      }
    }
  }
}

function copyRun(run: DungeonRunState): DungeonRunState {
  const copy: DungeonRunState = { ...run, entrance: { ...run.entrance } };
  if (run.rewardedPhases) copy.rewardedPhases = [...run.rewardedPhases];
  return copy;
}

/** A saved run made safe for the floor as authored now: checkpoint clamped, counters sane. */
function sanitizeRun(run: DungeonRunState, floor: DungeonFloor): DungeonRunState {
  const { checkpointPhase, wipes, rewardedPhases, ...rest } = run;
  const clean: DungeonRunState = { ...rest, entrance: { col: run.entrance.col, row: run.entrance.row } };
  const phase = clampCheckpointPhase(checkpointPhase, floor);
  if (phase > 0) clean.checkpointPhase = phase;
  if (typeof wipes === 'number' && Number.isInteger(wipes) && wipes > 0) clean.wipes = wipes;
  if (Array.isArray(rewardedPhases)) clean.rewardedPhases = rewardedPhases.filter((k): k is string => typeof k === 'string');
  return clean;
}

/** A fight worth a live forecast: it has an elite, boss or raid monster. */
function isToughFight(combat: PartyCombatState): boolean {
  return combat.monsters.some(m => !m.passive && (m.tier ?? 'trash') !== 'trash');
}

function opponentNames(combat: PartyCombatState | null): string {
  const names = [...new Set((combat?.monsters ?? []).filter(m => !m.passive).map(m => m.name))];
  return names.length > 0 ? names.slice(0, 3).join(', ') : 'the enemy';
}

/** Roll an encounter from `table` and report the entry it came from ('' when the fallback pack was used). */
function rollEncounter(
  zoneId: string,
  monsters: Record<string, MonsterDefinition>,
  zones: Record<string, ZoneDefinition>,
  encounters: Record<string, EncounterDefinition>,
  table: EncounterTableEntry[],
): { monsters: MonsterInstance[]; entryId: string } {
  const first: { roll: number | null } = { roll: null };
  const rng = (): number => {
    const r = Math.random();
    // createEncounter's first draw is its table pick; replaying it names the entry without an extra draw.
    if (first.roll === null) first.roll = r;
    return r;
  };
  const rolled = createEncounter(zoneId, monsters, zones, encounters, table, rng);
  const roll = first.roll;
  const entryId = table.length > 0 && roll !== null ? pickWeightedEncounter(table, () => roll).encounterId : '';
  return { monsters: rolled, entryId };
}
