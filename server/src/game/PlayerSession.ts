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

const MAX_LOG_ENTRIES = 100;

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
        this.addLog(`Battle #${this.battleCount} begins!`, 'battle');
      },
      onStateChange: () => {
        this.broadcastToPlayer();
      },
      onBattleEnd: (result: BattleResult) => {
        if (result === 'victory') {
          this.addLog('Victory!', 'victory');
          const unlocked = this.unlockSystem.unlockAdjacentTiles(this.party.tile);
          if (unlocked.length > 0) {
            this.addLog(`${unlocked.length} new tile${unlocked.length > 1 ? 's' : ''} unlocked!`, 'unlock');
          }
        } else {
          this.addLog('Defeat...', 'defeat');
        }
        this.broadcastToPlayer();
      },
      onMove: () => {
        const pos = this.getPosition();
        this.addLog(`Moved to (${pos.col}, ${pos.row})`, 'move');
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

  private addLog(text: string, type: CombatLogEntry['type']): void {
    this.combatLog.push({ text, type });
    if (this.combatLog.length > MAX_LOG_ENTRIES) {
      this.combatLog.shift();
    }
  }

  destroy(): void {
    this.battleTimer.destroy();
  }
}
