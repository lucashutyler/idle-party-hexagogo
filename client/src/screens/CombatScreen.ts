import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, CombatLogEntry, ClientCombatAction } from '@idle-party-rpg/shared';
import { CLASS_ICONS, UNKNOWN_CLASS_ICON, RUN_AVAILABLE_ROUNDS } from '@idle-party-rpg/shared';
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
  private logWrapper!: HTMLElement;
  private resumeBtn!: HTMLElement;
  private fullscreenBtn!: HTMLElement;
  private runBtn!: HTMLButtonElement;
  private runHint!: HTMLElement;
  private runBar!: HTMLElement;
  private runHintTimer?: ReturnType<typeof setTimeout>;
  private roundLabel!: HTMLElement;

  // Last rendered log entry ID — for incremental DOM updates
  private lastRenderedId = -1;
  private lastLog: CombatLogEntry[] = [];
  private renderedPlayerKey = '';
  private renderedEnemyKey = '';

  // Pause/fullscreen state
  private paused = false;
  private isFullscreen = false;

  // Username click callback
  private onUserClick?: (username: string, anchor: HTMLElement) => void;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    this.buildDOM();
    this.wireSubscriptions();
  }

  setOnUserClick(cb: (username: string, anchor: HTMLElement) => void): void {
    this.onUserClick = cb;
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
    this.lastRenderedId = -1;
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
        <span class="round-label"></span>
      </div>
      <div class="combat-stage">
        <div class="combat-side combat-player-side"></div>
        <div class="combat-vs">\u2694</div>
        <div class="combat-side combat-enemy-side"></div>
      </div>
      <div class="combat-run-bar">
        <button class="combat-run-btn combat-run-locked">\uD83D\uDD12 Run</button>
        <span class="combat-run-hint" style="display:none">Available after ${RUN_AVAILABLE_ROUNDS} combat rounds</span>
      </div>
      <div class="combat-log-wrapper">
        <div class="combat-log-controls">
          <button class="log-fullscreen-btn" title="Fullscreen">\u26F6</button>
        </div>
        <div class="combat-log"></div>
        <button class="log-resume-btn" style="display:none">\u25BC Resume Live</button>
      </div>
    `;

    this.locationLabel = this.container.querySelector('.location-label')!;
    this.connectionDot = this.container.querySelector('.connection-dot')!;
    this.stage = this.container.querySelector('.combat-stage')!;
    this.playerSide = this.container.querySelector('.combat-player-side')!;
    this.enemySide = this.container.querySelector('.combat-enemy-side')!;
    this.logWrapper = this.container.querySelector('.combat-log-wrapper')!;
    this.logContainer = this.container.querySelector('.combat-log')!;
    this.resumeBtn = this.container.querySelector('.log-resume-btn')!;
    this.fullscreenBtn = this.container.querySelector('.log-fullscreen-btn')!;
    this.runBtn = this.container.querySelector('.combat-run-btn')! as HTMLButtonElement;
    this.runHint = this.container.querySelector('.combat-run-hint')!;
    this.runBar = this.container.querySelector('.combat-run-bar')!;
    this.roundLabel = this.container.querySelector('.round-label')!;

    // Auto-pause on user scroll
    this.logContainer.addEventListener('scroll', () => {
      if (this.paused) return;
      const { scrollTop, scrollHeight, clientHeight } = this.logContainer;
      if (scrollTop + clientHeight < scrollHeight - 20) {
        this.setPaused(true);
      }
    });

    // Resume button
    this.resumeBtn.addEventListener('click', () => {
      this.setPaused(false);
      this.renderLog(this.lastLog);
    });

    // Fullscreen toggle
    this.fullscreenBtn.addEventListener('click', () => {
      this.isFullscreen = !this.isFullscreen;
      this.logWrapper.classList.toggle('fullscreen', this.isFullscreen);
      this.fullscreenBtn.textContent = this.isFullscreen ? '\u2716' : '\u26F6';
      this.fullscreenBtn.title = this.isFullscreen ? 'Exit Fullscreen' : 'Fullscreen';
      // Hide run bar when log is fullscreen
      if (this.isFullscreen) {
        this.runBar.style.display = 'none';
      }
    });

    // Run button — show hint when locked, send run when available
    this.runBtn.addEventListener('click', () => {
      if (this.runBtn.classList.contains('combat-run-locked')) {
        this.showRunHint();
      } else {
        this.gameClient.sendRun();
      }
    });
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

    // Update combatant sprites: class icons for players, dim dead, stun indicator
    if (combat) {
      for (const p of combat.players) {
        const el = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"] .combat-member`);
        if (el) {
          el.textContent = CombatScreen.classIcon(p.className);
          el.classList.toggle('dead', p.currentHp <= 0);
          el.classList.toggle('stunned', !!(p.stunTurns && p.stunTurns > 0));
        }
      }
      for (const m of combat.monsters) {
        const el = this.enemySide.querySelector(`[data-grid="${m.gridPosition}"] .combat-member`);
        if (el) {
          el.classList.toggle('dead', m.currentHp <= 0);
          el.classList.toggle('stunned', !!(m.stunTurns && m.stunTurns > 0));
        }
      }
    }

    // HP bars
    this.updateHpBars(state);

    // Per-turn attack/hit animations
    this.updateCombatAnimations(combat?.lastAction ?? null, state.battle.visual);

    // Round counter and run button
    this.updateRunButton(state);
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
      const unitEl = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"]`) as HTMLElement | null;
      const hpContainer = unitEl?.querySelector('.combat-unit-hp');
      if (!hpContainer || !unitEl) continue;
      const pct = Math.max(0, (p.currentHp / p.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';
      const isSelf = p.username === selfUsername;
      hpContainer.innerHTML = `
        <div class="combat-hp-label${isSelf ? ' self' : ''}" data-username="${this.escapeHtml(p.username)}">${this.escapeHtml(p.username)}</div>
        <div class="combat-hp-bar">
          <div class="hp-fill ${hpClass}" style="width: ${pct}%"></div>
        </div>
      `;
      // Make the entire player unit clickable for the user popup
      unitEl.style.cursor = 'pointer';
      unitEl.setAttribute('data-player-username', p.username);
      unitEl.onclick = (e) => {
        e.stopPropagation();
        const label = unitEl.querySelector('.combat-hp-label') as HTMLElement;
        this.onUserClick?.(p.username, label ?? unitEl);
      };
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

  private updateRunButton(state: ServerStateMessage): void {
    const combat = state.battle.combat;
    const isFighting = state.battle.visual === 'fighting';
    const roundCount = combat?.roundCount ?? 0;

    // Update round counter
    if (isFighting && roundCount > 0) {
      this.roundLabel.textContent = `Round ${roundCount}`;
      this.roundLabel.style.display = '';
    } else {
      this.roundLabel.style.display = 'none';
    }

    // Check if user is owner/leader
    const myRole = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canRun = myRole === 'owner' || myRole === 'leader';

    if (!isFighting || this.isFullscreen) {
      this.runBar.style.display = 'none';
      return;
    }

    this.runBar.style.display = '';

    if (!canRun) {
      this.runBtn.classList.add('combat-run-locked');
      this.runBtn.textContent = '\uD83D\uDD12 Run';
      this.runHint.textContent = 'Only the party owner or a leader can run';
      return;
    }

    const available = roundCount >= RUN_AVAILABLE_ROUNDS;
    this.runBtn.classList.toggle('combat-run-locked', !available);
    this.runBtn.textContent = available ? 'Run' : '\uD83D\uDD12 Run';
    this.runHint.textContent = `Available after ${RUN_AVAILABLE_ROUNDS} combat rounds`;
  }

  private showRunHint(): void {
    if (this.runHintTimer) clearTimeout(this.runHintTimer);
    this.runHint.style.display = '';
    this.runHintTimer = setTimeout(() => {
      this.runHint.style.display = 'none';
      this.runHintTimer = undefined;
    }, 3000);
  }

  private escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  private setPaused(paused: boolean): void {
    this.paused = paused;
    this.resumeBtn.style.display = paused ? '' : 'none';
  }

  private updateLog(log: CombatLogEntry[]): void {
    // When paused, don't update DOM — just track latest data
    if (this.paused) return;

    const lastId = log.length > 0 ? log[log.length - 1].id : -1;

    // Nothing new — skip
    if (lastId === this.lastRenderedId) return;

    // Find the first entry we haven't rendered yet
    const startIdx = log.findIndex(e => e.id > this.lastRenderedId);

    if (startIdx <= 0) {
      // Log reset or all entries are new — full re-render
      this.renderLog(log);
    } else {
      // Trim DOM if old entries shifted off the front (log at max capacity)
      const staleCount = this.logContainer.childElementCount - (log.length - startIdx) - startIdx;
      if (staleCount > 0) {
        // Old entries at the front are no longer in the log — remove them
        for (let i = 0; i < staleCount && this.logContainer.firstChild; i++) {
          this.logContainer.removeChild(this.logContainer.firstChild);
        }
      }

      // Append only new entries
      for (let i = startIdx; i < log.length; i++) {
        this.appendLogEntry(log[i]);
      }
      this.lastRenderedId = lastId;
    }
  }

  private renderLog(log: CombatLogEntry[]): void {
    this.logContainer.innerHTML = '';
    for (const entry of log) {
      this.appendLogEntry(entry);
    }
    this.lastRenderedId = log.length > 0 ? log[log.length - 1].id : -1;
  }

  private appendLogEntry(entry: CombatLogEntry): void {
    const div = document.createElement('div');
    div.className = `log-entry ${entry.type}`;
    div.innerHTML = CombatScreen.formatLogText(this.escapeHtml(entry.text));
    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }

  private static formatLogText(escaped: string): string {
    return escaped.replace(
      /\b(physical|magical|holy)\b/gi,
      (match) => `<span class="dmg-${match.toLowerCase()}">${match}</span>`,
    );
  }
}
