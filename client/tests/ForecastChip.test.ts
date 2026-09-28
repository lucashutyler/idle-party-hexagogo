import { describe, expect, it } from 'vitest';
import type { ForecastResult } from '@idle-party-rpg/shared';
import { OPEN_OPTIONS_ATTR, renderForecastPopover, renderForecastRing } from '../src/ui/ForecastChip';

function result(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    key: 'v|1|pk1|room:t1',
    partyKey: 'pk1',
    sims: 200,
    wins: 180,
    losses: 20,
    stalemates: 0,
    winPct: 90,
    ci: [85, 93],
    medianMs: 12_000,
    p90Ms: 16_000,
    atMs: 0,
    killEtaMs: null,
    reasons: [],
    ...overrides,
  };
}

function mount(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('renderForecastRing', () => {
  it('renders nothing for a missing forecast', () => {
    expect(renderForecastRing(null, { kind: 'room' })).toBe('');
  });

  it('renders a loading ring without a verdict', () => {
    const chip = mount(renderForecastRing('loading', { kind: 'room' })).querySelector('.forecast-chip')!;
    expect(chip.getAttribute('data-state')).toBe('loading');
    expect(chip.hasAttribute('data-verdict')).toBe(false);
    expect(chip.getAttribute('aria-label')).toBe('Estimating your chances');
  });

  it('renders the ring fraction, number, verdict and band', () => {
    const chip = mount(renderForecastRing(result({ winPct: 78, ci: [72, 83] }), { kind: 'room' })).querySelector('.forecast-chip')!;
    expect(chip.getAttribute('data-verdict')).toBe('good');
    expect(chip.getAttribute('data-band')).toBe('1');
    expect((chip.querySelector('.forecast-ring') as HTMLElement).style.getPropertyValue('--p')).toBe('0.780');
    expect(chip.querySelector('.forecast-win')!.textContent).toBe('78 %');
    expect(chip.querySelector('.forecast-verdict')!.textContent).toBe('Good');
    expect(chip.getAttribute('aria-label')).toContain('Good');
  });

  it('drops the verdict pill in compact mode and marks stale results', () => {
    const chip = mount(renderForecastRing(result(), { kind: 'battle', compact: true, stale: true })).querySelector('.forecast-chip')!;
    expect(chip.querySelector('.forecast-verdict')).toBeNull();
    expect(chip.getAttribute('data-compact')).toBe('true');
    expect(chip.getAttribute('data-state')).toBe('stale');
  });

  it('shows an approximate number for loose estimates', () => {
    const chip = mount(renderForecastRing(result({ sims: 20, winPct: 62, ci: [39, 78] }), { kind: 'battle', compact: true }));
    expect(chip.querySelector('.forecast-win')!.textContent).toBe('~62 %');
  });
});

describe('renderForecastPopover', () => {
  it('lists reasons, the sample size and the auto-retreat line with a Change link', () => {
    const root = mount(renderForecastPopover(result({
      reasons: [
        { code: 'no_healer', tone: 'bad', text: 'Fights here run long without a healer.' },
        { code: 'outlevel', tone: 'good', text: 'You outlevel these <monsters>.' },
      ],
    }), { kind: 'room', autoRetreat: { belowPct: 25, setBy: 'alice' } }));
    const reasons = [...root.querySelectorAll('.forecast-reason')];
    expect(reasons.map(r => r.getAttribute('data-tone'))).toEqual(['bad', 'good']);
    expect(reasons[1].textContent).toBe('You outlevel these <monsters>.');
    expect(root.querySelector('.forecast-foot')!.textContent).toBe('Estimate from 200 simulated fights');
    expect(root.querySelector('.forecast-retreat')!.textContent).toContain('Auto-retreat: below 25 %');
    expect(root.querySelector(`.forecast-retreat-change[${OPEN_OPTIONS_ATTR}]`)).toBeTruthy();
  });

  it('omits the auto-retreat line where it does not apply', () => {
    const root = mount(renderForecastPopover(result(), { kind: 'dungeon' }));
    expect(root.querySelector('.forecast-retreat')).toBeNull();
  });

  it('warns when the whole room is below the auto-retreat setting', () => {
    const losing = result({ winPct: 47, ci: [40, 54] });
    const warn = (belowPct: number, kind: 'room' | 'battle' = 'room') => mount(renderForecastPopover(losing, {
      kind, autoRetreat: { belowPct: belowPct as 0 | 25 | 40 | 60, setBy: 'alice' },
    })).querySelector('.forecast-retreat-warn');
    expect(warn(60)!.textContent).toBe('Auto-retreat will likely move your party out of this room.');
    expect(warn(40)).toBeNull();
    expect(warn(0)).toBeNull();
    expect(warn(60, 'battle')).toBeNull();
  });

  it('says auto-retreat is off for a 0 policy', () => {
    const root = mount(renderForecastPopover(result(), { kind: 'room', autoRetreat: 0 }));
    expect(root.querySelector('.forecast-retreat')!.textContent).toContain('Auto-retreat: off');
  });

  it('shows the worst encounter unless a reason already covers it', () => {
    const worst = { label: 'Bandits', winPct: 41, sharePct: 33 };
    const plain = mount(renderForecastPopover(result({ worst }), { kind: 'room' }));
    expect(plain.querySelector('.forecast-worst')!.textContent).toBe('1 in 3 fights here are Bandits: wins 41 %');
    const covered = mount(renderForecastPopover(result({
      worst,
      reasons: [{ code: 'worst_encounter', tone: 'bad', text: '1 in 3 fights here are Bandits: wins 41 %' }],
    }), { kind: 'room' }));
    expect(covered.querySelector('.forecast-worst')).toBeNull();
  });

  it('shows the likely range for loose estimates and the live time left', () => {
    const root = mount(renderForecastPopover(result({ sims: 20, winPct: 62, ci: [39, 78], medianMs: 100_000 }), { kind: 'battle', elapsedMs: 40_000 }));
    expect(root.querySelector('.forecast-pop-range')!.textContent).toBe('Win chance ~62\u202f%, likely 39–78\u202f%');
    expect(root.querySelector('.forecast-pop-headline')!.textContent).toBe('~62 % to win this attempt · ~1:00 left');
    expect(root.querySelector('.forecast-pop-verdict')!.textContent).toBe('Risky');
  });

  it('shows authored enemy levels coloured for the viewer, and never derived ones', () => {
    const authored = mount(renderForecastPopover(result({ enemyLevels: [8, 10] }), { kind: 'room', viewerLevel: 5 }));
    const badge = authored.querySelector('.forecast-lvl')!;
    expect(badge.getAttribute('data-con')).toBe('deadly');
    expect(badge.textContent).toContain('L8–10');
    const derived = mount(renderForecastPopover(result({ enemyLevels: [40, 51], enemyLevelsDerived: true }), { kind: 'room', viewerLevel: 5 }));
    expect(derived.querySelector('.forecast-lvl')).toBeNull();
  });

  it('shows the first-try chance for checkpoint dungeons', () => {
    const root = mount(renderForecastPopover(result({ firstTryPct: 40 }), { kind: 'dungeon' }));
    expect(root.textContent).toContain('Boss beaten on the first try: 40 %');
  });
});
