import type { ClientCombatSkill, SkillCardType } from '@idle-party-rpg/shared';
import { SKILL_CARD_TYPE_INFO } from '@idle-party-rpg/shared';
import { fx, reducedMotion } from '../ui/motion';
import { setHtml } from '../ui/render';
import { escapeHtml, formatSeconds } from './CombatFormat';

export interface SkillBarCard {
  id: string;
  name: string;
  cardType: SkillCardType;
}

export interface SkillBarChip {
  id: string;
  name: string;
  cardType: SkillCardType;
}

export interface SkillBarLayout {
  cards: SkillBarCard[];
  passives: SkillBarChip[];
  /** Muted trailing note ("Active skill unlocks at level 5", "Joining next battle"). */
  note?: string;
  /** The note leads to the Skills view, where it can be acted on. */
  noteLinksToSkills?: boolean;
}

export interface SkillBarState {
  id: string;
  state: ClientCombatSkill['state'];
  remainingMs: number;
  cooldownMs: number;
  castProgress?: number;
  /** The player is recovering from a skill, so none can be used yet. */
  locked?: boolean;
}

const SWEEP_EPSILON = 0.02;

const LOCKED_LABEL = 'LOCKED';

const STATE_LABEL: Record<ClientCombatSkill['state'], string> = {
  ready: 'READY',
  held: 'WAITING',
  armed: 'ARMED',
  casting: 'CASTING',
  cooldown: '',
};

interface CardRefs {
  el: HTMLElement;
  sweepEl: HTMLElement;
  status: HTMLElement;
  lastState: string;
  lastLocked: boolean;
  lastSweep: number;
  lastText: string;
}

/** The viewer's skill cards (cooldown sweeps, states) followed by passive chips. */
export class CombatSkillBar {
  private readonly root: HTMLElement;
  private readonly track: HTMLElement;
  private layoutKey = '';
  private cards = new Map<string, CardRefs>();

  constructor(root: HTMLElement, onTap: (skillId: string, anchor: HTMLElement) => void) {
    this.root = root;
    this.track = document.createElement('div');
    this.track.className = 'combat-skillbar-track';
    this.root.appendChild(this.track);
    this.track.addEventListener('click', (e) => {
      const target = (e.target as HTMLElement).closest<HTMLElement>('[data-skill-id]');
      if (!target) return;
      e.stopPropagation();
      onTap(target.dataset.skillId!, target);
    });
  }

  setLayout(layout: SkillBarLayout): void {
    const key = JSON.stringify(layout);
    if (key === this.layoutKey) return;
    this.layoutKey = key;
    this.cards.clear();
    const parts: string[] = [];
    for (const card of layout.cards) {
      const info = SKILL_CARD_TYPE_INFO[card.cardType];
      parts.push(`
        <button type="button" class="combat-skill" data-skill-id="${escapeHtml(card.id)}" data-card-type="${card.cardType}" data-state="ready">
          <span class="combat-skill-sweep"></span>
          <span class="combat-skill-fill"></span>
          <span class="combat-skill-top"><span class="combat-skill-icon">${info.icon}</span><span class="combat-skill-name">${escapeHtml(card.name)}</span></span>
          <span class="combat-skill-bottom"><span class="combat-skill-badge">${escapeHtml(info.label)}</span><span class="combat-skill-status"></span></span>
        </button>`);
    }
    for (const chip of layout.passives) {
      const info = SKILL_CARD_TYPE_INFO[chip.cardType];
      parts.push(`<button type="button" class="combat-skill-passive" data-skill-id="${escapeHtml(chip.id)}" data-card-type="${chip.cardType}" title="${escapeHtml(chip.name)}"><span class="combat-skill-passive-icon">${info.icon}</span><span class="combat-skill-passive-name">${escapeHtml(chip.name)}</span></button>`);
    }
    if (layout.note) {
      const note = escapeHtml(layout.note);
      parts.push(layout.noteLinksToSkills
        ? `<button type="button" class="combat-skillbar-note combat-skillbar-link" data-nav="items:skills">${note}<span aria-hidden="true">›</span></button>`
        : `<span class="combat-skillbar-note">${note}</span>`);
    }
    setHtml(this.track, parts.join(''));
    this.root.classList.toggle('empty', layout.cards.length === 0);
    for (const el of this.track.querySelectorAll<HTMLElement>('.combat-skill')) {
      this.cards.set(el.dataset.skillId!, {
        el,
        sweepEl: el.querySelector('.combat-skill-sweep')!,
        status: el.querySelector('.combat-skill-status')!,
        lastState: '',
        lastLocked: false,
        lastSweep: -1,
        lastText: '',
      });
    }
  }

  /** Per-frame values; `writeText` gates the countdown text to ≤ 10 Hz. */
  update(states: readonly SkillBarState[], writeText: boolean): void {
    for (const s of states) {
      const refs = this.cards.get(s.id);
      if (!refs) continue;
      const stateChanged = s.state !== refs.lastState;
      if (stateChanged) {
        refs.lastState = s.state;
        refs.el.dataset.state = s.state;
      }
      const locked = !!s.locked;
      const lockChanged = locked !== refs.lastLocked;
      if (lockChanged) {
        refs.lastLocked = locked;
        refs.el.classList.toggle('locked', locked);
      }
      const sweep = s.state === 'casting'
        ? s.castProgress ?? 0
        : s.state === 'cooldown' && s.cooldownMs > 0 ? Math.max(0, Math.min(1, s.remainingMs / s.cooldownMs)) : 0;
      if (Math.abs(sweep - refs.lastSweep) >= SWEEP_EPSILON || (sweep === 0 && refs.lastSweep !== 0)) {
        refs.lastSweep = sweep;
        refs.sweepEl.style.setProperty('--cd', sweep.toFixed(2));
      }
      if (writeText || stateChanged || lockChanged) {
        const text = s.state === 'cooldown'
          ? `${formatSeconds(s.remainingMs)}s`
          : locked && (s.state === 'ready' || s.state === 'armed') ? LOCKED_LABEL : STATE_LABEL[s.state];
        if (text !== refs.lastText) {
          refs.lastText = text;
          refs.status.textContent = text;
        }
      }
    }
  }

  flash(skillId: string): void {
    const refs = this.cards.get(skillId);
    if (!refs) return;
    const glow = refs.el.querySelector('.combat-skill-fill') as HTMLElement | null;
    if (!glow) return;
    fx(glow, [{ opacity: 0.95 }, { opacity: 0 }], { duration: 450, easing: 'ease-out' });
    if (!reducedMotion()) {
      fx(refs.el, [{ transform: 'translateY(0) scale(1)' }, { transform: 'translateY(-4px) scale(1.06)', offset: 0.3 }, { transform: 'translateY(0) scale(1)' }], { duration: 320, easing: 'cubic-bezier(.34,1.56,.64,1)' });
    }
  }
}
