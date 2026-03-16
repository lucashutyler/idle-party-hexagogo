import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, ClassName } from '@idle-party-rpg/shared';
import { computeEquipmentBonuses, CLASS_DEFINITIONS, CLASS_ICONS, UNKNOWN_CLASS_ICON, xpForNextLevel } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

const STAT_NAMES = ['STR', 'INT', 'WIS', 'DEX', 'CON', 'CHA'] as const;

const STAT_TOOLTIPS: Record<string, string> = {
  STR: 'Strength',
  INT: 'Magic damage (Mage)',
  WIS: 'Wisdom',
  DEX: 'Physical damage (Archer)',
  CON: '+1 max HP per point',
  CHA: 'Charisma',
};

export class CharacterScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;

  // DOM references
  private classNameEl!: HTMLElement;
  private levelEl!: HTMLElement;
  private xpLabel!: HTMLElement;
  private xpFill!: HTMLElement;
  private xpRateEl!: HTMLElement;
  private hpDisplay!: HTMLElement;
  private goldDisplay!: HTMLElement;
  private statsTable!: HTMLElement;
  private combatBonuses!: HTMLElement;
  private classPassiveEl!: HTMLElement;

  // XP rate tracking
  private xpRateStartTime = Date.now();
  private xpRateTotal = 0;
  private lastTotalXp = -1; // -1 = not initialized

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
      <div class="character-content">
        <div class="character-card">
          <div class="character-card-header">
            <span class="character-class-name">Adventurer</span>
            <span class="character-level">Lv 1</span>
          </div>
          <div class="character-xp-section">
            <div class="character-xp-label">
              <span>XP</span>
              <span class="character-xp-numbers">0 / 100</span>
            </div>
            <div class="character-xp-bar">
              <div class="character-xp-fill" style="width: 0%"></div>
            </div>
            <div class="character-xp-rate">
              <span class="character-xp-rate-label">XP Rate</span>
              <span class="character-xp-rate-value">0/hr</span>
              <span class="character-xp-rate-reset" title="Reset XP rate counter">&#x21bb;</span>
            </div>
          </div>
          <div class="character-hp-display">
            HP: <span class="character-hp-value">40</span>
          </div>
          <div class="character-gold-display">
            Gold: <span class="character-gold-value">0</span> GP
          </div>
          <div class="character-combat-bonuses"></div>
          <div class="character-class-passive"></div>
          <div class="character-stats-table-wrap">
            <table class="character-stats-table">
              <thead>
                <tr>
                  <th></th>
                  <th>Total</th>
                </tr>
              </thead>
              <tbody class="character-stats-tbody"></tbody>
            </table>
          </div>
        </div>
      </div>
    `;

    this.classNameEl = this.container.querySelector('.character-class-name')!;
    this.levelEl = this.container.querySelector('.character-level')!;
    this.xpLabel = this.container.querySelector('.character-xp-numbers')!;
    this.xpFill = this.container.querySelector('.character-xp-fill')!;
    this.hpDisplay = this.container.querySelector('.character-hp-value')!;
    this.goldDisplay = this.container.querySelector('.character-gold-value')!;
    this.combatBonuses = this.container.querySelector('.character-combat-bonuses')!;
    this.classPassiveEl = this.container.querySelector('.character-class-passive')!;
    this.statsTable = this.container.querySelector('.character-stats-tbody')!;
    this.xpRateEl = this.container.querySelector('.character-xp-rate-value')!;

    // Wire XP rate reset icon with confirmation
    const resetIcon = this.container.querySelector('.character-xp-rate-reset')!;
    resetIcon.addEventListener('click', () => {
      if (resetIcon.classList.contains('confirming')) {
        // Second click — perform reset
        resetIcon.classList.remove('confirming');
        this.xpRateStartTime = Date.now();
        this.xpRateTotal = 0;
        this.lastTotalXp = -1;
        this.xpRateEl.textContent = '0/hr';
        return;
      }
      // First click — enter confirmation state
      resetIcon.classList.add('confirming');
      setTimeout(() => resetIcon.classList.remove('confirming'), 3000);
    });
  }

  /** Compute cumulative total XP earned across all levels. */
  private static computeTotalXp(level: number, xp: number): number {
    // Sum of XP thresholds for levels 1..level-1: sum(100*i for i=1..level-1)
    let total = 0;
    for (let i = 1; i < level; i++) {
      total += xpForNextLevel(i);
    }
    return total + xp;
  }

  private static formatXpRate(rate: number): string {
    if (rate < 1000) return `${Math.round(rate)}/hr`;
    if (rate < 1_000_000) return `${(rate / 1_000).toFixed(1)}k/hr`;
    if (rate < 1_000_000_000) return `${(rate / 1_000_000).toFixed(1)}m/hr`;
    if (rate < 1_000_000_000_000) return `${(rate / 1_000_000_000).toFixed(1)}b/hr`;
    if (rate < 1_000_000_000_000_000) return `${(rate / 1_000_000_000_000).toFixed(1)}t/hr`;
    return '?/hr';
  }

  private updateFromState(state: ServerStateMessage): void {
    const char = state.character;
    if (!char) return;

    const icon = CLASS_ICONS[char.className] ?? UNKNOWN_CLASS_ICON;
    this.classNameEl.textContent = `${icon} ${char.className}`;
    this.levelEl.textContent = `Lv ${char.level}`;
    this.xpLabel.textContent = `${char.xp} / ${char.xpForNextLevel}`;

    const xpPct = char.xpForNextLevel > 0 ? (char.xp / char.xpForNextLevel) * 100 : 0;
    this.xpFill.style.width = `${xpPct}%`;

    // XP rate tracking
    const totalXp = CharacterScreen.computeTotalXp(char.level, char.xp);
    if (this.lastTotalXp >= 0) {
      const delta = totalXp - this.lastTotalXp;
      if (delta > 0) this.xpRateTotal += delta;
    }
    this.lastTotalXp = totalXp;

    const elapsedHours = (Date.now() - this.xpRateStartTime) / 3_600_000;
    const rate = elapsedHours > 0 ? this.xpRateTotal / elapsedHours : 0;
    this.xpRateEl.textContent = CharacterScreen.formatXpRate(rate);

    this.hpDisplay.textContent = `${char.maxHp}`;
    this.goldDisplay.textContent = char.gold.toLocaleString();

    // Equipment combat bonuses
    const bonuses = computeEquipmentBonuses(char.equipment, state.itemDefinitions ?? {});
    const hasAtk = bonuses.bonusAttackMax > 0;
    const hasDef = bonuses.damageReductionMax > 0;
    this.combatBonuses.innerHTML = `
      <div class="character-bonus-row">
        <span class="character-bonus-label">Attack bonus</span>
        <span class="character-bonus-value${hasAtk ? ' active' : ''}">${hasAtk ? `+${bonuses.bonusAttackMin}-${bonuses.bonusAttackMax}` : 'None'}</span>
      </div>
      <div class="character-bonus-row">
        <span class="character-bonus-label">Damage reduction</span>
        <span class="character-bonus-value${hasDef ? ' active' : ''}">${hasDef ? `${bonuses.damageReductionMin}-${bonuses.damageReductionMax}` : 'None'}</span>
      </div>
      <div class="character-bonus-row">
        <span class="character-bonus-label">Dodge chance</span>
        <span class="character-bonus-value${bonuses.dodgeChance > 0 ? ' active' : ''}">${bonuses.dodgeChance > 0 ? `${Math.round(bonuses.dodgeChance * 100)}%` : '0%'}</span>
      </div>
    `;

    // Class passive info
    const classDef = CLASS_DEFINITIONS[char.className as ClassName];
    if (classDef) {
      let passiveText = '';
      if (classDef.physicalReductionBase > 0 || classDef.physicalReductionPerLevel > 0) {
        const val = classDef.physicalReductionBase + classDef.physicalReductionPerLevel * char.level;
        passiveText = `Physical damage reduction: ${val}`;
      } else if (classDef.partyMagicalReductionBase > 0 || classDef.partyMagicalReductionPerLevel > 0) {
        const val = classDef.partyMagicalReductionBase + classDef.partyMagicalReductionPerLevel * char.level;
        passiveText = `Party magic resistance: ${val}`;
      } else if (classDef.bardStatMultiplierPerMember > 0) {
        passiveText = `Party stat buff: +${Math.round(classDef.bardStatMultiplierPerMember * 100)}% per member`;
      }
      if (classDef.attackStat) {
        const atkVal = char.stats[classDef.attackStat];
        passiveText += (passiveText ? ' | ' : '') + `Attack: ${classDef.attackStat} (${atkVal})`;
      } else {
        passiveText += (passiveText ? ' | ' : '') + 'Attack: None';
      }
      this.classPassiveEl.textContent = passiveText;
    }

    // Stats table (simplified — stats are fixed per class)
    this.statsTable.innerHTML = STAT_NAMES.map(stat => {
      const total = char.stats[stat];
      return `<tr data-tooltip="${STAT_TOOLTIPS[stat]}">
        <td class="character-stat-name">${stat}</td>
        <td class="character-stat-total">${total}</td>
      </tr>`;
    }).join('');
  }
}
