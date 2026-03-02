import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { computeEquipmentBonuses, BASE_STATS } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const STAT_NAMES = ['STR', 'INT', 'WIS', 'DEX', 'CON', 'CHA'] as const;

const STAT_TOOLTIPS: Record<string, string> = {
  STR: '+1 attack damage per point',
  INT: 'No effect yet',
  WIS: 'No effect yet',
  DEX: 'No effect yet',
  CON: '+1 max HP per point',
  CHA: 'No effect yet',
};

export class PartyScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
  private classNameEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpLabel!: HTMLElement;
  private xpFill!: HTMLElement;
  private hpDisplay!: HTMLElement;
  private goldDisplay!: HTMLElement;
  private statsTable!: HTMLElement;
  private combatBonuses!: HTMLElement;
  private prioritySelect!: HTMLSelectElement;

  private unsubscribe?: () => void;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;

    this.buildDOM();
  }

  onActivate(): void {
    this.isActive = true;

    this.unsubscribe = this.gameClient.subscribe((state) => {
      if (this.isActive) this.updateFromState(state);
    });

    const state = this.gameClient.lastState;
    if (state) {
      this.updateFromState(state);
    }
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private buildDOM(): void {
    this.container.innerHTML = `
      <div class="party-content">
        <div class="party-group-status">
          <span class="party-group-badge">Ungrouped</span>
          <span>Solo adventurer</span>
        </div>
        <div class="party-character-card">
          <div class="party-card-header">
            <span class="party-class-name">Adventurer</span>
            <span class="party-level">Lv 1</span>
          </div>
          <div class="party-xp-section">
            <div class="party-xp-label">
              <span>XP</span>
              <span class="party-xp-numbers">0 / 100</span>
            </div>
            <div class="party-xp-bar">
              <div class="party-xp-fill" style="width: 0%"></div>
            </div>
          </div>
          <div class="party-hp-display">
            HP: <span class="party-hp-value">40</span>
          </div>
          <div class="party-gold-display">
            Gold: <span class="party-gold-value">0</span> GP
          </div>
          <div class="party-combat-bonuses"></div>
          <div class="party-stats-table-wrap">
            <table class="party-stats-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Base</th>
                  <th>Pts</th>
                  <th>Items</th>
                  <th>Buffs</th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody class="party-stats-tbody"></tbody>
            </table>
          </div>
          <div class="party-priority-section">
            <span class="party-priority-label">Level-up stat priority</span>
            <select class="party-priority-select">
              <option value="">Random</option>
              <option value="STR">STR</option>
              <option value="INT">INT</option>
              <option value="WIS">WIS</option>
              <option value="DEX">DEX</option>
              <option value="CON">CON</option>
              <option value="CHA">CHA</option>
            </select>
          </div>
        </div>
      </div>
    `;

    this.classNameEl = this.container.querySelector('.party-class-name')!;
    this.levelEl = this.container.querySelector('.party-level')!;
    this.xpLabel = this.container.querySelector('.party-xp-numbers')!;
    this.xpFill = this.container.querySelector('.party-xp-fill')!;
    this.hpDisplay = this.container.querySelector('.party-hp-value')!;
    this.goldDisplay = this.container.querySelector('.party-gold-value')!;
    this.combatBonuses = this.container.querySelector('.party-combat-bonuses')!;
    this.statsTable = this.container.querySelector('.party-stats-tbody')!;
    this.prioritySelect = this.container.querySelector('.party-priority-select')!;

    // Wire priority select
    this.prioritySelect.addEventListener('change', () => {
      const value = this.prioritySelect.value || null;
      this.gameClient.sendSetPriorityStat(value);
    });
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    this.classNameEl.textContent = char.className;
    this.levelEl.textContent = `Lv ${char.level}`;
    this.xpLabel.textContent = `${char.xp} / ${char.xpForNextLevel}`;

    const xpPct = char.xpForNextLevel > 0 ? (char.xp / char.xpForNextLevel) * 100 : 0;
    this.xpFill.style.width = `${xpPct}%`;

    this.hpDisplay.textContent = `${char.maxHp}`;
    this.goldDisplay.textContent = char.gold.toLocaleString();

    // Equipment combat bonuses
    const bonuses = computeEquipmentBonuses(char.equipment);
    const hasAtk = bonuses.bonusAttackMax > 0;
    const hasDef = bonuses.damageReductionMax > 0;
    this.combatBonuses.innerHTML = `
      <div class="party-bonus-row">
        <span class="party-bonus-label">Attack bonus</span>
        <span class="party-bonus-value${hasAtk ? ' active' : ''}">${hasAtk ? `+${bonuses.bonusAttackMin}-${bonuses.bonusAttackMax}` : 'None'}</span>
      </div>
      <div class="party-bonus-row">
        <span class="party-bonus-label">Damage reduction</span>
        <span class="party-bonus-value${hasDef ? ' active' : ''}">${hasDef ? `${bonuses.damageReductionMin}-${bonuses.damageReductionMax}` : 'None'}</span>
      </div>
      <div class="party-bonus-row">
        <span class="party-bonus-label">Dodge chance</span>
        <span class="party-bonus-value${bonuses.dodgeChance > 0 ? ' active' : ''}">${bonuses.dodgeChance > 0 ? `${Math.round(bonuses.dodgeChance * 100)}%` : '0%'}</span>
      </div>
    `;

    // Stats breakdown table
    this.statsTable.innerHTML = STAT_NAMES.map(stat => {
      const base = BASE_STATS[stat];
      const total = char.stats[stat];
      const pts = total - base;
      const items = 0; // No stat-boosting items yet
      const buffs = 0; // No buff system yet
      return `<tr data-tooltip="${STAT_TOOLTIPS[stat]}">
        <td class="party-stat-name">${stat}</td>
        <td>${base}</td>
        <td class="${pts > 0 ? 'has-bonus' : ''}">${pts > 0 ? `+${pts}` : '-'}</td>
        <td class="${items > 0 ? 'has-bonus' : ''}">${items > 0 ? `+${items}` : '-'}</td>
        <td class="${buffs > 0 ? 'has-bonus' : ''}">${buffs > 0 ? `+${buffs}` : '-'}</td>
        <td class="party-stat-total">${total}</td>
      </tr>`;
    }).join('');

    // Sync priority select without triggering change event
    const currentValue = char.priorityStat ?? '';
    if (this.prioritySelect.value !== currentValue) {
      this.prioritySelect.value = currentValue;
    }
  }
}
