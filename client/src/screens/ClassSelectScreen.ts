import type { Screen } from './ScreenManager';
import { OFFLINE_NOTICE, type GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import { ALL_CLASS_NAMES, CLASS_DEFINITIONS, COMBAT_PACE, classIconHtml, getSkillsForClass, paceActionSeconds, paceHitDamage, paceKit } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';
import { artworkUrl, renderTrackedImg } from '../ui/assets';
import { classAttackSkill, snappedSeconds } from '../ui/SkillCardChip';
import { escapeHtml } from '../ui/ItemIcon';

function oneDecimal(value: number): number {
  return Math.round(value * 10) / 10;
}

export const CLASS_CHOICE_TIMEOUT_MS = 10000;
export const CLASS_NO_REPLY_NOTICE = 'No answer from the server. Please try again.';

const PICK_LABEL = 'Pick a class';
const CREATING_LABEL = 'Creating…';

export class ClassSelectScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private worldCache: WorldCache;
  private onClassChosen: () => void;
  private selectedClass: ClassName | null = null;
  private confirmBtn!: HTMLButtonElement;
  private errorEl!: HTMLElement;
  private cards!: HTMLElement[];
  private waiting = false;
  private replyTimer: ReturnType<typeof setTimeout> | null = null;
  private unsubscribeState: (() => void) | null = null;
  private unsubscribeError: (() => void) | null = null;

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
    this.stopWaiting();
    this.selectedClass = null;
    this.showError('');
    this.paintSelection();
  }

  onDeactivate(): void {
    this.stopWaiting();
    this.unsubscribeState?.();
    this.unsubscribeState = null;
  }

  private buildDOM(): void {
    const skillContent = this.worldCache.getSkillContent();
    const cards = ALL_CLASS_NAMES.map((cn, i) => {
      const def = CLASS_DEFINITIONS[cn];
      const startingSkill = getSkillsForClass(cn, skillContent)
        .find(s => s.type === 'passive' && s.unlockLevel === 1);
      const attack = classAttackSkill(cn, skillContent.skills);
      const actionSeconds = attack
        ? snappedSeconds(attack.charge) + snappedSeconds(attack.recovery)
        : paceActionSeconds(COMBAT_PACE, cn);
      const art = renderTrackedImg(artworkUrl('class', cn), { className: 'class-card-img', alt: '' });

      return `
        <div class="class-card" data-class="${cn}" role="radio" aria-checked="false" tabindex="${i === 0 ? 0 : -1}">
          <div class="class-card-art">
            <span class="class-card-icon">${classIconHtml(cn)}</span>
            ${art}
          </div>
          <div class="class-card-main">
            <span class="class-card-title">${escapeHtml(def.displayName)}</span>
            <div class="class-card-desc">${escapeHtml(def.description)}</div>
            <div class="class-card-stats">
              <span>${def.baseHp} HP, +${def.hpPerLevel} a level</span>
              <span>${paceHitDamage(COMBAT_PACE, cn, def.baseDamage)} ${escapeHtml(def.damageType)} damage, +${oneDecimal(def.damagePerLevel * paceKit(COMBAT_PACE, cn))} a level</span>
              <span>Acts every ${oneDecimal(actionSeconds)} seconds</span>
            </div>
            ${startingSkill ? `<div class="class-card-passive">${escapeHtml(startingSkill.name)}: ${escapeHtml(startingSkill.description)}</div>` : ''}
          </div>
        </div>
      `;
    }).join('');

    this.container.innerHTML = `
      <div class="class-select-content">
        <h1 class="login-title">Choose Your Class</h1>
        <p class="login-subtitle">Each class is weak alone but powerful in a party.</p>
        <div class="class-card-list" role="radiogroup" aria-label="Class">
          ${cards}
        </div>
        <div class="class-confirm-bar">
          <div class="login-error" role="alert"></div>
          <button type="button" class="login-button class-confirm-btn" disabled>${PICK_LABEL}</button>
        </div>
      </div>
    `;

    this.confirmBtn = this.container.querySelector('.class-confirm-btn')!;
    this.errorEl = this.container.querySelector('.login-error')!;
    this.cards = [...this.container.querySelectorAll<HTMLElement>('.class-card')];

    const list = this.container.querySelector<HTMLElement>('.class-card-list')!;
    list.addEventListener('click', (e) => {
      const card = e.target instanceof Element ? e.target.closest<HTMLElement>('.class-card') : null;
      if (card) this.select(card);
    });
    list.addEventListener('keydown', (e) => this.handleKeydown(e));
    this.confirmBtn.addEventListener('click', () => this.confirm());
  }

  private handleKeydown(e: KeyboardEvent): void {
    const current = e.target instanceof Element ? e.target.closest<HTMLElement>('.class-card') : null;
    if (!current) return;
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      this.select(current);
      return;
    }
    const step = e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const next = this.cards[(this.cards.indexOf(current) + step + this.cards.length) % this.cards.length];
    this.select(next);
    next.focus();
  }

  private select(card: HTMLElement): void {
    if (this.waiting) return;
    this.selectedClass = card.dataset.class as ClassName;
    this.showError('');
    this.paintSelection();
  }

  private paintSelection(): void {
    this.cards.forEach((card, i) => {
      const on = card.dataset.class === this.selectedClass;
      card.classList.toggle('selected', on);
      card.setAttribute('aria-checked', String(on));
      card.tabIndex = on || (!this.selectedClass && i === 0) ? 0 : -1;
    });
    this.confirmBtn.disabled = !this.selectedClass;
    this.confirmBtn.textContent = this.selectedClass
      ? `Play as ${CLASS_DEFINITIONS[this.selectedClass].displayName}`
      : PICK_LABEL;
  }

  private confirm(): void {
    if (!this.selectedClass || this.waiting) return;
    if (!this.gameClient.sendSetClass(this.selectedClass)) {
      this.showError(OFFLINE_NOTICE);
      return;
    }
    this.waiting = true;
    this.showError('');
    this.confirmBtn.disabled = true;
    this.confirmBtn.textContent = CREATING_LABEL;

    // A reply that beats a shown timeout still enters the game, so this outlives the wait.
    this.unsubscribeState ??= this.gameClient.subscribe((state) => {
      if (state.character === null) return;
      this.stopWaiting();
      this.unsubscribeState?.();
      this.unsubscribeState = null;
      // Defer so enterGame() runs outside the subscriber loop and its errors surface.
      queueMicrotask(() => this.onClassChosen());
    });
    this.unsubscribeError = this.gameClient.onServerError((message, code) => {
      if (!code) this.failWaiting(message);
    });
    this.replyTimer = setTimeout(() => this.failWaiting(CLASS_NO_REPLY_NOTICE), CLASS_CHOICE_TIMEOUT_MS);
  }

  private failWaiting(message: string): void {
    this.stopWaiting();
    this.paintSelection();
    this.showError(message);
  }

  private stopWaiting(): void {
    this.waiting = false;
    if (this.replyTimer !== null) clearTimeout(this.replyTimer);
    this.replyTimer = null;
    this.unsubscribeError?.();
    this.unsubscribeError = null;
  }

  private showError(message: string): void {
    this.errorEl.style.display = message ? 'block' : 'none';
    this.errorEl.textContent = message;
  }
}
