import {
  HexGrid,
  UnlockSystem,
  getStartingPosition,
  offsetToCube,
  cubeToOffset,
  createDefaultCharacter,
  addXp,
  addGold,
  calculateMaxHp,
  xpForNextLevel,
  XP_PER_VICTORY,
  MONSTERS,
  ITEMS,
  createCombatState,
  createEncounter,
  getZone,
  computeEquipmentBonuses,
  rollDrops,
  addItemToInventory,
  equipItem,
  unequipItem,
  EQUIP_SLOTS,
} from '@idle-party-rpg/shared';
import type {
  BattleResult,
  ServerStateMessage,
  OtherPlayerState,
  CombatLogEntry,
  CharacterState,
  StatName,
  CombatState,
  ClientCharacterState,
  ClientCombatState,
  EquipSlot,
} from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty.js';
import { ServerBattleTimer } from './ServerBattleTimer.js';
import type { ServerBattleCallbacks } from './ServerBattleTimer.js';
import type { PlayerSaveData } from './GameStateStore.js';

const MAX_LOG_ENTRIES = 100;
const MAX_SAVE_LOG_ENTRIES = 1000;

export class PlayerSession {
  username: string;
  private grid: HexGrid;
  private party: ServerParty;
  private battleTimer: ServerBattleTimer;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private battleCount = 0;
  private character: CharacterState;

  private broadcastToPlayer: () => void;

  constructor(username: string, grid: HexGrid, broadcastToPlayer: () => void) {
    this.username = username;
    this.grid = grid;
    this.broadcastToPlayer = broadcastToPlayer;

    const startPos = getStartingPosition();
    const startCoord = offsetToCube(startPos);
    const startTile = this.grid.getTile(startCoord);

    if (!startTile) {
      throw new Error('Invalid starting position');
    }

    this.character = createDefaultCharacter();
    this.unlockSystem = new UnlockSystem(this.grid, startTile);
    this.party = new ServerParty(this.grid, startTile);

    this.battleTimer = new ServerBattleTimer(
      this.party,
      () => this.createCombat(),
      this.createBattleCallbacks(),
    );
  }

  private createCombat(): CombatState {
    const maxHp = calculateMaxHp(this.character.level, this.character.stats.CON);
    const equipBonuses = computeEquipmentBonuses(this.character.equipment);
    return createCombatState(
      this.username,
      this.character.level,
      this.character.stats,
      maxHp,
      createEncounter(this.party.tile.zone),
      equipBonuses,
    );
  }

  private createBattleCallbacks(): ServerBattleCallbacks {
    return {
      onBattleStart: () => {
        this.battleCount++;
        this.addLogEntry(`Battle #${this.battleCount} begins!`, 'battle');
      },
      onStateChange: () => {
        this.broadcastToPlayer();
      },
      onCombatTick: (_state: CombatState, logEntries: string[]) => {
        for (const entry of logEntries) {
          this.addLogEntry(entry, 'damage');
        }
        this.broadcastToPlayer();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          this.addLogEntry('Victory!', 'victory');
          const unlocked = this.unlockSystem.unlockAdjacentTiles(this.party.tile);
          if (unlocked.length > 0) {
            this.addLogEntry(`${unlocked.length} new tile${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
          }
          // Award XP based on monsters defeated
          const combat = this.battleTimer.currentCombat;
          const xpGained = combat
            ? combat.monsters.reduce((sum, m) => sum + m.xp, 0)
            : XP_PER_VICTORY;
          // Award gold based on monsters defeated
          let goldGained = 0;
          if (combat) {
            for (const m of combat.monsters) {
              const def = MONSTERS[m.id];
              if (def) {
                goldGained += def.goldMin + Math.floor(Math.random() * (def.goldMax - def.goldMin + 1));
              }
            }
          }
          if (goldGained > 0) {
            addGold(this.character, goldGained);
            this.addLogEntry(`+${goldGained} Gold`, 'victory');
          }

          // Roll item drops per monster
          if (combat) {
            for (const m of combat.monsters) {
              const def = MONSTERS[m.id];
              if (def?.drops) {
                const dropped = rollDrops(def.drops);
                for (const itemId of dropped) {
                  const itemDef = ITEMS[itemId];
                  if (itemDef && addItemToInventory(this.character.inventory, itemId)) {
                    this.addLogEntry(`Found ${itemDef.name}!`, 'victory');
                  }
                }
              }
            }
          }

          const { leveledUp, levelsGained } = addXp(this.character, xpGained);
          this.addLogEntry(`+${xpGained} XP`, 'victory');
          if (leveledUp) {
            for (let i = 0; i < levelsGained; i++) {
              this.addLogEntry(`Level up! Now level ${this.character.level - levelsGained + i + 1}!`, 'levelup');
            }
          }
        } else {
          this.addLogEntry('Defeat...', 'defeat');
        }
        this.broadcastToPlayer();
      },
      onMove: () => {
        const pos = this.getPosition();
        const zone = getZone(this.party.tile.zone);
        const zName = zone ? zone.displayName : this.party.tile.zone;
        this.addLogEntry(`Moved to ${zName} (${pos.col}, ${pos.row})`, 'move');
      },
      canMoveToNextTile: () => {
        const nextTile = this.party.nextTile;
        return nextTile ? this.unlockSystem.isUnlocked(nextTile) : false;
      },
    };
  }

  handleMove(col: number, row: number): boolean {
    const coord = offsetToCube({ col, row });
    const tile = this.grid.getTile(coord);

    if (!tile || !tile.isTraversable) {
      return false;
    }

    const success = this.party.setDestination(tile);
    this.broadcastToPlayer();
    return success;
  }

  setPriorityStat(stat: StatName | null): void {
    this.character.priorityStat = stat;
    this.broadcastToPlayer();
  }

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type'> {
    const combat = this.battleTimer.currentCombat;
    const clientCombat: ClientCombatState | undefined = combat ? {
      playerHp: combat.player.currentHp,
      playerMaxHp: combat.player.maxHp,
      monsters: combat.monsters.map(m => ({
        name: m.name,
        currentHp: m.currentHp,
        maxHp: m.maxHp,
        level: m.level,
      })),
      tickCount: combat.tickCount,
    } : undefined;

    const charState: ClientCharacterState = {
      className: this.character.className,
      level: this.character.level,
      xp: this.character.xp,
      xpForNextLevel: xpForNextLevel(this.character.level),
      maxHp: calculateMaxHp(this.character.level, this.character.stats.CON),
      gold: this.character.gold,
      stats: { ...this.character.stats },
      priorityStat: this.character.priorityStat,
      inventory: { ...this.character.inventory },
      equipment: { ...this.character.equipment },
    };

    const zone = getZone(this.party.tile.zone);
    const zoneName = zone ? zone.displayName : this.party.tile.zone;

    return {
      party: this.party.toJSON(),
      battle: {
        state: this.battleTimer.currentState,
        result: this.battleTimer.lastResult,
        visual: this.battleTimer.visual,
        duration: this.battleTimer.currentDuration,
        combat: clientCombat,
      },
      unlocked: this.unlockSystem.getUnlockedKeys(),
      mapSize: this.grid.size,
      otherPlayers,
      combatLog: this.combatLog,
      battleCount: this.battleCount,
      character: charState,
      zoneName,
    };
  }

  getPosition(): { col: number; row: number } {
    return cubeToOffset(this.party.position);
  }

  addLogEntry(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ text, type });
    if (this.combatLog.length > MAX_LOG_ENTRIES) {
      this.combatLog.shift();
    }
  }

  toSaveData(): PlayerSaveData {
    const pos = this.getPosition();
    const partyJSON = this.party.toJSON();

    return {
      username: this.username,
      battleCount: this.battleCount,
      combatLog: this.combatLog.slice(-MAX_SAVE_LOG_ENTRIES),
      unlockedKeys: this.unlockSystem.getUnlockedKeys(),
      position: { col: pos.col, row: pos.row },
      target: partyJSON.targetCol !== undefined && partyJSON.targetRow !== undefined
        ? { col: partyJSON.targetCol, row: partyJSON.targetRow }
        : null,
      movementQueue: partyJSON.path,
      character: {
        className: this.character.className,
        level: this.character.level,
        xp: this.character.xp,
        gold: this.character.gold,
        stats: { ...this.character.stats },
        priorityStat: this.character.priorityStat,
        inventory: { ...this.character.inventory },
        equipment: { ...this.character.equipment },
      },
    };
  }

  /**
   * Restore a PlayerSession from saved data.
   * Battle timer starts fresh; a "Server back online" log entry is added.
   */
  static fromSaveData(
    data: PlayerSaveData,
    grid: HexGrid,
    broadcastToPlayer: () => void,
  ): PlayerSession {
    const coord = offsetToCube(data.position);
    const currentTile = grid.getTile(coord);
    if (!currentTile) {
      throw new Error(`Invalid saved position for "${data.username}": (${data.position.col}, ${data.position.row})`);
    }

    // Resolve target tile
    let targetTile = null;
    if (data.target) {
      const targetCoord = offsetToCube(data.target);
      targetTile = grid.getTile(targetCoord) ?? null;
    }

    // Resolve movement queue
    const movementQueue = data.movementQueue
      .map(p => grid.getTile(offsetToCube(p)))
      .filter((t): t is NonNullable<typeof t> => t !== null);

    // Build session via Object.create to bypass constructor
    const session = Object.create(PlayerSession.prototype) as PlayerSession;
    (session as { username: string }).username = data.username;
    session['grid'] = grid;
    session['broadcastToPlayer'] = broadcastToPlayer;
    session['battleCount'] = data.battleCount;
    session['combatLog'] = data.combatLog.slice(-MAX_LOG_ENTRIES);
    session['unlockSystem'] = UnlockSystem.fromKeys(grid, data.unlockedKeys);
    session['party'] = ServerParty.restore(grid, currentTile, targetTile, movementQueue);

    // Restore character (default to fresh character for old saves)
    if (data.character) {
      session['character'] = {
        className: data.character.className as 'Adventurer',
        level: data.character.level,
        xp: data.character.xp,
        gold: data.character.gold ?? 0,
        stats: { ...data.character.stats },
        priorityStat: data.character.priorityStat,
        inventory: data.character.inventory ? { ...data.character.inventory } : {},
        equipment: data.character.equipment
          ? { ...data.character.equipment }
          : { head: null, chest: null, hand: null, foot: null },
      };
    } else {
      session['character'] = createDefaultCharacter();
    }

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    // Start battle timer fresh (no resume of previous battle state)
    session['battleTimer'] = new ServerBattleTimer(
      session['party'],
      () => session['createCombat'](),
      session['createBattleCallbacks'](),
    );

    return session;
  }

  handleEquipItem(itemId: string): boolean {
    const def = ITEMS[itemId];
    if (!def || !def.equipSlot) return false;

    const result = equipItem(this.character.inventory, this.character.equipment, itemId);
    if (result.success) {
      this.broadcastToPlayer();
    }
    return result.success;
  }

  handleUnequipItem(slot: EquipSlot): boolean {
    if (!EQUIP_SLOTS.includes(slot)) return false;

    const result = unequipItem(this.character.inventory, this.character.equipment, slot);
    if (result.success) {
      this.broadcastToPlayer();
    }
    return result.success;
  }

  destroy(): void {
    this.battleTimer.destroy();
  }
}
