import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BANNER_QUEUE_MS, CombatFx } from '../src/combat/CombatFx';

let clock = 0;
let fx: CombatFx;
let bannerEl: HTMLElement;

function shown(): string {
  return bannerEl.querySelector('.combat-banner-text')?.textContent ?? '';
}

function advance(ms: number): void {
  clock += ms;
  vi.advanceTimersByTime(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  document.body.innerHTML = '<div class="layer"></div><div class="grid"></div><div class="combat-banner"></div>';
  bannerEl = document.querySelector('.combat-banner')!;
  fx = new CombatFx(document.querySelector('.layer')!, document.querySelector('.grid')!, bannerEl, () => clock);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('CombatFx banner queue', () => {
  it('shows a banner with its tone and optional subline, then hides it', () => {
    expect(fx.banner('REGROUP', 'regroup', 1000, 'Checkpoint 2 · 2 retries left')).toBe(true);
    expect(bannerEl.className).toBe('combat-banner combat-banner-regroup show');
    expect(shown()).toBe('REGROUP');
    expect(bannerEl.querySelector('.combat-banner-sub')?.textContent).toBe('Checkpoint 2 · 2 retries left');
    advance(1000);
    expect(fx.currentBanner).toBeNull();
    expect(bannerEl.className).toBe('combat-banner');
  });

  it('marks long banner texts so they can shrink', () => {
    fx.banner('CHECKPOINT!', 'checkpoint', 1000);
    expect(bannerEl.classList.contains('long')).toBe(true);
    fx.banner('VICTORY!', 'victory', 1000);
    expect(bannerEl.classList.contains('long')).toBe(false);
  });

  it('never lets a lower-priority banner replace a higher one, and shows it afterwards if it is still fresh', () => {
    fx.banner('CHECKPOINT!', 'checkpoint', 800);
    expect(fx.banner('ENRAGED!', 'enrage', 1000)).toBe(false);
    expect(shown()).toBe('CHECKPOINT!');
    advance(800);
    expect(fx.currentBanner).toBe('enrage');
    expect(shown()).toBe('ENRAGED!');
  });

  it('drops a queued banner that waited longer than BANNER_QUEUE_MS', () => {
    fx.banner('VICTORY!', 'victory', BANNER_QUEUE_MS + 200);
    fx.banner('ENRAGED!', 'enrage', 1000);
    advance(BANNER_QUEUE_MS + 200);
    expect(fx.currentBanner).toBeNull();
  });

  it('lets a more important banner replace the one on screen', () => {
    fx.banner('CHECKPOINT!', 'checkpoint', 1300);
    expect(fx.banner('VICTORY!', 'victory', 1400)).toBe(true);
    expect(shown()).toBe('VICTORY!');
    fx.banner('DEFEAT', 'defeat', 1400);
    expect(shown()).toBe('DEFEAT');
  });

  it('shows the most important queued banner first', () => {
    fx.banner('RETREAT', 'retreat', 500);
    fx.banner('BOSS FIGHT!', 'boss', 1000);
    fx.banner('REGROUP', 'regroup', 1000);
    advance(500);
    expect(shown()).toBe('REGROUP');
  });

  it('clears the queue with the banner', () => {
    fx.banner('VICTORY!', 'victory', 600);
    fx.banner('ENRAGED!', 'enrage', 1000);
    fx.clearBanner();
    advance(600);
    expect(fx.currentBanner).toBeNull();
    expect(bannerEl.textContent).toBe('');
  });
});
