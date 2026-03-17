import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, CombatLogEntry, ClientCombatAction } from '@idle-party-rpg/shared';
import { CLASS_ICONS, UNKNOWN_CLASS_ICON } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

export class CombatScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
  private locationLabel!: HTMLElement;
  private connectionDot!: HTMLElement;
  private stage!: HTMLElement;
  private playerSide!: HTMLElement;
  private enemySide!: HTMLElement;
  private logContainer!: HTMLElement;

  // Last rendered log length — for incremental DOM updates
  private renderedLogLength = 0;
  private lastLog: CombatLogEntry[] = [];
  private renderedPlayerKey = '';
  private renderedEnemyKey = '';

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
      </div>
      <div class="combat-stage">
        <div class="combat-side combat-player-side"></div>
        <div class="combat-vs">\u2694</div>
        <div class="combat-side combat-enemy-side"></div>
      </div>
      <div class="combat-log"></div>
    `;

    this.locationLabel = this.container.querySelector('.location-label')!;
    this.connectionDot = this.container.querySelector('.connection-dot')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.playerSide = this.container.querySelector('.combat-player-side')!;
    this.enemySide = this.container.querySelector('.combat-enemy-side')!;
    this.logContainer = this.container.querySelector('.combat-log')!;
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

  /**
   * Build a cache key from a grid side's combatants.
   * We rebuild the DOM only when the set of combatants (count + positions) changes.
   */
  private static gridKey(items: { gridPosition: number }[]): string {
    return items.map(i => i.gridPosition).sort().join(',');
  }

  private static classIcon(className: string): string {
    return CLASS_ICONS[className] ?? UNKNOWN_CLASS_ICON;
  }

  private updateVisuals(state: ServerStateMessage): void {
    // Location label
    this.locationLabel.textContent = state.zoneName;

    // Stage visual state
    this.stage.classList.remove('fighting', 'victory', 'defeat');
    if (state.battle.visual !== 'none') {
      this.stage.classList.add(state.battle.visual);
    }

    const combat = state.battle.combat;

    // --- Player side (3-row grid) ---
    const players = combat?.players ?? [];
    const playerKey = CombatScreen.gridKey(players);
    if (playerKey !== this.renderedPlayerKey) {
      this.playerSide.innerHTML = '';
      this.renderGridSide(this.playerSide, players.length, players.map(p => p.gridPosition), 'player');
      this.renderedPlayerKey = playerKey;
    }

    // --- Enemy side (3-row grid) ---
    const monsters = combat?.monsters ?? [];
    const enemyKey = CombatScreen.gridKey(monsters);
    if (enemyKey !== this.renderedEnemyKey) {
      this.enemySide.innerHTML = '';
      this.renderGridSide(this.enemySide, monsters.length, monsters.map(m => m.gridPosition), 'enemy');
      this.renderedEnemyKey = enemyKey;
    }

    // Update combatant sprites: class icons for players, dim dead
    if (combat) {
      for (const p of combat.players) {
        const el = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"] .combat-member`);
        if (el) {
          el.textContent = CombatScreen.classIcon(p.className);
          el.classList.toggle('dead', p.currentHp <= 0);
        }
      }
      for (const m of combat.monsters) {
        const el = this.enemySide.querySelector(`[data-grid="${m.gridPosition}"] .combat-member`);
        if (el) el.classList.toggle('dead', m.currentHp <= 0);
      }
    }

    // HP bars
    this.updateHpBars(state);

    // Per-turn attack/hit animations
    this.updateCombatAnimations(combat?.lastAction ?? null, state.battle.visual);
  }

  /**
   * Render a 3×3 grid layout for one side (players or enemies).
   * Each combatant is placed at its actual grid position (0-8).
   * Empty cells are left as blank space.
   */
  private renderGridSide(
    container: HTMLElement,
    count: number,
    positions: number[],
    type: 'player' | 'enemy',
  ): void {
    if (count === 0) return;

    const posSet = new Set(positions);

    // Render all 9 cells (3 rows × 3 cols)
    for (let pos = 0; pos < 9; pos++) {
      if (posSet.has(pos)) {
        const unit = document.createElement('div');
        unit.className = `combat-unit ${type}-unit`;
        unit.setAttribute('data-grid', String(pos));
        unit.innerHTML = `
          <div class="combat-unit-hp"></div>
          <div class="combat-member ${type === 'player' ? 'party' : 'enemy'}"></div>
        `;
        container.appendChild(unit);
      } else {
        const empty = document.createElement('div');
        empty.className = 'combat-grid-empty';
        container.appendChild(empty);
      }
    }
  }

  private updateCombatAnimations(action: ClientCombatAction | null, visual: string): void {
    // Clear all animation classes
    for (const el of this.container.querySelectorAll('.attacking, .hit, .dodged')) {
      el.classList.remove('attacking', 'hit', 'dodged');
    }

    if (!action || visual !== 'fighting') return;

    // Apply attacking class to the attacker
    const attackerSide = action.attackerSide === 'player' ? this.playerSide : this.enemySide;
    const attackerEl = attackerSide.querySelector(`[data-grid="${action.attackerPos}"] .combat-member`);
    if (attackerEl) {
      attackerEl.classList.add('attacking');
    }

    // Apply hit/dodged class to the target
    if (action.targetPos !== null && action.targetSide) {
      const targetSide = action.targetSide === 'player' ? this.playerSide : this.enemySide;
      const targetEl = targetSide.querySelector(`[data-grid="${action.targetPos}"] .combat-member`);
      if (targetEl) {
        targetEl.classList.add(action.dodged ? 'dodged' : 'hit');
      }
    }
  }

  private updateHpBars(state: ServerStateMessage): void {
    const combat = state.battle.combat;
    if (!combat) {
      // Clear all HP labels
      for (const hp of this.playerSide.querySelectorAll('.combat-unit-hp')) {
        hp.innerHTML = '';
      }
      return;
    }

    const selfUsername = state.username;

    // Player HP bars
    for (const p of combat.players) {
      const hpContainer = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"] .combat-unit-hp`);
      if (!hpContainer) continue;
      const pct = Math.max(0, (p.currentHp / p.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';
      const isSelf = p.username === selfUsername;
      hpContainer.innerHTML = `
        <div class="combat-hp-label${isSelf ? ' self' : ''}">${this.escapeHtml(p.username)}</div>
        <div class="combat-hp-bar">
          <div class="hp-fill ${hpClass}" style="width: ${pct}%"></div>
        </div>
      `;
    }

    // Enemy HP bars
    for (const m of combat.monsters) {
      const hpContainer = this.enemySide.querySelector(`[data-grid="${m.gridPosition}"] .combat-unit-hp`);
      if (!hpContainer) continue;
      const dead = m.currentHp <= 0;
      const pct = Math.max(0, (m.currentHp / m.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';
      hpContainer.innerHTML = `
        <div class="combat-hp-label${dead ? ' dead' : ''}">${this.escapeHtml(m.name)}</div>
        <div class="combat-hp-bar">
          <div class="hp-fill ${hpClass}" style="width: ${pct}%"></div>
        </div>
      `;
    }
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
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
