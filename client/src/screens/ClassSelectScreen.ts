import type { Screen } from './ScreenManager';
import type { GameClient } from '../network/GameClient';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';

const CLASS_ICONS: Record<string, string> = {
  Knight: '\u2694',
  Archer: '\uD83C\uDFF9',
  Priest: '\u2728',
  Mage: '\uD83D\uDD25',
  Bard: '\uD83C\uDFB5',
};

export class ClassSelectScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private onClassChosen: () => void;
  private selectedClass: ClassName | null = null;
  private confirmBtn!: HTMLButtonElement;

  constructor(containerId: string, gameClient: GameClient, onClassChosen: () => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.onClassChosen = onClassChosen;

    this.buildDOM();
  }

  onActivate(): void {
    this.selectedClass = null;
    this.confirmBtn.disabled = true;
    this.container.querySelectorAll('.class-card').forEach(c => c.classList.remove('selected'));
  }

  onDeactivate(): void {
    // no-op
  }

  private buildDOM(): void {
    const cards = ALL_CLASS_NAMES.map(cn => {
      const def = CLASS_DEFINITIONS[cn];
      const stats = def.baseStats;
      const atkLabel = def.attackStat
        ? `${def.attackStat} ${stats[def.attackStat]}`
        : 'None';
      const hpLabel = `${def.hpMultiplier}x`;

      let passiveText = 'No passive';
      if (def.physicalReductionBase > 0 || def.physicalReductionPerLevel > 0) {
        passiveText = `Physical reduction: ${def.physicalReductionBase}+${def.physicalReductionPerLevel}/lv`;
      } else if (def.partyMagicalReductionBase > 0 || def.partyMagicalReductionPerLevel > 0) {
        passiveText = `Party magic resist: ${def.partyMagicalReductionBase}+${def.partyMagicalReductionPerLevel}/lv`;
      } else if (def.bardStatMultiplierPerMember > 0) {
        passiveText = `+${Math.round(def.bardStatMultiplierPerMember * 100)}% stats/member`;
      }

      return `
        <div class="class-card" data-class="${cn}">
          <div class="class-card-header">
            <span class="class-card-icon">${CLASS_ICONS[cn] ?? '?'}</span>
            <span class="class-card-title">${def.displayName}</span>
          </div>
          <div class="class-card-desc">${def.description}</div>
          <div class="class-card-stats">
            <span>ATK: ${atkLabel}</span>
            <span>HP: ${hpLabel}</span>
            <span>CON: ${stats.CON}</span>
          </div>
          <div class="class-card-passive">${passiveText}</div>
        </div>
      `;
    }).join('');

    this.container.innerHTML = `
      <div class="class-select-content">
        <h1 class="login-title">Choose Your Class</h1>
        <p class="login-subtitle">Each class is weak alone but powerful in a party.</p>
        <div class="class-card-list">
          ${cards}
        </div>
        <button class="login-button class-confirm-btn" disabled>Choose Class</button>
      </div>
    `;

    this.confirmBtn = this.container.querySelector('.class-confirm-btn')!;

    // Wire card clicks
    this.container.querySelectorAll('.class-card').forEach(card => {
      card.addEventListener('click', () => {
        this.container.querySelectorAll('.class-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this.selectedClass = card.getAttribute('data-class') as ClassName;
        this.confirmBtn.disabled = false;
      });
    });

    // Wire confirm
    this.confirmBtn.addEventListener('click', () => {
      if (!this.selectedClass) return;
      this.confirmBtn.disabled = true;
      this.confirmBtn.textContent = 'Creating...';
      this.gameClient.sendSetClass(this.selectedClass);

      // Listen for the state update confirming class change
      const unsub = this.gameClient.subscribe((state) => {
        if (state.character.className !== 'Adventurer') {
          unsub();
          this.onClassChosen();
        }
      });
    });
  }
}
