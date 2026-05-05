import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, CombatLogEntry, ClientCombatAction } from '@idle-party-rpg/shared';
import { classIconHtml, RUN_AVAILABLE_ROUNDS } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { artworkUrl, placeholderUrl } from '../ui/assets';
import { bringToFront, release, wireFocusOnInteract } from '../ui/ModalStack';

/** Slugify a name into an artwork id (lowercase + dashes). */
function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown';
}

/** Build the chain of artwork URLs to try for a monster, ending in placehold.co. */
function monsterArtSrc(name: string): { real: string; fallback: string } {
  return { real: artworkUrl('monster', slugify(name)), fallback: placeholderUrl(name, { w: 160, h: 160 }) };
}

/** Build artwork URLs for a class. */
function classArtSrc(className: string): { real: string; fallback: string } {
  return { real: artworkUrl('class', slugify(className)), fallback: placeholderUrl(className, { w: 160, h: 160 }) };
}

export class CombatScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
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

  // Last rendered log entry ID — for incremental DOM updates
  private lastRenderedId = -1;
  private lastLog: CombatLogEntry[] = [];

  // Name classification for log coloring. Self is rendered as "You";
  // party members keep their name in green; enemies in red.
  // monsterNamesSeen accumulates across the session so older log entries
  // referencing dead monsters still highlight correctly on re-render.
  private selfUsername = '';
  private partyUsernames = new Set<string>();
  private monsterNamesSeen = new Set<string>();
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
      <div class="combat-stage">
        <div class="combat-stage-bg"></div>
        <div class="combat-stage-scrim"></div>
        <div class="combat-stage-grid">
          <div class="combat-tray combat-tray-player">
            <div class="combat-side combat-player-side"></div>
          </div>
          <div class="combat-stage-divider"></div>
          <div class="combat-tray combat-tray-enemy">
            <div class="combat-side combat-enemy-side"></div>
          </div>
        </div>
      </div>
      <div class="combat-run-bar">
        <button class="combat-run-btn combat-run-locked">Run</button>
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
    // Connection state is communicated via the persistent XP bar / nav badges;
    // no header label here since the combat header was removed.
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
    return classIconHtml(className);
  }

  private updateVisuals(state: ServerStateMessage): void {
    // Refresh log-name classification before any log re-render this tick.
    this.selfUsername = state.username ?? '';
    const partyMembers = state.social?.party?.members ?? [];
    this.partyUsernames = new Set(
      partyMembers.map(m => m.username).filter(u => u !== this.selfUsername),
    );
    for (const m of state.battle.combat?.monsters ?? []) {
      this.monsterNamesSeen.add(m.name);
    }

    // Combat background — try tile-specific then zone default
    this.updateCombatBackground(state);

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

    // Update combatant cards: portrait img, class icon (fallback), name, dim dead, stun indicator
    if (combat) {
      for (const p of combat.players) {
        const card = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"]`) as HTMLElement | null;
        if (card) {
          card.classList.toggle('dead', p.currentHp <= 0);
          card.classList.toggle('stunned', !!(p.stunTurns && p.stunTurns > 0));
          const icon = card.querySelector('.combat-card-icon') as HTMLElement | null;
          if (icon) icon.innerHTML = CombatScreen.classIcon(p.className);
          const img = card.querySelector('.combat-card-img') as HTMLImageElement | null;
          if (img) {
            const { real, fallback } = classArtSrc(p.className);
            const desired = real;
            if (img.dataset.src !== desired) {
              img.dataset.src = desired;
              img.dataset.fb = '0';
              img.src = real;
              img.onerror = () => {
                if (img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = fallback; }
                else { img.style.display = 'none'; }
              };
            }
          }
          const nameEl = card.querySelector('.combat-card-name') as HTMLElement | null;
          if (nameEl) nameEl.textContent = CombatScreen.truncateName(p.username, 10);
        }
      }
      for (const m of combat.monsters) {
        const card = this.enemySide.querySelector(`[data-grid="${m.gridPosition}"]`) as HTMLElement | null;
        if (card) {
          card.classList.toggle('dead', m.currentHp <= 0);
          card.classList.toggle('stunned', !!(m.stunTurns && m.stunTurns > 0));
          const img = card.querySelector('.combat-card-img') as HTMLImageElement | null;
          if (img) {
            const { real, fallback } = monsterArtSrc(m.name);
            if (img.dataset.src !== real) {
              img.dataset.src = real;
              img.dataset.fb = '0';
              img.src = real;
              img.onerror = () => {
                if (img.dataset.fb !== '1') { img.dataset.fb = '1'; img.src = fallback; }
                else { img.style.display = 'none'; }
              };
            }
          }
          const nameEl = card.querySelector('.combat-card-name') as HTMLElement | null;
          if (nameEl) {
            // Allow up to 2 lines for long monster names like "Skeletal Warrior".
            nameEl.textContent = m.name;
            nameEl.classList.add('combat-card-name-multiline');
          }
          // Wire monster click → popup
          card.style.cursor = 'pointer';
          card.onclick = (e) => {
            e.stopPropagation();
            this.showMonsterPopup(m, card);
          };
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
   *
   * Cards layout: image (top), name (middle, truncated), HP bar (bottom).
   */
  private renderGridSide(
    container: HTMLElement,
    count: number,
    positions: number[],
    type: 'player' | 'enemy',
  ): void {
    if (count === 0) return;

    const posSet = new Set(positions);

    for (let pos = 0; pos < 9; pos++) {
      if (posSet.has(pos)) {
        const unit = document.createElement('div');
        unit.className = `combat-unit combat-card ${type}-unit ${type === 'player' ? 'party' : 'enemy'}`;
        unit.setAttribute('data-grid', String(pos));
        unit.innerHTML = `
          <div class="combat-card-portrait">
            <img class="combat-card-img" alt="" />
            <span class="combat-card-icon"></span>
            <span class="combat-card-stun" title="Stunned"></span>
          </div>
          <div class="combat-card-name"></div>
          <div class="combat-card-hp">
            <div class="combat-card-hp-fill"></div>
          </div>
        `;
        container.appendChild(unit);
      } else {
        const empty = document.createElement('div');
        empty.className = 'combat-grid-empty';
        container.appendChild(empty);
      }
    }
  }

  private updateCombatBackground(state: ServerStateMessage): void {
    const bg = this.container.querySelector('.combat-stage-bg') as HTMLElement | null;
    if (!bg) return;
    const zone = (state.party?.col != null && state.party?.row != null) ? state.zoneName : '';
    const zoneId = state.social?.party?.id ? state.social.party.id : zone;
    // Tile-specific override: combat-bg-artwork/{zoneId}-{col}-{row}.png; zone default: combat-bg-artwork/{zoneId}.png
    const tileSrc = state.party
      ? `/combat-bg-artwork/${slugify(zone)}-${state.party.col}-${state.party.row}.png`
      : '';
    const zoneSrc = `/combat-bg-artwork/${slugify(zone || zoneId)}.png`;
    const fallback = placeholderUrl(zone || 'Combat', { w: 800, h: 400, bg: '1a1a2e', fg: '666' });
    const layered = tileSrc
      ? `url('${tileSrc}'), url('${zoneSrc}'), url('${fallback}')`
      : `url('${zoneSrc}'), url('${fallback}')`;
    if (bg.dataset.bgKey !== layered) {
      bg.style.backgroundImage = layered;
      bg.dataset.bgKey = layered;
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
    if (!combat) return;

    const selfUsername = state.username;

    for (const p of combat.players) {
      const card = this.playerSide.querySelector(`[data-grid="${p.gridPosition}"]`) as HTMLElement | null;
      if (!card) continue;
      const fill = card.querySelector('.combat-card-hp-fill') as HTMLElement | null;
      const pct = Math.max(0, (p.currentHp / p.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';
      if (fill) {
        fill.className = `combat-card-hp-fill ${hpClass}`;
        fill.style.width = `${pct}%`;
      }
      const isSelf = p.username === selfUsername;
      card.classList.toggle('self', isSelf);
      card.setAttribute('data-player-username', p.username);
      card.onclick = (e) => {
        e.stopPropagation();
        this.onUserClick?.(p.username, card);
      };
    }

    for (const m of combat.monsters) {
      const card = this.enemySide.querySelector(`[data-grid="${m.gridPosition}"]`) as HTMLElement | null;
      if (!card) continue;
      const fill = card.querySelector('.combat-card-hp-fill') as HTMLElement | null;
      const pct = Math.max(0, (m.currentHp / m.maxHp) * 100);
      const hpClass = pct <= 25 ? 'critical' : pct <= 50 ? 'low' : '';
      if (fill) {
        fill.className = `combat-card-hp-fill ${hpClass}`;
        fill.style.width = `${pct}%`;
      }
    }
  }

  private showMonsterPopup(monster: { name: string; currentHp: number; maxHp: number }, _anchor: HTMLElement): void {
    const existing = document.querySelector('.monster-popup-overlay') as HTMLElement | null;
    if (existing) { release(existing); existing.remove(); }
    const overlay = document.createElement('div');
    overlay.className = 'monster-popup-overlay';
    const { real, fallback } = monsterArtSrc(monster.name);
    overlay.innerHTML = `
      <div class="monster-popup">
        <button class="monster-popup-close" aria-label="Close">×</button>
        <div class="monster-popup-art">
          <img src="${real}" alt="${this.escapeHtml(monster.name)}"
               onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src='${fallback}';}else{this.style.display='none';}" />
        </div>
        <div class="monster-popup-name">${this.escapeHtml(monster.name)}</div>
        <div class="monster-popup-hint">Drops, abilities and resistances are unknown — defeat one to learn more.</div>
      </div>
    `;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay || (e.target as HTMLElement).closest('.monster-popup-close')) {
        release(overlay);
        overlay.remove();
      }
    });
    bringToFront(overlay);
    wireFocusOnInteract(overlay);
  }

  private static truncateName(name: string, max: number): string {
    if (name.length <= max) return name;
    return name.slice(0, max - 1) + '…';
  }

  private updateRunButton(state: ServerStateMessage): void {
    const combat = state.battle.combat;
    const isFighting = state.battle.visual === 'fighting';
    const roundCount = combat?.roundCount ?? 0;

    // Check if user is owner/leader
    const myRole = state.social?.party?.members.find(m => m.username === state.username)?.role;
    const canRun = myRole === 'owner' || myRole === 'leader';

    // The Run bar is always laid out so combat doesn't visually resize
    // between rounds \u2014 when the bar isn't usable we hide its *contents*
    // but keep the row in place. Fullscreen log mode is the only exception.
    this.runBar.style.display = this.isFullscreen ? 'none' : '';
    this.runBar.classList.toggle('combat-run-bar-empty', !isFighting);

    if (!isFighting) return;

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
    div.innerHTML = this.formatLogText(this.escapeHtml(entry.text));
    this.logContainer.appendChild(div);
    this.logContainer.scrollTop = this.logContainer.scrollHeight;
  }

  /**
   * Wrap names + damage types in colored spans. Operates on already-escaped
   * HTML so substitutions are safe to inject as innerHTML.
   *
   * Order matters: self is replaced FIRST and rewritten to "You" so we don't
   * later match "You" against any other set. Party + enemy names are wrapped
   * with their original text preserved.
   */
  private formatLogText(escaped: string): string {
    let result = escaped;

    if (this.selfUsername) {
      const re = new RegExp(`\\b${escapeRegex(this.escapeHtml(this.selfUsername))}(?:'s|s')?\\b`, 'g');
      result = result.replace(re, (m) => {
        const possessive = m.endsWith("'s") || m.endsWith("s'");
        return `<span class="log-name-self">You${possessive ? "'re" : ''}</span>`;
      });
    }

    for (const u of this.partyUsernames) {
      const escU = this.escapeHtml(u);
      const re = new RegExp(`\\b${escapeRegex(escU)}\\b`, 'g');
      result = result.replace(re, `<span class="log-name-party">${escU}</span>`);
    }

    for (const name of this.monsterNamesSeen) {
      const escName = this.escapeHtml(name);
      const re = new RegExp(`\\b${escapeRegex(escName)}\\b`, 'g');
      result = result.replace(re, `<span class="log-name-enemy">${escName}</span>`);
    }

    result = result.replace(
      /\b(physical|magical|holy)\b/gi,
      (match) => `<span class="dmg-${match.toLowerCase()}">${match}</span>`,
    );

    return result;
  }
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
