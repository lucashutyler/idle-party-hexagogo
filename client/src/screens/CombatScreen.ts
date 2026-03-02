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
  private enemySide!: HTMLElement;
  private hpSection!: HTMLElement;
  private logContainer!: HTMLElement;
  private battleCounter!: HTMLElement;

  // Last rendered log length — for incremental DOM updates
  private renderedLogLength = 0;
  private lastLog: CombatLogEntry[] = [];
  private renderedEnemyCount = 0;

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

    // Render current state immediately (first state may have arrived before subscription)
    const state = this.gameClient.lastState;
    if (state) {
      this.updateVisuals(state);
      this.lastLog = state.combatLog;
    }

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
        <div class="combat-side enemy-side"></div>
      </div>
      <div class="combat-hp-section"></div>
      <div class="combat-log"></div>
    `;

    this.locationLabel = this.container.querySelector('.location-label')!;
    this.connectionDot = this.container.querySelector('.connection-dot')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.enemySide = this.container.querySelector('.enemy-side')!;
    this.hpSection = this.container.querySelector('.combat-hp-section')!;
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
    this.locationLabel.textContent = `${state.zoneName} (${state.party.col}, ${state.party.row})`;

    // Battle counter
    this.battleCounter.textContent = `#${state.battleCount}`;

    // Stage visual state
    this.stage.classList.remove('fighting', 'victory', 'defeat');
    if (state.battle.visual !== 'none') {
      this.stage.classList.add(state.battle.visual);
    }

    // Update enemy sprites — sync count and dim dead monsters
    const combat = state.battle.combat;
    const monsterCount = combat ? combat.monsters.length : 0;
    if (monsterCount !== this.renderedEnemyCount) {
      this.enemySide.innerHTML = '';
      for (let i = 0; i < monsterCount; i++) {
        const div = document.createElement('div');
        div.className = 'combat-member enemy';
        this.enemySide.appendChild(div);
      }
      this.renderedEnemyCount = monsterCount;
    }
    if (combat) {
      const enemySprites = this.enemySide.children;
      for (let i = 0; i < combat.monsters.length; i++) {
        (enemySprites[i] as HTMLElement).classList.toggle('dead', combat.monsters[i].currentHp <= 0);
      }
    }

    // HP bars
    this.updateHpBars(state);
  }

  private updateHpBars(state: ServerStateMessage): void {
    const combat = state.battle.combat;
    if (!combat) {
      this.hpSection.innerHTML = '';
      return;
    }

    const playerName = state.character ? `Lv${state.character.level} ${state.character.className}` : 'Player';
    const playerPct = Math.max(0, (combat.playerHp / combat.playerMaxHp) * 100);
    const playerHpClass = playerPct <= 25 ? 'critical' : playerPct <= 50 ? 'low' : '';

    let html = `
      <div class="combat-hp-group">
        <div class="combat-hp-label">
          <span>${playerName}</span>
          <span>${combat.playerHp}/${combat.playerMaxHp}</span>
        </div>
        <div class="combat-hp-bar">
          <div class="hp-fill ${playerHpClass}" style="width: ${playerPct}%"></div>
        </div>
      </div>
    `;

    for (const monster of combat.monsters) {
      const dead = monster.currentHp <= 0;
      const pct = Math.max(0, (monster.currentHp / monster.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';

      html += `
        <div class="combat-monster-hp ${dead ? 'dead' : ''}">
          <div class="combat-hp-label">
            <span>${monster.name} Lv${monster.level}</span>
            <span>${monster.currentHp}/${monster.maxHp}</span>
          </div>
          <div class="combat-hp-bar">
            <div class="hp-fill ${hpClass}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    }

    this.hpSection.innerHTML = html;
  }

  private updateLog(log: CombatLogEntry[]): void {
    if (log.length < this.renderedLogLength) {
      // Log was trimmed (entries shifted off the front) — full re-render
      this.renderLog(log);
      return;
    }

    if (log.length === this.renderedLogLength) {
      // Same length — check if entries cycled (log at max capacity:
      // server shifts old entries off the front, pushes new to the back)
      const lastRendered = this.logContainer.lastElementChild;
      const lastEntry = log[log.length - 1];
      if (lastEntry && lastRendered && lastRendered.textContent !== lastEntry.text) {
        this.renderLog(log);
      }
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
