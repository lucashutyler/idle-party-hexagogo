import {
  HexGrid,
  HexTile,
  offsetToCube,
  cubeToOffset,
  createPartyCombatState,
  createEncounter,
  getZone,
} from '@idle-party-rpg/shared';
import type {
  BattleResult,
  PartyCombatant,
  PartyCombatState,
  ServerPartyState,
  ServerBattleState,
  ClientCombatState,
} from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';
import { ServerBattleTimer } from './ServerBattleTimer.js';
import type { PlayerSession } from './PlayerSession.js';

interface PartyBattleEntry {
  partyId: string;
  serverParty: ServerParty;
  battleTimer: ServerBattleTimer;
  members: Set<string>;
}

export class PartyBattleManager {
  private entries = new Map<string, PartyBattleEntry>();
  private grid: HexGrid;
  private getSession: (username: string) => PlayerSession | undefined;
  private broadcastToMember: (username: string) => void;

  constructor(
    grid: HexGrid,
    getSession: (username: string) => PlayerSession | undefined,
    broadcastToMember: (username: string) => void,
  ) {
    this.grid = grid;
    this.getSession = getSession;
    this.broadcastToMember = broadcastToMember;
  }

  /** Create a party battle entry. Called when a party is created or on restore. */
  createEntry(partyId: string, username: string, startTile: HexTile): void {
    if (this.entries.has(partyId)) return;

    const serverParty = new ServerParty(this.grid, startTile);
    const members = new Set([username]);

    const battleTimer = new ServerBattleTimer(
      serverParty,
      () => this.createCombatForParty(partyId),
      {
        onBattleStart: () => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              s.incrementBattleCount();
              s.addLogEntry('Battle begins!', 'battle');
            }
          }
        },
        onStateChange: () => {
          for (const m of members) {
            this.broadcastToMember(m);
          }
        },
        onCombatTick: (_state: PartyCombatState, logEntries: string[]) => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              for (const entry of logEntries) {
                s.addLogEntry(entry, 'damage');
              }
            }
          }
          for (const m of members) {
            this.broadcastToMember(m);
          }
        },
        onBattleEnd: (result: BattleResult) => {
          this.handleBattleEnd(partyId, result);
        },
        onMove: () => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              const pos = cubeToOffset(serverParty.position);
              const zone = getZone(serverParty.tile.zone);
              const zName = zone ? zone.displayName : serverParty.tile.zone;
              s.addLogEntry(`Moved to ${zName} (${pos.col}, ${pos.row})`, 'move');
            }
          }
        },
        canMoveToNextTile: () => {
          // Check if at least one member has the next tile unlocked
          const nextTile = serverParty.nextTile;
          if (!nextTile) return false;
          for (const m of members) {
            const s = this.getSession(m);
            if (s && s.isTileUnlocked(nextTile)) return true;
          }
          return false;
        },
      },
    );

    this.entries.set(partyId, { partyId, serverParty, battleTimer, members });
  }

  /** Create a party battle entry from saved movement state (for restoring). */
  createEntryFromSave(
    partyId: string,
    username: string,
    currentTile: HexTile,
    targetTile: HexTile | null,
    movementQueue: HexTile[],
  ): void {
    if (this.entries.has(partyId)) return;

    const serverParty = ServerParty.restore(this.grid, currentTile, targetTile, movementQueue);
    const members = new Set([username]);

    const battleTimer = new ServerBattleTimer(
      serverParty,
      () => this.createCombatForParty(partyId),
      {
        onBattleStart: () => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              s.incrementBattleCount();
              s.addLogEntry('Battle begins!', 'battle');
            }
          }
        },
        onStateChange: () => {
          for (const m of members) {
            this.broadcastToMember(m);
          }
        },
        onCombatTick: (_state: PartyCombatState, logEntries: string[]) => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              for (const entry of logEntries) {
                s.addLogEntry(entry, 'damage');
              }
            }
          }
          for (const m of members) {
            this.broadcastToMember(m);
          }
        },
        onBattleEnd: (result: BattleResult) => {
          this.handleBattleEnd(partyId, result);
        },
        onMove: () => {
          for (const m of members) {
            const s = this.getSession(m);
            if (s) {
              const pos = cubeToOffset(serverParty.position);
              const zone = getZone(serverParty.tile.zone);
              const zName = zone ? zone.displayName : serverParty.tile.zone;
              s.addLogEntry(`Moved to ${zName} (${pos.col}, ${pos.row})`, 'move');
            }
          }
        },
        canMoveToNextTile: () => {
          const nextTile = serverParty.nextTile;
          if (!nextTile) return false;
          for (const m of members) {
            const s = this.getSession(m);
            if (s && s.isTileUnlocked(nextTile)) return true;
          }
          return false;
        },
      },
    );

    this.entries.set(partyId, { partyId, serverParty, battleTimer, members });
  }

  /** Add a member to an existing party battle. They join the next combat cycle. */
  addMember(partyId: string, username: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.members.add(username);
  }

  /** Remove a member from a party battle. Does not create a new solo entry — caller should do that. */
  removeMember(partyId: string, username: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.members.delete(username);

    if (entry.members.size === 0) {
      this.destroyEntry(partyId);
    }
  }

  /** Destroy a party battle entry and stop its timers. */
  destroyEntry(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.destroy();
    this.entries.delete(partyId);
  }

  /** Handle move request. */
  handleMove(partyId: string, col: number, row: number): boolean {
    const entry = this.entries.get(partyId);
    if (!entry) return false;

    const coord = offsetToCube({ col, row });
    const tile = this.grid.getTile(coord);
    if (!tile || !tile.isTraversable) return false;

    const success = entry.serverParty.setDestination(tile);
    if (success) {
      for (const m of entry.members) {
        this.broadcastToMember(m);
      }
    }
    return success;
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

    const combat = entry.battleTimer.currentCombat;
    const clientCombat: ClientCombatState | undefined = combat ? {
      players: combat.players.map(p => ({
        username: p.username,
        currentHp: p.currentHp,
        maxHp: p.maxHp,
        gridPosition: p.gridPosition,
      })),
      monsters: combat.monsters.map(m => ({
        name: m.name,
        currentHp: m.currentHp,
        maxHp: m.maxHp,
        level: m.level,
        gridPosition: m.gridPosition,
      })),
      tickCount: combat.tickCount,
      lastAction: combat.lastAction ? {
        attackerSide: combat.lastAction.attackerSide,
        attackerPos: combat.lastAction.attackerPos,
        targetPos: combat.lastAction.targetPos,
        targetSide: combat.lastAction.targetSide,
        dodged: combat.lastAction.dodged,
      } : undefined,
    } : undefined;

    return {
      state: entry.battleTimer.currentState,
      result: entry.battleTimer.lastResult,
      visual: entry.battleTimer.visual,
      duration: entry.battleTimer.currentDuration,
      combat: clientCombat,
    };
  }

  /** Get movement save data for a party (used for PlayerSession save). */
  getMovementSaveData(partyId: string): {
    position: { col: number; row: number };
    target: { col: number; row: number } | null;
    movementQueue: { col: number; row: number }[];
  } | null {
    const entry = this.entries.get(partyId);
    if (!entry) return null;
    const json = entry.serverParty.toJSON();
    return {
      position: { col: json.col, row: json.row },
      target: json.targetCol !== undefined && json.targetRow !== undefined
        ? { col: json.targetCol, row: json.targetRow }
        : null,
      movementQueue: json.path,
    };
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

  // --- Private ---

  private createCombatForParty(partyId: string): PartyCombatState {
    const entry = this.entries.get(partyId);
    if (!entry) {
      // Fallback: empty combat
      return createPartyCombatState([], createEncounter());
    }

    const players: PartyCombatant[] = [];
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      const info = session.getCombatInfo();
      players.push(info);
    }

    const zone = entry.serverParty.tile.zone;
    const monsters = createEncounter(zone);

    return createPartyCombatState(players, monsters);
  }

  private handleBattleEnd(partyId: string, result: BattleResult): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;

    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;

      if (result === 'victory') {
        session.handleVictory(entry.battleTimer.currentCombat, entry.serverParty.tile);
      } else {
        session.addLogEntry('Defeat...', 'defeat');
      }
    }

    for (const m of entry.members) {
      this.broadcastToMember(m);
    }
  }
}
