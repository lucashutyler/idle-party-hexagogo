import type { Screen } from './ScreenManager';
import type { GameClient } from '../network/GameClient';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS, SKILL_TREES } from '@idle-party-rpg/shared';
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
      const tree = SKILL_TREES[cn] ?? [];
      const startingSkill = tree.find(s => s.treeOrder === 0);
      const skillText = startingSkill ? `${startingSkill.name}: ${startingSkill.description}` : 'No starting skill';

      return `
        <div class="class-card" data-class="${cn}">
          <div class="class-card-header">
            <span class="class-card-icon">${CLASS_ICONS[cn] ?? '?'}</span>
            <span class="class-card-title">${def.displayName}</span>
          </div>
          <div class="class-card-desc">${def.description}</div>
          <div class="class-card-stats">
            <span>HP: ${def.baseHp} +${def.hpPerLevel}/lv</span>
            <span>DMG: ${def.baseDamage} +${def.damagePerLevel}/lv (${def.damageType})</span>
          </div>
          <div class="class-card-passive">${skillText}</div>
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
          // Defer to next microtask so enterGame() runs outside the subscriber
          // loop — errors propagate properly instead of being swallowed
          queueMicrotask(() => this.onClassChosen());
        }
      });
    });
  }
}
