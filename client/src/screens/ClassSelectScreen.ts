import type { Screen } from './ScreenManager';
import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS, classIconHtml, getSkillsForClass } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';

export class ClassSelectScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private onClassChosen: () => void;
  private selectedClass: ClassName | null = null;
  private confirmBtn!: HTMLButtonElement;

  constructor(containerId: string, gameClient: GameClient, worldCache: WorldCache, onClassChosen: () => void) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
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
    const esc = (s: string) => s
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const skillContent = this.worldCache.getSkillContent();
    const cards = ALL_CLASS_NAMES.map(cn => {
      const def = CLASS_DEFINITIONS[cn];
      // Starting-skill preview: the class's level-1 passive. getSkillsForClass
      // returns skills sorted by sortOrder, so the first match wins ties.
      const startingSkill = getSkillsForClass(cn, skillContent)
        .find(s => s.type === 'passive' && s.unlockLevel === 1);
      const skillText = startingSkill ? `${esc(startingSkill.name)}: ${esc(startingSkill.description)}` : 'No starting skill';

      return `
        <div class="class-card" data-class="${cn}">
          <div class="class-card-header">
            <span class="class-card-icon">${classIconHtml(cn)}</span>
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
        if (state.character !== null) {
          unsub();
          // Defer to next microtask so enterGame() runs outside the subscriber
          // loop — errors propagate properly instead of being swallowed
          queueMicrotask(() => this.onClassChosen());
        }
      });
    });
  }
}
