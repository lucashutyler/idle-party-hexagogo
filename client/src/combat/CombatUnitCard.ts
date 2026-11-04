import type { MonsterTier } from '@idle-party-rpg/shared';
import type { PlaybackUnit } from './CombatPlayback';
import { deferWhilePressed, setHtml } from '../ui/render';
import { escapeHtml, formatAmount, hpTier, initials, MAX_VISIBLE_PIPS, pipsKey, statusPips, TIER_INFO } from './CombatFormat';
import type { MonsterLevelBadge } from './CombatFormat';

export interface CardIdentity {
  name: string;
  isSelf: boolean;
  henchman: boolean;
  passive: boolean;
  /** Primary art URL, then an optional fallback; the icon, emoji or initials show until one loads. */
  art?: string;
  artFallback?: string;
  /** Small icon image (class icon) layered over the initials. */
  icon?: string;
  /** Replaces the initials (henchman emoji). */
  emoji?: string;
  /** Authored monster levels only; derived levels show no number. */
  level?: MonsterLevelBadge | null;
  tier?: MonsterTier;
}

const CHANGE_EPSILON = 0.005;
const TIMER_EPSILON = 0.02;

/** One combatant's card. Writes to the DOM only when a value visibly changes. */
export class UnitCard {
  readonly el: HTMLElement;
  readonly body: HTMLElement;
  readonly flashEl: HTMLElement;
  readonly glowEl: HTMLElement;
  private readonly img: HTMLImageElement;
  private readonly classIcon: HTMLImageElement;
  private readonly iconEl: HTMLElement;
  private readonly nameEl: HTMLElement;
  private readonly pipsEl: HTMLElement;
  private readonly castLabel: HTMLElement;
  private readonly levelEl: HTMLElement;
  private readonly tierEl: HTMLElement;
  private readonly ringEl: HTMLElement;
  private readonly castFill: HTMLElement;
  private readonly hpNow: HTMLElement;
  private readonly hpMax: HTMLElement;
  private identityKey = '';
  private lastHpText = '';
  private lastAct = -1;
  private lastHp = -1;
  private lastShield = -1;
  private lastCast = -1;
  private lastCastKey = '';
  private lastPips = '';
  private lastStatuses: unknown = null;
  private lastPipFlags = '';
  private lastTier = '';
  private lastDead: boolean | null = null;
  private lastStunned: boolean | null = null;
  private lastPaused: boolean | null = null;
  private lastTargeted = false;
  private lastEnraged = false;
  private brokenUntil = 0;

  constructor(readonly key: string, side: 'player' | 'monster', pos: number) {
    this.el = document.createElement('div');
    this.el.className = 'combat-card';
    this.el.dataset.grid = String(pos);
    this.el.dataset.side = side;
    this.el.innerHTML = `
      <div class="combat-card-body">
        <div class="combat-card-portrait">
          <div class="combat-card-ring"></div>
          <div class="combat-card-art">
            <span class="combat-card-icon"></span>
            <img class="combat-card-classicon" alt="" draggable="false" />
            <img class="combat-card-img" alt="" draggable="false" />
          </div>
          <div class="combat-card-flash"></div>
          <div class="combat-card-glow"></div>
          <div class="combat-card-stun"><span>💫</span></div>
          <span class="combat-card-tier" aria-hidden="true"></span>
          <span class="combat-card-level lvl-badge"></span>
        </div>
        <div class="combat-card-info">
          <div class="combat-card-name"></div>
          <div class="combat-card-hp">
            <div class="combat-card-hp-chip"></div>
            <div class="combat-card-hp-fill"></div>
            <div class="combat-card-hp-shield"></div>
            <div class="combat-card-hp-text"><b></b><span></span></div>
          </div>
          <div class="combat-card-pips"></div>
        </div>
      </div>
      <div class="combat-card-cast"><div class="combat-card-cast-fill"></div><span class="combat-card-cast-label"></span></div>
    `;
    this.body = this.el.querySelector('.combat-card-body')!;
    this.flashEl = this.el.querySelector('.combat-card-flash')!;
    this.glowEl = this.el.querySelector('.combat-card-glow')!;
    this.img = this.el.querySelector('.combat-card-img')!;
    this.classIcon = this.el.querySelector('.combat-card-classicon')!;
    this.iconEl = this.el.querySelector('.combat-card-icon')!;
    this.nameEl = this.el.querySelector('.combat-card-name')!;
    this.pipsEl = this.el.querySelector('.combat-card-pips')!;
    this.castLabel = this.el.querySelector('.combat-card-cast-label')!;
    this.levelEl = this.el.querySelector('.combat-card-level')!;
    this.tierEl = this.el.querySelector('.combat-card-tier')!;
    this.ringEl = this.el.querySelector('.combat-card-ring')!;
    this.castFill = this.el.querySelector('.combat-card-cast-fill')!;
    this.hpNow = this.el.querySelector('.combat-card-hp-text b')!;
    this.hpMax = this.el.querySelector('.combat-card-hp-text span')!;
  }

  setIdentity(id: CardIdentity): void {
    const level = id.level ? `${id.level.level}:${id.level.con}` : '';
    const key = `${id.name}|${id.isSelf}|${id.henchman}|${id.passive}|${id.art ?? ''}|${id.icon ?? ''}|${id.emoji ?? ''}|${level}|${id.tier ?? ''}`;
    if (key === this.identityKey) return;
    this.identityKey = key;
    this.el.classList.toggle('self', id.isSelf);
    this.el.classList.toggle('henchman', id.henchman);
    this.el.classList.toggle('passive', id.passive);
    this.el.classList.toggle('one-word', !/\s/.test(id.name.trim()));
    this.nameEl.textContent = id.name;
    this.el.title = id.tier && id.tier !== 'trash' ? `${id.name} (${TIER_INFO[id.tier].label})` : id.name;
    this.iconEl.textContent = id.emoji || initials(id.name);
    this.iconEl.classList.toggle('emoji', !!id.emoji);
    loadImage(this.classIcon, id.icon, undefined);
    loadImage(this.img, id.art, id.artFallback);
    this.writeTier(id.tier);
    this.writeLevel(id.level ?? null);
  }

  update(unit: PlaybackUnit, now: number): void {
    const dead = unit.hp <= 0;
    if (dead !== this.lastDead) {
      this.lastDead = dead;
      this.el.classList.toggle('dead', dead);
    }
    const stunned = !dead && unit.stunMs > 0;
    if (stunned !== this.lastStunned) {
      this.lastStunned = stunned;
      this.el.classList.toggle('stunned', stunned);
    }

    const hpFrac = unit.maxHp > 0 ? Math.max(0, Math.min(1, unit.hp / unit.maxHp)) : 0;
    if (Math.abs(hpFrac - this.lastHp) >= CHANGE_EPSILON || (hpFrac === 0) !== (this.lastHp === 0)) {
      this.lastHp = hpFrac;
      this.el.style.setProperty('--hp', hpFrac.toFixed(4));
      const tier = hpTier(hpFrac);
      if (tier !== this.lastTier) {
        this.lastTier = tier;
        this.el.dataset.hp = tier;
      }
    }
    this.writeHpText(unit);
    const shieldFrac = unit.maxHp > 0 ? Math.min(1, unit.shield / unit.maxHp) : 0;
    if (Math.abs(shieldFrac - this.lastShield) >= CHANGE_EPSILON) {
      this.lastShield = shieldFrac;
      this.el.style.setProperty('--shield', shieldFrac.toFixed(4));
    }

    const act = dead || unit.actionTotalMs <= 0 ? 0 : 1 - Math.max(0, Math.min(1, unit.actionMs / unit.actionTotalMs));
    if (Math.abs(act - this.lastAct) >= TIMER_EPSILON || (act === 0 && this.lastAct !== 0)) {
      this.lastAct = act;
      this.ringEl.style.setProperty('--act', act.toFixed(2));
    }

    const enraged = !dead && (unit.enrage?.stacks ?? 0) > 0;
    if (enraged !== this.lastEnraged) {
      this.lastEnraged = enraged;
      this.el.classList.toggle('enraged', enraged);
    }

    this.updateCast(unit, dead, now);

    const flags = `${dead}|${stunned}|${unit.shield > 0 ? Math.round(unit.shield) : 0}`;
    if (unit.statuses === this.lastStatuses && flags === this.lastPipFlags) return;
    this.lastStatuses = unit.statuses;
    this.lastPipFlags = flags;
    const pips = statusPips(unit);
    const pk = pipsKey(pips);
    if (pk !== this.lastPips) {
      this.lastPips = pk;
      const shown = pips.slice(0, MAX_VISIBLE_PIPS);
      const extra = pips.length - shown.length;
      const html = shown.map(p => `<span class="combat-pip ${p.tone}" title="${escapeHtml(p.title)}">${p.icon}${p.count ? `<b>${p.count}</b>` : ''}</span>`).join('')
        + (extra > 0 ? `<span class="combat-pip more">+${extra}</span>` : '');
      deferWhilePressed(this.el, () => setHtml(this.pipsEl, html));
    }
  }

  /** Anchors the floating cast label inward when the card sits at a stage edge. */
  setEdge(edge: 'left' | 'right' | ''): void {
    if ((this.el.dataset.edge ?? '') === edge) return;
    if (edge) this.el.dataset.edge = edge;
    else delete this.el.dataset.edge;
  }

  setTargeted(targeted: boolean): void {
    if (targeted === this.lastTargeted) return;
    this.lastTargeted = targeted;
    this.el.classList.toggle('targeted', targeted);
  }

  /** Keep the cancelled cast bar on screen briefly under the COUNTERED! stamp. */
  breakCast(now: number): void {
    this.brokenUntil = now + 650;
    this.el.classList.add('cast-broken');
  }

  private writeHpText(unit: PlaybackUnit): void {
    const now = formatAmount(Math.max(0, unit.hp));
    const max = formatAmount(unit.maxHp);
    const text = `${now}/${max}`;
    if (text === this.lastHpText) return;
    this.lastHpText = text;
    this.hpNow.textContent = now;
    this.hpMax.textContent = ` / ${max}`;
  }

  private writeTier(tier: MonsterTier | undefined): void {
    const shown = tier && tier !== 'trash' ? tier : undefined;
    if (shown) this.el.dataset.tier = shown;
    else delete this.el.dataset.tier;
    this.tierEl.textContent = shown ? TIER_INFO[shown].glyph : '';
  }

  private writeLevel(badge: MonsterLevelBadge | null): void {
    this.el.classList.toggle('has-level', !!badge);
    if (!badge) {
      this.levelEl.textContent = '';
      this.levelEl.removeAttribute('data-con');
      this.levelEl.removeAttribute('aria-label');
      this.levelEl.removeAttribute('title');
      return;
    }
    this.levelEl.dataset.con = badge.con;
    this.levelEl.setAttribute('aria-label', `Level ${badge.level}, ${badge.label}`);
    this.levelEl.title = `Level ${badge.level} · ${badge.label}`;
    this.levelEl.innerHTML = `<i aria-hidden="true">${escapeHtml(badge.glyph)}</i>${badge.level}`;
  }

  private updateCast(unit: PlaybackUnit, dead: boolean, now: number): void {
    const cast = dead ? null : unit.cast;
    if (!cast) {
      if (this.brokenUntil > 0 && (dead || now >= this.brokenUntil)) {
        this.brokenUntil = 0;
        this.el.classList.remove('cast-broken');
      }
      if (this.lastCastKey !== '' && this.brokenUntil === 0) {
        this.lastCastKey = '';
        this.el.classList.remove('casting', 'cast-paused');
        this.lastPaused = null;
      }
      return;
    }
    if (this.brokenUntil > 0) {
      this.brokenUntil = 0;
      this.el.classList.remove('cast-broken');
    }
    const castKey = `${cast.skillId}:${cast.totalMs}`;
    if (castKey !== this.lastCastKey) {
      this.lastCastKey = castKey;
      this.el.classList.add('casting');
      this.castLabel.textContent = cast.skill;
      this.lastCast = -1;
    }
    const paused = unit.side === 'player' && unit.stunMs > 0;
    if (paused !== this.lastPaused) {
      this.lastPaused = paused;
      this.el.classList.toggle('cast-paused', paused);
    }
    const progress = cast.totalMs > 0 ? 1 - Math.max(0, Math.min(1, cast.remainingMs / cast.totalMs)) : 1;
    if (Math.abs(progress - this.lastCast) >= TIMER_EPSILON) {
      this.lastCast = progress;
      this.castFill.style.setProperty('--cast', progress.toFixed(2));
    }
  }
}

/** Reveal on load, try one fallback, hide on failure so the layer below shows through. */
function loadImage(img: HTMLImageElement, real: string | undefined, fallback: string | undefined): void {
  img.onerror = null;
  img.onload = null;
  img.classList.remove('loaded');
  if (!real) {
    img.removeAttribute('src');
    img.style.display = 'none';
    return;
  }
  img.style.display = '';
  img.dataset.fb = '0';
  img.onload = () => img.classList.add('loaded');
  img.onerror = () => {
    if (fallback && img.dataset.fb !== '1') {
      img.dataset.fb = '1';
      img.src = fallback;
    } else {
      img.style.display = 'none';
    }
  };
  img.src = real;
}
