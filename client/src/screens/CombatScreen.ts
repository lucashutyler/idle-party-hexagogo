import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, BattleVisual } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const MAX_LOG_ENTRIES = 50;

interface LogEntry {
  text: string;
  type: 'battle' | 'victory' | 'defeat' | 'move' | 'unlock';
}

export class CombatScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
  private locationLabel!: HTMLElement;
  private connectionDot!: HTMLElement;
  private stage!: HTMLElement;
  private timerFill!: HTMLElement;
  private logContainer!: HTMLElement;

  // State tracking
  private logEntries: LogEntry[] = [];
  private lastVisual: BattleVisual = 'none';
  private lastCol = -1;
  private lastRow = -1;
  private lastUnlockedCount = 0;
  private battleCount = 0;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    this.buildDOM();
    this.wireSubscriptions();
  }

  onActivate(): void {
    this.isActive = true;
    this.renderLog();
  }

  onDeactivate(): void {
    this.isActive = false;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="combat-header">
        <div class="combat-location">
          <span class="connection-dot"></span>
          <span class="location-label">Connecting...</span>
        </div>
        <span class="battle-counter">#0</span>
      </div>
      <div class="combat-stage">
        <div class="combat-side">
          <div class="combat-member party"></div>
        </div>
        <div class="combat-vs">⚔</div>
        <div class="combat-side">
          <div class="combat-member enemy"></div>
          <div class="combat-member enemy"></div>
        </div>
      </div>
      <div class="combat-timer">
        <div class="combat-timer-fill"></div>
      </div>
      <div class="combat-log"></div>
    `;

    this.locationLabel = this.container.querySelector('.location-label')!;
    this.connectionDot = this.container.querySelector('.connection-dot')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.timerFill = this.container.querySelector('.combat-timer-fill')!;
    this.logContainer = this.container.querySelector('.combat-log')!;
  }

  private wireSubscriptions(): void {
    // Always-on: track state for log even when screen is not visible
    this.gameClient.subscribe((state) => this.handleState(state));

    this.gameClient.onConnection((connected) => {
      this.connectionDot.classList.toggle('connected', connected);
      if (!connected) {
        this.locationLabel.textContent = 'Reconnecting...';
      }
    });
  }

  private handleState(state: ServerStateMessage): void {
    const visual = state.battle.visual;

    // Generate log entries on state transitions
    if (visual !== this.lastVisual) {
      if (visual === 'fighting') {
        this.battleCount++;
        this.addLog(`Battle #${this.battleCount} begins!`, 'battle');
      } else if (visual === 'victory') {
        this.addLog('Victory!', 'victory');
      } else if (visual === 'defeat') {
        this.addLog('Defeat...', 'defeat');
      }
    }

    // Detect movement
    if (state.party.col !== this.lastCol || state.party.row !== this.lastRow) {
      if (this.lastCol !== -1) {
        this.addLog(`Moved to (${state.party.col}, ${state.party.row})`, 'move');
      }
      this.lastCol = state.party.col;
      this.lastRow = state.party.row;
    }

    // Detect new tile unlocks
    const unlockedCount = state.unlocked.length;
    if (unlockedCount > this.lastUnlockedCount && this.lastUnlockedCount > 0) {
      const diff = unlockedCount - this.lastUnlockedCount;
      this.addLog(`${diff} new tile${diff > 1 ? 's' : ''} unlocked!`, 'unlock');
    }
    this.lastUnlockedCount = unlockedCount;

    this.lastVisual = visual;

    // Only update DOM when active
    if (!this.isActive) return;

    this.updateVisuals(state);
  }

  private updateVisuals(state: ServerStateMessage): void {
    // Location label
    this.locationLabel.textContent = `Tile (${state.party.col}, ${state.party.row})`;

    // Battle counter
    const counter = this.container.querySelector('.battle-counter');
    if (counter) counter.textContent = `#${this.battleCount}`;

    // Stage visual state
    this.stage.classList.remove('fighting', 'victory', 'defeat');
    if (state.battle.visual !== 'none') {
      this.stage.classList.add(state.battle.visual);
    }

    // Timer bar
    this.timerFill.classList.remove('running', 'victory', 'defeat');
    if (state.battle.state === 'battle') {
      // Force reflow to restart the CSS animation
      this.timerFill.style.animation = 'none';
      void this.timerFill.offsetHeight;
      this.timerFill.style.animation = '';
      this.timerFill.classList.add('running');
    } else if (state.battle.visual === 'victory') {
      this.timerFill.classList.add('victory');
    } else if (state.battle.visual === 'defeat') {
      this.timerFill.classList.add('defeat');
    }
  }

  private addLog(text: string, type: LogEntry['type']): void {
    this.logEntries.push({ text, type });
    if (this.logEntries.length > MAX_LOG_ENTRIES) {
      this.logEntries.shift();
    }

    // Append to DOM only if active
    if (this.isActive) {
      this.appendLogEntry({ text, type });
    }
  }

  private renderLog(): void {
    this.logContainer.innerHTML = '';
    for (const entry of this.logEntries) {
      this.appendLogEntry(entry);
    }
  }

  private appendLogEntry(entry: LogEntry): void {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.type}`;
    div.textContent = entry.text;
    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }
}
