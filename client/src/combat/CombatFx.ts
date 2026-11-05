import { fx, reducedMotion } from '../ui/motion';
import { escapeHtml, formatAmount } from './CombatFormat';

/** A card's centre and size in stage coordinates. */
export interface FxPoint {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type FloaterVariant = 'physical' | 'magical' | 'holy' | 'heal' | 'shield' | 'text-bad' | 'text-good' | 'text-info';

interface Floater {
  el: HTMLElement;
  key: string;
  variant: FloaterVariant;
  amount: number;
  crit: boolean;
  overTime: boolean;
  bornAt: number;
  busy: boolean;
  anim: Animation | null;
  slot: number;
  timer?: ReturnType<typeof setTimeout>;
}

export const FLOATER_POOL_SIZE = 24;
export const FLOATERS_PER_UNIT = 2;
export const FLOATER_MERGE_MS = 150;
const MAX_REACTION_CARDS = 4;
const STACK_OFFSET_PX = 20;
const BANNER_MAX_MS = 1400;
const LONG_BANNER_CHARS = 8;

export type BannerTone = 'fight' | 'boss' | 'enrage' | 'checkpoint' | 'regroup' | 'victory' | 'defeat' | 'retreat';

/** A banner never replaces a higher-priority one still showing; it waits up to BANNER_QUEUE_MS instead. */
export const BANNER_PRIORITY: Record<BannerTone, number> = {
  fight: 0,
  boss: 1,
  enrage: 2,
  checkpoint: 3,
  regroup: 4,
  victory: 5,
  defeat: 5,
  retreat: 5,
};
export const BANNER_QUEUE_MS = 1000;

interface BannerRequest {
  text: string;
  tone: BannerTone;
  holdMs: number;
  sub?: string;
  expiresAt: number;
}

/** Transient combat effects drawn over the stage: numbers, callouts, banners. Only transform/opacity animate. */
export class CombatFx {
  private readonly layer: HTMLElement;
  private readonly shakeTarget: HTMLElement;
  private readonly bannerEl: HTMLElement;
  private readonly svg: SVGSVGElement;
  private readonly floaters: Floater[] = [];
  private reactionCards: HTMLElement[] = [];
  private readonly clock: () => number;
  private bannerTimer?: ReturnType<typeof setTimeout>;
  private bannerAnim: Animation | null = null;
  private bannerShown: BannerTone | null = null;
  private bannerQueue: BannerRequest[] = [];

  constructor(layer: HTMLElement, shakeTarget: HTMLElement, banner: HTMLElement, clock: () => number = () => performance.now()) {
    this.layer = layer;
    this.shakeTarget = shakeTarget;
    this.bannerEl = banner;
    this.clock = clock;
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.setAttribute('class', 'combat-fx-svg');
    this.layer.appendChild(this.svg);
    for (let i = 0; i < FLOATER_POOL_SIZE; i++) {
      const el = document.createElement('span');
      el.className = 'combat-floater';
      this.layer.appendChild(el);
      this.floaters.push({ el, key: '', variant: 'physical', amount: 0, crit: false, overTime: false, bornAt: -Infinity, busy: false, anim: null, slot: 0 });
    }
  }

  get liveFloaters(): number {
    return this.floaters.filter(f => f.busy).length;
  }

  get currentBanner(): BannerTone | null {
    return this.bannerShown;
  }

  /** Damage/heal number over a unit; hits on the same unit within FLOATER_MERGE_MS merge into one. */
  number(key: string, at: FxPoint, amount: number, variant: FloaterVariant, opts: { crit?: boolean; overTime?: boolean; now?: number } = {}): void {
    const now = opts.now ?? performance.now();
    const merge = this.floaters.find(f => f.busy && f.key === key && f.variant === variant && now - f.bornAt <= FLOATER_MERGE_MS);
    if (merge) {
      merge.amount += amount;
      merge.crit = merge.crit || !!opts.crit;
      this.writeNumber(merge);
      return;
    }
    const f = this.acquire(key);
    f.key = key;
    f.variant = variant;
    f.amount = amount;
    f.crit = !!opts.crit;
    f.overTime = !!opts.overTime;
    f.bornAt = now;
    this.writeNumber(f);
    this.launch(f, at, f.crit ? 1150 : 900);
  }

  /** Word callout over a unit (DODGE, STUNNED, FIZZLE…). */
  text(key: string, at: FxPoint, label: string, variant: 'text-bad' | 'text-good' | 'text-info', now = performance.now()): void {
    const f = this.acquire(key);
    f.key = key;
    f.variant = variant;
    f.amount = 0;
    f.crit = false;
    f.overTime = false;
    f.bornAt = now;
    f.el.className = `combat-floater combat-floater-${variant} live`;
    f.el.textContent = label;
    this.launch(f, at, 900);
  }

  /** The reaction's mini card flipping out of the reacting unit. */
  reactionCard(at: FxPoint, skillName: string, kind: 'instant' | 'interrupt', icon: string, towardsY: number): void {
    const card = document.createElement('div');
    card.className = `combat-reaction-card ${kind}`;
    const tag = kind === 'interrupt' ? '✋ Interrupt' : '⚡ Instant';
    card.innerHTML = `<span class="combat-reaction-icon">${escapeHtml(icon)}</span>`
      + `<span class="combat-reaction-text"><span class="combat-reaction-name">${escapeHtml(skillName)}</span>`
      + `<span class="combat-reaction-tag">${tag}</span></span>`;
    this.layer.appendChild(card);
    this.reactionCards.push(card);
    while (this.reactionCards.length > MAX_REACTION_CARDS) this.reactionCards.shift()?.remove();
    const x = clampInto(at.x, (card.offsetWidth || 120) / 2 + 4, this.layer.clientWidth);
    const y = clampInto(at.y + towardsY * Math.min(at.h * 0.4, 30), (card.offsetHeight || 34) / 2 + 4, this.layer.clientHeight);
    const base = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    const remove = (): void => {
      card.remove();
      this.reactionCards = this.reactionCards.filter(c => c !== card);
    };
    const anim = reducedMotion()
      ? fx(card, [{ transform: base, opacity: 0 }, { transform: base, opacity: 1, offset: 0.2 }, { transform: base, opacity: 1, offset: 0.8 }, { transform: base, opacity: 0 }], { duration: 1300 })
      : fx(card, [
        { transform: `${base} perspective(420px) rotateY(95deg) scale(0.55)`, opacity: 0 },
        { transform: `${base} perspective(420px) rotateY(-12deg) scale(1.08)`, opacity: 1, offset: 0.2 },
        { transform: `${base} perspective(420px) rotateY(0deg) scale(1)`, opacity: 1, offset: 0.32 },
        { transform: `${base} perspective(420px) rotateY(0deg) scale(1)`, opacity: 1, offset: 0.78 },
        { transform: `${base} translateY(${towardsY * 14}px) perspective(420px) rotateY(0deg) scale(0.92)`, opacity: 0 },
      ], { duration: 1400, easing: 'cubic-bezier(.2,.8,.2,1)' });
    if (anim) anim.onfinish = remove;
    else {
      card.style.transform = base;
      setTimeout(remove, 1300);
    }
  }

  /** "COUNTERED!" / "INTERRUPTED!" stamped over a cancelled cast bar. */
  stamp(at: FxPoint, label: string): void {
    const el = document.createElement('div');
    el.className = 'combat-stamp';
    el.textContent = label;
    this.layer.appendChild(el);
    const base = `translate(${at.x}px, ${Math.max(at.y - at.h / 2, 16)}px) translate(-50%, -50%)`;
    const anim = reducedMotion()
      ? fx(el, [{ transform: `${base} rotate(-8deg)`, opacity: 0 }, { transform: `${base} rotate(-8deg)`, opacity: 1, offset: 0.15 }, { transform: `${base} rotate(-8deg)`, opacity: 1, offset: 0.75 }, { transform: `${base} rotate(-8deg)`, opacity: 0 }], { duration: 1100 })
      : fx(el, [
        { transform: `${base} rotate(-18deg) scale(2.4)`, opacity: 0 },
        { transform: `${base} rotate(-8deg) scale(0.92)`, opacity: 1, offset: 0.14 },
        { transform: `${base} rotate(-8deg) scale(1)`, opacity: 1, offset: 0.22 },
        { transform: `${base} rotate(-8deg) scale(1)`, opacity: 1, offset: 0.78 },
        { transform: `${base} rotate(-8deg) scale(1.1)`, opacity: 0 },
      ], { duration: 1150, easing: 'ease-out' });
    if (anim) anim.onfinish = () => el.remove();
    else setTimeout(() => el.remove(), 1100);
  }

  /** Quick arc from the interceptor to the ally it covers. */
  arc(from: FxPoint, to: FxPoint): void {
    if (reducedMotion()) return;
    const mx = (from.x + to.x) / 2;
    const my = (from.y + to.y) / 2;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.max(1, Math.hypot(dx, dy));
    const bend = Math.min(60, len * 0.45);
    const cx = mx - (dy / len) * bend;
    const cy = my + (dx / len) * bend * (dx >= 0 ? -1 : 1);
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('class', 'combat-arc-path');
    path.setAttribute('d', `M ${from.x} ${from.y} Q ${cx} ${cy} ${to.x} ${to.y}`);
    this.svg.appendChild(path);
    const pathAnim = fx(path, [{ opacity: 0 }, { opacity: 1, offset: 0.2 }, { opacity: 1, offset: 0.6 }, { opacity: 0 }], { duration: 700 });
    if (pathAnim) pathAnim.onfinish = () => path.remove();
    else setTimeout(() => path.remove(), 700);

    const token = document.createElement('div');
    token.className = 'combat-arc-token';
    token.textContent = '🛡';
    this.layer.appendChild(token);
    const frames: Keyframe[] = [];
    for (let i = 0; i <= 6; i++) {
      const t = i / 6;
      const x = (1 - t) * (1 - t) * from.x + 2 * (1 - t) * t * cx + t * t * to.x;
      const y = (1 - t) * (1 - t) * from.y + 2 * (1 - t) * t * cy + t * t * to.y;
      frames.push({ transform: `translate(${x}px, ${y}px) translate(-50%, -50%) scale(${1 + Math.sin(t * Math.PI) * 0.35})`, opacity: i === 6 ? 0 : 1 });
    }
    const anim = fx(token, frames, { duration: 420, easing: 'ease-in-out' });
    if (anim) anim.onfinish = () => token.remove();
    else token.remove();
  }

  lunge(el: HTMLElement, dx: number, dy: number, strong = false): void {
    if (reducedMotion()) return;
    const d = strong ? 14 : 9;
    fx(el, [
      { transform: 'translate(0, 0)' },
      { transform: `translate(${dx * d}px, ${dy * d}px) scale(${strong ? 1.06 : 1.03})`, offset: 0.35 },
      { transform: 'translate(0, 0)' },
    ], { duration: strong ? 300 : 240, easing: 'cubic-bezier(.3,.7,.4,1)' });
  }

  recoil(el: HTMLElement, dx: number, dy: number): void {
    if (reducedMotion()) return;
    fx(el, [
      { transform: 'translate(0, 0)' },
      { transform: `translate(${dx * 4}px, ${dy * 4}px)`, offset: 0.3 },
      { transform: 'translate(0, 0)' },
    ], { duration: 200, easing: 'ease-out' });
  }

  flash(overlay: HTMLElement, strength = 0.85, duration = 260): void {
    fx(overlay, [{ opacity: strength }, { opacity: 0 }], { duration, easing: 'ease-out' });
  }

  popIn(el: HTMLElement, delay: number): void {
    if (reducedMotion()) return;
    fx(el, [
      { transform: 'scale(0.4)', opacity: 0 },
      { transform: 'scale(1.08)', opacity: 1, offset: 0.65 },
      { transform: 'scale(1)', opacity: 1 },
    ], { duration: 360, delay, easing: 'cubic-bezier(.34,1.56,.64,1)', fill: 'backwards' });
  }

  shake(): void {
    if (reducedMotion()) return;
    fx(this.shakeTarget, [
      { transform: 'translate(0, 0)' },
      { transform: 'translate(-4px, 2px)' },
      { transform: 'translate(4px, -2px)' },
      { transform: 'translate(-3px, -1px)' },
      { transform: 'translate(2px, 1px)' },
      { transform: 'translate(0, 0)' },
    ], { duration: 260, easing: 'linear' });
  }

  /** Shows the banner now, or queues it behind a more important one; false when queued. */
  banner(text: string, tone: BannerTone, holdMs = 1100, sub?: string): boolean {
    const request: BannerRequest = { text, tone, holdMs, sub, expiresAt: this.clock() + BANNER_QUEUE_MS };
    if (this.bannerShown && BANNER_PRIORITY[this.bannerShown] > BANNER_PRIORITY[tone]) {
      this.bannerQueue.push(request);
      return false;
    }
    this.showBanner(request);
    return true;
  }

  /** Removes the banner on screen and everything queued behind it. */
  clearBanner(): void {
    this.bannerQueue = [];
    this.hideBanner();
  }

  sparkles(at: FxPoint, count = 14): void {
    if (reducedMotion()) return;
    for (let i = 0; i < count; i++) {
      const spark = document.createElement('span');
      spark.className = `combat-spark combat-spark-${i % 3}`;
      this.layer.appendChild(spark);
      const angle = (i / count) * Math.PI * 2 + Math.random() * 0.4;
      const dist = 50 + Math.random() * 70;
      const base = `translate(${at.x}px, ${at.y}px)`;
      const anim = fx(spark, [
        { transform: `${base} scale(0.2)`, opacity: 1 },
        { transform: `${base} translate(${Math.cos(angle) * dist}px, ${Math.sin(angle) * dist}px) scale(1)`, opacity: 1, offset: 0.6 },
        { transform: `${base} translate(${Math.cos(angle) * dist * 1.15}px, ${Math.sin(angle) * dist * 1.15 + 12}px) scale(0.4)`, opacity: 0 },
      ], { duration: 900 + Math.random() * 300, easing: 'cubic-bezier(.1,.8,.3,1)' });
      if (anim) anim.onfinish = () => spark.remove();
      else spark.remove();
    }
  }

  /** `keepResultBanner` lets a victory, defeat or retreat banner finish when the next fight starts under it. */
  clearAll(keepResultBanner = false): void {
    const showsResult = this.bannerShown === 'victory' || this.bannerShown === 'defeat' || this.bannerShown === 'retreat';
    if (!keepResultBanner || !showsResult) this.clearBanner();
    for (const f of this.floaters) this.release(f);
    for (const card of this.reactionCards) card.remove();
    this.reactionCards = [];
    for (const el of this.layer.querySelectorAll('.combat-stamp, .combat-arc-token, .combat-spark')) el.remove();
    this.svg.replaceChildren();
  }

  private showBanner(request: BannerRequest): void {
    this.hideBanner();
    const { text, tone, holdMs, sub } = request;
    this.bannerShown = tone;
    this.bannerEl.className = `combat-banner combat-banner-${tone}${text.length > LONG_BANNER_CHARS ? ' long' : ''} show`;
    this.bannerEl.innerHTML = `<span class="combat-banner-text">${escapeHtml(text)}</span>`
      + (sub ? `<span class="combat-banner-sub">${escapeHtml(sub)}</span>` : '');
    const total = Math.min(BANNER_MAX_MS, holdMs);
    this.bannerAnim = reducedMotion()
      ? fx(this.bannerEl, [{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.8 }, { opacity: 0 }], { duration: total, fill: 'forwards' })
      : fx(this.bannerEl, [
        { transform: 'translate(-50%, -50%) scale(2.2)', opacity: 0 },
        { transform: 'translate(-50%, -50%) scale(0.94)', opacity: 1, offset: 0.16 },
        { transform: 'translate(-50%, -50%) scale(1)', opacity: 1, offset: 0.24 },
        { transform: 'translate(-50%, -50%) scale(1.02)', opacity: 1, offset: 0.8 },
        { transform: 'translate(-50%, -50%) scale(1.25)', opacity: 0 },
      ], { duration: total, easing: 'ease-out', fill: 'forwards' });
    this.bannerTimer = setTimeout(() => this.nextBanner(), total);
  }

  private nextBanner(): void {
    this.hideBanner();
    const now = this.clock();
    this.bannerQueue = this.bannerQueue.filter(r => r.expiresAt >= now);
    if (this.bannerQueue.length === 0) return;
    let best = 0;
    for (let i = 1; i < this.bannerQueue.length; i++) {
      if (BANNER_PRIORITY[this.bannerQueue[i].tone] > BANNER_PRIORITY[this.bannerQueue[best].tone]) best = i;
    }
    const [next] = this.bannerQueue.splice(best, 1);
    this.showBanner(next);
  }

  private hideBanner(): void {
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = undefined;
    this.bannerAnim?.cancel();
    this.bannerAnim = null;
    this.bannerShown = null;
    this.bannerEl.className = 'combat-banner';
    this.bannerEl.textContent = '';
  }

  private acquire(key: string): Floater {
    const free = this.floaters.find(f => !f.busy);
    const own = this.floaters.filter(f => f.busy && f.key === key);
    let f: Floater | undefined;
    if (own.length >= FLOATERS_PER_UNIT) f = oldest(own);
    else f = free ?? oldest(this.floaters);
    this.release(f);
    return f;
  }

  private launch(f: Floater, at: FxPoint, duration: number): void {
    f.busy = true;
    const stacked = this.floaters.some(o => o.busy && o.key === f.key && o !== f && o.slot === 0);
    f.slot = stacked ? 1 : 0;
    const x = at.x + (stacked ? 10 : 0);
    const y = at.y - at.h * 0.15 - (stacked ? STACK_OFFSET_PX : 0);
    const finish = (): void => this.release(f);
    if (reducedMotion()) {
      const base = `translate(${x}px, ${y - 10}px) translate(-50%, -50%)`;
      f.anim = fx(f.el, [{ transform: base, opacity: 0 }, { transform: base, opacity: 1, offset: 0.25 }, { transform: base, opacity: 0 }], { duration: 400 });
    } else {
      const base = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      const rise = f.overTime ? 24 : 38;
      const pop = f.crit ? 1.45 : f.overTime ? 1 : 1.2;
      f.anim = fx(f.el, [
        { transform: `${base} scale(0.5)`, opacity: 0 },
        { transform: `${base} translateY(-10px) scale(${pop})`, opacity: 1, offset: 0.14 },
        { transform: `${base} translateY(-16px) scale(1)`, opacity: 1, offset: 0.3 },
        { transform: `${base} translateY(-${rise}px) scale(0.96)`, opacity: 0 },
      ], { duration, easing: 'cubic-bezier(.15,.75,.35,1)' });
    }
    if (f.anim) f.anim.onfinish = finish;
    else {
      f.el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      f.timer = setTimeout(finish, reducedMotion() ? 400 : duration);
    }
  }

  private release(f: Floater): void {
    if (f.timer) clearTimeout(f.timer);
    f.timer = undefined;
    if (f.anim) {
      f.anim.onfinish = null;
      f.anim.cancel();
    }
    f.anim = null;
    f.busy = false;
    f.el.className = 'combat-floater';
  }

  private writeNumber(f: Floater): void {
    const text = f.variant === 'heal' ? `+${formatAmount(f.amount)}` : f.variant === 'shield' ? `+${formatAmount(f.amount)}` : formatAmount(f.amount);
    f.el.className = `combat-floater combat-floater-${f.variant}${f.crit ? ' crit' : ''}${f.overTime ? ' dot' : ''} live`;
    f.el.innerHTML = f.crit ? `<span class="combat-floater-crit">CRIT!</span>${text}` : text;
  }
}

function clampInto(value: number, margin: number, size: number): number {
  if (size <= margin * 2) return value;
  return Math.max(margin, Math.min(size - margin, value));
}

function oldest(list: Floater[]): Floater {
  return list.reduce((a, b) => (b.bornAt < a.bornAt ? b : a));
}
