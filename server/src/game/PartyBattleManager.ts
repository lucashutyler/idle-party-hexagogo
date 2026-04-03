import {
  HexGrid,
  HexTile,
  offsetToCube,
  cubeToOffset,
  createPartyCombatState,
  createEncounter,
  getZone,
  rollDrops,
  getSkillById,
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
import type { ContentStore } from './ContentStore.js';

interface PartyBattleEntry {
  partyId: string;
  serverParty: ServerParty;
  battleTimer: ServerBattleTimer;
  members: Set<string>;
}

export class PartyBattleManager {
  private entries = new Map<string, PartyBattleEntry>();
  private grid: HexGrid;
  private content: ContentStore;
  private getSession: (username: string) => PlayerSession | undefined;
  private broadcastToMember: (username: string) => void;
  private onMembersMoved?: (members: ReadonlySet<string>) => void;

  constructor(
    grid: HexGrid,
    content: ContentStore,
    getSession: (username: string) => PlayerSession | undefined,
    broadcastToMember: (username: string) => void,
    onMembersMoved?: (members: ReadonlySet<string>) => void,
  ) {
    this.grid = grid;
    this.content = content;
    this.getSession = getSession;
    this.broadcastToMember = broadcastToMember;
    this.onMembersMoved = onMembersMoved;
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
              const allZones = this.content.getAllZones();
              const zone = getZone(serverParty.tile.zone, allZones);
              const zName = zone ? zone.displayName : serverParty.tile.zone;
              const tileDef = this.content.getTileById(serverParty.tile.id);
              const rName = tileDef?.name ?? '';
              s.addLogEntry(`Moved to ${zName}${rName ? `, ${rName}` : ''}`, 'move');
            }
          }
          this.onMembersMoved?.(members);
        },
        canMoveToNextTile: () => {
          const nextTile = serverParty.nextTile;
          if (!nextTile) return false;
          // Check item requirements — ALL members must have the required item
          const requiredItemId = nextTile.requiredItemId;
          if (requiredItemId) {
            for (const m of members) {
              const s = this.getSession(m);
              if (!s || !s.hasItemEquipped(requiredItemId)) return false;
            }
          }
          // Check if at least one member has the next tile unlocked
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
              const allZones = this.content.getAllZones();
              const zone = getZone(serverParty.tile.zone, allZones);
              const zName = zone ? zone.displayName : serverParty.tile.zone;
              const tileDef = this.content.getTileById(serverParty.tile.id);
              const rName = tileDef?.name ?? '';
              s.addLogEntry(`Moved to ${zName}${rName ? `, ${rName}` : ''}`, 'move');
            }
          }
          this.onMembersMoved?.(members);
        },
        canMoveToNextTile: () => {
          const nextTile = serverParty.nextTile;
          if (!nextTile) return false;
          // Check item requirements — ALL members must have the required item
          const requiredItemId = nextTile.requiredItemId;
          if (requiredItemId) {
            for (const m of members) {
              const s = this.getSession(m);
              if (!s || !s.hasItemEquipped(requiredItemId)) return false;
            }
          }
          // Check if at least one member has the next tile unlocked
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

  /** Restart the current battle for a party (e.g., after a member changes class). */
  restartBattle(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.restartBattle();
  }

  /** Escape the current battle for a party. No rewards given. */
  escapeBattle(partyId: string): boolean {
    const entry = this.entries.get(partyId);
    if (!entry) return false;
    if (entry.battleTimer.currentState !== 'battle') return false;

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

  /** Destroy a party battle entry and stop its timers. */
  destroyEntry(partyId: string): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.battleTimer.destroy();
    this.entries.delete(partyId);
  }

  /** Handle move request. Returns a result with missing-item info if the path is blocked. */
  handleMove(partyId: string, col: number, row: number): { success: true } | { success: false; missingItemId?: string; missingPlayers?: string[] } {
    const entry = this.entries.get(partyId);
    if (!entry) return { success: false };

    const coord = offsetToCube({ col, row });
    const tile = this.grid.getTile(coord);
    if (!tile || !tile.isTraversable) return { success: false };

    const success = entry.serverParty.setDestination(tile);
    if (!success) return { success: false };

    // Validate item requirements for every tile in the path
    const pathCheck = this.validatePathItemRequirements(entry);
    if (!pathCheck.valid) {
      entry.serverParty.clearDestination();
      return { success: false, missingItemId: pathCheck.missingItemId, missingPlayers: pathCheck.missingPlayers };
    }

    for (const m of entry.members) {
      this.broadcastToMember(m);
    }
    return { success: true };
  }

  /** Check every tile in the path for required items. All party members must have each required item equipped. */
  private validatePathItemRequirements(entry: PartyBattleEntry): { valid: true } | { valid: false; missingItemId: string; missingPlayers: string[] } {
    for (const tile of entry.serverParty.remainingPath) {
      const requiredItemId = tile.requiredItemId;
      if (!requiredItemId) continue;

      const missingPlayers: string[] = [];
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session || !session.hasItemEquipped(requiredItemId)) {
          missingPlayers.push(username);
        }
      }
      if (missingPlayers.length > 0) {
        return { valid: false, missingItemId: requiredItemId, missingPlayers };
      }
    }
    return { valid: true };
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

    const combat = entry.battleTimer.currentCombat;
    const clientCombat: ClientCombatState | undefined = combat ? {
      players: combat.players.map(p => ({
        username: p.username,
        currentHp: p.currentHp,
        maxHp: p.maxHp,
        gridPosition: p.gridPosition,
        className: p.className,
        stunTurns: p.stunTurns > 0 ? p.stunTurns : undefined,
      })),
      monsters: combat.monsters.map(m => ({
        name: m.name,
        currentHp: m.currentHp,
        maxHp: m.maxHp,
        gridPosition: m.gridPosition,
        stunTurns: m.stunTurns > 0 ? m.stunTurns : undefined,
      })),
      tickCount: combat.tickCount,
      roundCount: combat.roundCount,
      lastAction: combat.lastAction ? {
        attackerSide: combat.lastAction.attackerSide,
        attackerPos: combat.lastAction.attackerPos,
        targetPos: combat.lastAction.targetPos,
        targetSide: combat.lastAction.targetSide,
        dodged: combat.lastAction.dodged,
        skillName: combat.lastAction.skillName,
        stunApplied: combat.lastAction.stunApplied,
        healAmount: combat.lastAction.healAmount,
        healTarget: combat.lastAction.healTarget,
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

  /** Get all party IDs. */
  getAllPartyIds(): string[] {
    return Array.from(this.entries.keys());
  }

  /** Get members of a party. */
  getMembers(partyId: string): Set<string> | undefined {
    return this.entries.get(partyId)?.members;
  }

  /** Relocate a party to a new tile, restarting its battle. */
  relocateParty(partyId: string, newTile: HexTile): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;
    entry.serverParty.relocateTo(newTile);
    entry.battleTimer.restartBattle();
  }

  /**
   * After a grid rebuild, re-resolve all parties' tile references.
   * The grid object is the same but tiles inside it are new instances.
   */
  refreshAllPartyTiles(grid: HexGrid): void {
    for (const entry of this.entries.values()) {
      const pos = cubeToOffset(entry.serverParty.position);
      const coord = offsetToCube(pos);
      const freshTile = grid.getTile(coord);
      if (freshTile) {
        // Re-set to the same position but with fresh tile reference
        entry.serverParty.relocateTo(freshTile);
      }
    }
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

    const players: PartyCombatant[] = [];
    for (const username of entry.members) {
      const session = this.getSession(username);
      if (!session) continue;
      const info = session.getCombatInfo();
      players.push(info);
    }

    const zone = entry.serverParty.tile.zone;
    const tileId = entry.serverParty.tile.id;
    const tileDef = this.content.getTileById(tileId);
    const monsters = createEncounter(zone, allMonsters, allZones, allEncounters, tileDef?.encounterTable);

    return createPartyCombatState(players, monsters);
  }

  private handleBattleEnd(partyId: string, result: BattleResult): void {
    const entry = this.entries.get(partyId);
    if (!entry) return;

    if (result === 'victory') {
      const combat = entry.battleTimer.currentCombat;
      const members = Array.from(entry.members);
      const partySize = members.length;

      // Compute total XP and gold once, then split
      const totalXp = combat
        ? combat.monsters.reduce((sum, m) => sum + m.xp, 0)
        : 10;
      let totalGold = 0;
      if (combat) {
        for (const m of combat.monsters) {
          const def = this.content.getMonster(m.id);
          if (def) {
            totalGold += def.goldMin + Math.floor(Math.random() * (def.goldMax - def.goldMin + 1));
          }
        }
      }

      // Check for Bard Inspiration XP bonus (+20% per Bard with Inspiration equipped)
      let xpMultiplier = 1;
      for (const username of members) {
        const session = this.getSession(username);
        if (!session) continue;
        const loadout = session.getSkillLoadout();
        if (loadout) {
          for (const skillId of loadout.equippedSkills) {
            if (!skillId) continue;
            const skill = getSkillById(skillId);
            if (skill && skill.passiveEffect?.kind === 'xp_bonus') {
              xpMultiplier += skill.passiveEffect.flatValue ?? 0;
            }
          }
        }
      }

      const splitXp = Math.ceil((totalXp * xpMultiplier) / partySize);
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
                  return s && itemDef.classRestriction!.includes(s.getClassName());
                });
                if (matching.length > 0) eligible = matching;
              }
              const recipient = eligible[Math.floor(Math.random() * eligible.length)];
              memberItems.get(recipient)!.push(itemId);
            }
          }
        }
      }

      for (const username of members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.handleVictory(
          { xp: splitXp, gold: splitGold, items: memberItems.get(username)! },
          entry.serverParty.tile,
        );
      }
    } else {
      for (const username of entry.members) {
        const session = this.getSession(username);
        if (!session) continue;
        session.addLogEntry('Defeat...', 'defeat');
      }
    }

    for (const m of entry.members) {
      this.broadcastToMember(m);
    }
  }
}
