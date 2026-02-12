import {
  HexGrid,
  UnlockSystem,
  getStartingPosition,
  offsetToCube,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type { BattleResult, ServerStateMessage, OtherPlayerState, CombatLogEntry } from '@idle-party-rpg/shared';
import { ServerParty } from './ServerParty';
import { ServerBattleTimer } from './ServerBattleTimer';
import type { PlayerSaveData } from './GameStateStore';

const MAX_LOG_ENTRIES = 100;
const MAX_SAVE_LOG_ENTRIES = 1000;

export class PlayerSession {
  readonly username: string;
  private grid: HexGrid;
  private party: ServerParty;
  private battleTimer: ServerBattleTimer;
  private unlockSystem: UnlockSystem;
  private combatLog: CombatLogEntry[] = [];
  private battleCount = 0;

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

    this.unlockSystem = new UnlockSystem(this.grid, startTile);
    this.party = new ServerParty(this.grid, startTile);

    this.battleTimer = new ServerBattleTimer(this.party, {
      onBattleStart: () => {
        this.battleCount++;
        this.addLogEntry(`Battle #${this.battleCount} begins!`, 'battle');
      },
      onStateChange: () => {
        this.broadcastToPlayer();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          this.addLogEntry('Victory!', 'victory');
          const unlocked = this.unlockSystem.unlockAdjacentTiles(this.party.tile);
          if (unlocked.length > 0) {
            this.addLogEntry(`${unlocked.length} new tile${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
          }
        } else {
          this.addLogEntry('Defeat...', 'defeat');
        }
        this.broadcastToPlayer();
      },
      onMove: () => {
        const pos = this.getPosition();
        this.addLogEntry(`Moved to (${pos.col}, ${pos.row})`, 'move');
      },
      canMoveToNextTile: () => {
        const nextTile = this.party.nextTile;
        return nextTile ? this.unlockSystem.isUnlocked(nextTile) : false;
      },
    });
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

  getState(otherPlayers: OtherPlayerState[]): Omit<ServerStateMessage, 'type'> {
    return {
      party: this.party.toJSON(),
      battle: {
        state: this.battleTimer.currentState,
        result: this.battleTimer.lastResult,
        visual: this.battleTimer.visual,
        duration: this.battleTimer.currentDuration,
      },
      unlocked: this.unlockSystem.getUnlockedKeys(),
      mapSize: this.grid.size,
      otherPlayers,
      combatLog: this.combatLog,
      battleCount: this.battleCount,
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

    // Add server-online log entry
    session['addLogEntry']('Server back online — resuming!', 'battle');

    // Start battle timer fresh (no resume of previous battle state)
    session['battleTimer'] = new ServerBattleTimer(session['party'], {
      onBattleStart: () => {
        session['battleCount']++;
        session['addLogEntry'](`Battle #${session['battleCount']} begins!`, 'battle');
      },
      onStateChange: () => {
        session['broadcastToPlayer']();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          session['addLogEntry']('Victory!', 'victory');
          const unlocked = session['unlockSystem'].unlockAdjacentTiles(session['party'].tile);
          if (unlocked.length > 0) {
            session['addLogEntry'](`${unlocked.length} new tile${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
          }
        } else {
          session['addLogEntry']('Defeat...', 'defeat');
        }
        session['broadcastToPlayer']();
      },
      onMove: () => {
        const pos = session.getPosition();
        session['addLogEntry'](`Moved to (${pos.col}, ${pos.row})`, 'move');
      },
      canMoveToNextTile: () => {
        const nextTile = session['party'].nextTile;
        return nextTile ? session['unlockSystem'].isUnlocked(nextTile) : false;
      },
    });

    return session;
  }

  destroy(): void {
    this.battleTimer.destroy();
  }
}
