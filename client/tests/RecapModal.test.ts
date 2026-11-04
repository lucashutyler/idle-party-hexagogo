import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AwayLedger, AwayMoment } from '@idle-party-rpg/shared';
import {
  RecapModal,
  commonItemCount,
  formatAwayDuration,
  recapHeadline,
  recapLevelProgress,
  recapTimeline,
  recapToastText,
  recapWarnings,
} from '../src/ui/RecapModal';
import { setReducedMotionOverride } from '../src/ui/motion';
import type { GameClient } from '../src/network/GameClient';

const P = ' %';
const NOW = 1_700_000_000_000;
const MIN = 60_000;

function ledger(overrides: Partial<AwayLedger> = {}): AwayLedger {
  return {
    id: 'r1', since: NOW - 4 * 60 * MIN, until: NOW, battles: 1240, wins: 1204, losses: 36, retreats: 0, skips: 0,
    xp: 5000, gold: 310, levelFrom: 3, levelTo: 3, xpFracFrom: 0.2, xpFracTo: 0.62, items: {}, notableItems: [],
    itemsLost: 0, kills: 2480, masteryUps: [], dungeons: [], retreatLog: [], moments: [],
    ...overrides,
  };
}

function moment(kind: AwayMoment['kind'], at: number, text: string = kind, extra: Partial<AwayMoment> = {}): AwayMoment {
  return { kind, at, text, ...extra };
}

describe('recap helpers', () => {
  it('formats away durations', () => {
    expect(formatAwayDuration(12 * MIN)).toBe('12 min');
    expect(formatAwayDuration(4 * 60 * MIN + 12 * MIN)).toBe('4 h 12 min');
    expect(formatAwayDuration(3 * 60 * MIN)).toBe('3 h');
    expect(formatAwayDuration(51 * 60 * MIN)).toBe('2 d 3 h');
  });

  it('describes level progress within a level', () => {
    const p = recapLevelProgress(ledger());
    expect(p).toMatchObject({ label: 'Level 3', gainText: `+42${P} of a level`, levelledUp: false });
    expect(p.baseFrac).toBeCloseTo(0.2);
    expect(p.fillFrac).toBeCloseTo(0.62);
    expect(recapLevelProgress(ledger({ xpFracTo: 0.204 })).gainText).toBe(`+0.4${P} of a level`);
    expect(recapLevelProgress(ledger({ xpFracTo: 0.2003 })).gainText).toBe(`+<0.1${P} of a level`);
    expect(recapLevelProgress(ledger({ xpFracTo: 0.2 })).gainText).toBe(`+0${P} of a level`);
  });

  it('describes level-ups in levels gained', () => {
    const p = recapLevelProgress(ledger({ levelFrom: 3, levelTo: 5, xpFracFrom: 0.8, xpFracTo: 0.2 }));
    expect(p).toMatchObject({ label: 'Level 3 → 5', gainText: '+2 levels', levelledUp: true, baseFrac: 0 });
    expect(recapLevelProgress(ledger({ levelFrom: 3, levelTo: 4, xpFracFrom: 0.5, xpFracTo: 0.5 })).gainText).toBe('+1 level');
  });

  it('builds the headline from the top two moments of different kinds', () => {
    const l = ledger({
      levelTo: 4,
      dungeons: [{ dungeonId: 'gw', name: 'Goblin Warren', outcome: 'cleared', wipes: 0 }],
      moments: [
        moment('rare_item', NOW - 3 * MIN, 'Found a sword', { itemId: 'sword' }),
        moment('first_clear', NOW - 2 * MIN),
        moment('level_up', NOW - MIN),
        moment('level_up', NOW - 5 * MIN),
      ],
    });
    expect(recapHeadline(l, 'Old Mill')).toBe('Your party reached Level 4 and cleared Goblin Warren.');
  });

  it('names found items from the recap definitions', () => {
    const l = ledger({ moments: [moment('rare_item', NOW, 'Found a rare item', { itemId: 'sword' })] });
    expect(recapHeadline(l, undefined, id => (id === 'sword' ? { name: 'Ember Blade' } as never : undefined)))
      .toBe('Your party found Ember Blade.');
  });

  it('names the rarest find even when a lesser one happened later', () => {
    const l = ledger({
      notableItems: [{ itemId: 'blade', count: 1, rarity: 'heirloom' }, { itemId: 'boots', count: 1, rarity: 'rare' }],
      moments: [
        moment('rare_item', NOW - 5 * MIN, 'Found Ancestral Blade', { itemId: 'blade' }),
        moment('rare_item', NOW - MIN, 'Found Magma Boots', { itemId: 'boots' }),
      ],
    });
    const names: Record<string, string> = { blade: 'Ancestral Blade', boots: 'Magma Boots' };
    expect(recapHeadline(l, undefined, id => (names[id] ? { name: names[id] } as never : undefined)))
      .toBe('Your party found Ancestral Blade.');
  });

  it('falls back to where the party kept fighting', () => {
    expect(recapHeadline(ledger(), 'Old Mill')).toBe('Your party kept fighting in Old Mill.');
    expect(recapHeadline(ledger(), undefined)).toBe('Your party kept fighting.');
  });

  it('keeps at most six timeline moments, highest priority, in time order', () => {
    const moments = [
      moment('closest_call', NOW - 9 * MIN), moment('mastery', NOW - 8 * MIN), moment('relocate', NOW - 7 * MIN),
      moment('checkpoint', NOW - 6 * MIN), moment('rare_item', NOW - 5 * MIN), moment('first_clear', NOW - 4 * MIN),
      moment('level_up', NOW - 3 * MIN), moment('closest_call', NOW - 2 * MIN),
    ];
    const timeline = recapTimeline(ledger({ moments }));
    expect(timeline).toHaveLength(6);
    expect(timeline.map(m => m.kind)).toEqual(['mastery', 'relocate', 'checkpoint', 'rare_item', 'first_clear', 'level_up']);
  });

  it('counts items below rare as commons', () => {
    expect(commonItemCount(ledger({ items: { common: 30, uncommon: 4, janky: 1, rare: 2, epic: 1 } }))).toBe(35);
  });

  it('nudges auto-retreat when a quarter of fights were lost', () => {
    const warnings = recapWarnings(ledger({ battles: 120, wins: 82, losses: 38 }));
    expect(warnings[0]).toMatchObject({ kind: 'losses', action: 'options' });
    expect(warnings[0].text).toBe('You lost 38 of 120 fights. Auto-retreat can keep your party out of losing fights.');
    expect(recapWarnings(ledger({ battles: 120, wins: 100, losses: 20 }))).toEqual([]);
  });

  it('words the loss nudge for the auto-retreat setting in effect', () => {
    const l = ledger({ battles: 7, wins: 5, losses: 2 });
    expect(recapWarnings(l, () => '', 40)[0]).toEqual({
      kind: 'losses', action: 'options', text: `You lost 2 of 7 fights with auto-retreat below 40${P}. A higher setting leaves more of them.`,
    });
    expect(recapWarnings(l, () => '', 60)[0]).toEqual({
      kind: 'losses', action: 'map', text: 'You lost 2 of 7 fights. An easier room may suit your party better.',
    });
  });

  it('warns about a stopped route, dungeon exits and lost items', () => {
    const warnings = recapWarnings(ledger({
      routeStopped: { at: NOW, where: 'Old Mill' },
      dungeons: [
        { dungeonId: 'a', name: 'Crystal Trial', outcome: 'ejected', wipes: 4 },
        { dungeonId: 'b', name: 'Sunken Throne', outcome: 'left', wipes: 1, checkpoint: 2 },
        { dungeonId: 'c', name: 'Goblin Warren', outcome: 'cleared', wipes: 0 },
      ],
      itemsLost: 3,
    }), () => '14:05');
    expect(warnings.map(w => w.kind)).toEqual(['route', 'ejected', 'left', 'items_lost']);
    expect(warnings[0]).toMatchObject({ action: 'map', text: 'Your party stopped traveling at Old Mill (14:05). Pick a new destination on the map.' });
    expect(warnings[2].text).toBe('Your party left Sunken Throne at Checkpoint 2. Enter again to resume there.');
    expect(warnings[3].text).toBe('Your bags were full: 3 items were left behind.');
  });

  it('summarises a short absence for the toast', () => {
    const l = ledger({ since: NOW - 12 * MIN, xpFracFrom: 0.2, xpFracTo: 0.23, gold: 42 });
    expect(recapToastText(l, NOW)).toBe(`While you were away (12 min): +3${P} of a level · 42 gold`);
  });
});

interface FakeClient {
  recapListener: ((recap: AwayLedger | null) => void) | null;
  lastRecapItemDefinitions: Record<string, unknown>;
  lastState: { zoneName: string } | null;
  onRecap: (cb: (recap: AwayLedger | null) => void) => () => void;
  sendAckRecap: ReturnType<typeof vi.fn>;
}

function fakeClient(): FakeClient {
  const c: FakeClient = {
    recapListener: null,
    lastRecapItemDefinitions: {},
    lastState: { zoneName: 'Old Mill' },
    onRecap(cb) {
      c.recapListener = cb;
      return () => { c.recapListener = null; };
    },
    sendAckRecap: vi.fn(),
  };
  return c;
}

describe('RecapModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    setReducedMotionOverride(true);
  });

  afterEach(() => {
    setReducedMotionOverride(null);
  });

  it('opens the modal for a long absence and acknowledges on Continue', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ battles: 120, wins: 82, losses: 38, gold: 310, kills: 240 }));
    const overlay = document.querySelector('.recap-overlay') as HTMLElement;
    expect(overlay).toBeTruthy();
    expect(parseInt(overlay.style.zIndex, 10)).toBeGreaterThanOrEqual(1500);
    expect(overlay.querySelector('.recap-headline')!.textContent).toBe('Your party kept fighting in Old Mill.');
    expect(overlay.querySelector('.recap-footer')!.textContent).toBe('Won 82 of 120 fights · +310 gold · 240 foes defeated');
    expect(overlay.querySelector('.recap-warning[data-kind="losses"] [data-open-options]')).toBeTruthy();
    (overlay.querySelector('.recap-continue') as HTMLButtonElement).click();
    expect(client.sendAckRecap).toHaveBeenCalledWith('r1');
    expect(document.querySelector('.recap-overlay')).toBeNull();
    modal.destroy();
  });

  it('leaves Escape to a window opened above the recap', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ battles: 120, wins: 82, losses: 38 }));
    const overlay = document.querySelector('.recap-overlay') as HTMLElement;
    const options = document.createElement('div');
    options.style.zIndex = String(parseInt(overlay.style.zIndex, 10) + 1);
    document.body.appendChild(options);
    const covered = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(covered);
    expect(client.sendAckRecap).not.toHaveBeenCalled();
    expect(covered.defaultPrevented).toBe(false);
    options.remove();
    const top = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(top);
    expect(client.sendAckRecap).toHaveBeenCalledWith('r1');
    expect(top.defaultPrevented).toBe(true);
    modal.destroy();
  });

  it('still takes Escape while a toast sits above the recap', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ battles: 120, wins: 82, losses: 38 }));
    const overlay = document.querySelector('.recap-overlay') as HTMLElement;
    const toast = document.createElement('button');
    toast.className = 'recap-toast mastery-toast';
    toast.setAttribute('role', 'status');
    toast.style.zIndex = String(parseInt(overlay.style.zIndex, 10) + 1);
    document.body.appendChild(toast);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(client.sendAckRecap).toHaveBeenCalledWith('r1');
    toast.remove();
    modal.destroy();
  });

  it('shows a toast for a short quiet absence, which expands into the modal', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ since: NOW - 12 * MIN, until: NOW }));
    const toast = document.querySelector('.recap-toast') as HTMLButtonElement;
    expect(toast.textContent).toContain('While you were away (12 min)');
    expect(document.querySelector('.recap-overlay')).toBeNull();
    toast.click();
    expect(document.querySelector('.recap-toast')).toBeNull();
    expect(document.querySelector('.recap-overlay')).toBeTruthy();
    expect(client.sendAckRecap).not.toHaveBeenCalled();
    modal.destroy();
  });

  it('acknowledges a toast when it times out', () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ since: NOW - 12 * MIN, until: NOW }));
    vi.advanceTimersByTime(8000);
    expect(client.sendAckRecap).toHaveBeenCalledWith('r1');
    expect(document.querySelector('.recap-toast')).toBeNull();
    modal.destroy();
    vi.useRealTimers();
  });

  it('uses the modal for short absences with a notable moment', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ since: NOW - 12 * MIN, levelTo: 4, moments: [moment('level_up', NOW - MIN, 'Reached Level 4')] }));
    expect(document.querySelector('.recap-toast')).toBeNull();
    const overlay = document.querySelector('.recap-overlay')!;
    expect(overlay.querySelectorAll('.recap-moment')).toHaveLength(1);
    expect(overlay.querySelector('.recap-moment-text')!.textContent).toBe('Reached Level 4');
    modal.destroy();
  });

  it('closes without acknowledging when the recap is cleared elsewhere', () => {
    const client = fakeClient();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger());
    client.recapListener!(null);
    expect(document.querySelector('.recap-overlay')).toBeNull();
    expect(client.sendAckRecap).not.toHaveBeenCalled();
    modal.destroy();
  });

  it('renders rare loot icons from the recap definitions and a common count', () => {
    const client = fakeClient();
    client.lastRecapItemDefinitions = { gem: { id: 'gem', name: 'Star Gem', rarity: 'epic' } };
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW });
    client.recapListener!(ledger({ items: { common: 12, epic: 1 }, notableItems: [{ itemId: 'gem', count: 1, rarity: 'epic' }] }));
    const loot = document.querySelector('.recap-loot')!;
    expect(loot.querySelectorAll('.item-square')).toHaveLength(1);
    expect(loot.querySelector('.recap-loot-common')!.textContent).toBe('+ 12 common items');
    modal.destroy();
  });

  it('offers the map for a stopped route when the host can navigate', () => {
    const client = fakeClient();
    const onOpenMap = vi.fn();
    const modal = new RecapModal(client as unknown as GameClient, { now: () => NOW, onOpenMap });
    client.recapListener!(ledger({ routeStopped: { at: NOW, where: 'Old Mill' } }));
    (document.querySelector('[data-recap-action="map"]') as HTMLButtonElement).click();
    expect(onOpenMap).toHaveBeenCalled();
    expect(client.sendAckRecap).toHaveBeenCalledWith('r1');
    modal.destroy();
  });
});
