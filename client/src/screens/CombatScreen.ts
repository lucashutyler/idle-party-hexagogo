import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, CombatLogEntry } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

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
  private battleCounter!: HTMLElement;

  // Last rendered log length — for incremental DOM updates
  private renderedLogLength = 0;
  private lastLog: CombatLogEntry[] = [];

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
    // Full re-render of log on activate (may have accumulated while inactive)
    this.renderedLogLength = 0;
    this.renderLog(this.lastLog);
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
    this.battleCounter = this.container.querySelector('.battle-counter')!;
  }

  private wireSubscriptions(): void {
    this.gameClient.subscribe((state) => this.handleState(state));

    this.gameClient.onConnection((connected) => {
      this.connectionDot.classList.toggle('connected', connected);
      if (!connected) {
        this.locationLabel.textContent = 'Reconnecting...';
      }
    });
  }

  private handleState(state: ServerStateMessage): void {
    this.lastLog = state.combatLog;

    if (!this.isActive) return;

    this.updateVisuals(state);
    this.updateLog(state.combatLog);
  }

  private updateVisuals(state: ServerStateMessage): void {
    // Location label
    this.locationLabel.textContent = `Tile (${state.party.col}, ${state.party.row})`;

    // Battle counter
    this.battleCounter.textContent = `#${state.battleCount}`;

    // Stage visual state
    this.stage.classList.remove('fighting', 'victory', 'defeat');
    if (state.battle.visual !== 'none') {
      this.stage.classList.add(state.battle.visual);
    }

    // Timer bar — use server-provided battle duration
    this.timerFill.classList.remove('running', 'victory', 'defeat');
    if (state.battle.state === 'battle') {
      const durationSec = (state.battle.duration / 1000).toFixed(1);
      this.timerFill.style.setProperty('--battle-duration', `${durationSec}s`);
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

  private updateLog(log: CombatLogEntry[]): void {
    if (log.length < this.renderedLogLength) {
      // Log was trimmed (entries shifted off the front) — full re-render
      this.renderedLogLength = 0;
      this.renderLog(log);
      return;
    }

    // Append only new entries
    for (let i = this.renderedLogLength; i < log.length; i++) {
      this.appendLogEntry(log[i]);
    }
    this.renderedLogLength = log.length;
  }

  private renderLog(log: CombatLogEntry[]): void {
    this.logContainer.innerHTML = '';
    for (const entry of log) {
      this.appendLogEntry(entry);
    }
    this.renderedLogLength = log.length;
  }

  private appendLogEntry(entry: CombatLogEntry): void {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.type}`;
    div.textContent = entry.text;
    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }
}
