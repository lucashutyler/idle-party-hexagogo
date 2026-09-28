import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasteryEntry } from '@idle-party-rpg/shared';
import {
  BESTIARY_REFRESH_MS,
  BestiaryCard,
  BestiaryModal,
  closestToNextRank,
  filterBestiary,
  MasteryToasts,
  masteryProgress,
  masteryRankUps,
  masteryStars,
  masteryToastText,
  mergeBestiaryEntries,
  nextRankText,
  renderBestiaryRow,
  sortBestiary,
  syncBestiaryRows,
} from '../src/ui/BestiaryModal';
import type { GameClient } from '../src/network/GameClient';

function entry(overrides: Partial<MasteryEntry> & Pick<MasteryEntry, 'monsterId' | 'name'>): MasteryEntry {
  return { kills: 0, rank: 0, maxRank: 5, nextAt: 10, prevAt: 0, bonusPct: 0, ...overrides };
}

const goblin = entry({ monsterId: 'goblin', name: 'Goblin', kills: 212, rank: 2, nextAt: 250, prevAt: 50, bonusPct: 4, level: 1 });
const wolf = entry({ monsterId: 'wolf', name: 'Wolf', kills: 9, rank: 0, nextAt: 10, prevAt: 0 });
const chief = entry({ monsterId: 'chief', name: 'Goblin Chieftain', kills: 60, rank: 5, nextAt: null, prevAt: 60, bonusPct: 10, tier: 'boss', level: 6 });
const bandit = entry({ monsterId: 'bandit', name: 'Bandit', kills: 30, rank: 1, nextAt: 50, prevAt: 10, bonusPct: 2, level: 51, levelDerived: true });

describe('bestiary helpers', () => {
  it('measures progress between rank thresholds', () => {
    expect(masteryProgress(goblin)).toBeCloseTo(0.81);
    expect(masteryProgress(chief)).toBe(1);
    expect(masteryProgress(entry({ monsterId: 'x', name: 'X', nextAt: 10, prevAt: 10 }))).toBe(0);
  });

  it('describes the next rank', () => {
    expect(nextRankText(goblin)).toBe('Next rank at 250');
    expect(nextRankText(entry({ monsterId: 'x', name: 'X', nextAt: 10000 }))).toBe('Next rank at 10,000');
    expect(nextRankText(chief)).toBe('Mastered');
    expect(masteryStars(goblin)).toBe('★★☆☆☆');
  });

  it('sorts by closeness, kills, rank and name', () => {
    const all = [goblin, wolf, chief, bandit];
    expect(sortBestiary(all, 'closest').map(e => e.monsterId)).toEqual(['wolf', 'goblin', 'bandit', 'chief']);
    expect(sortBestiary(all, 'kills').map(e => e.monsterId)).toEqual(['goblin', 'chief', 'bandit', 'wolf']);
    expect(sortBestiary(all, 'rank').map(e => e.monsterId)).toEqual(['chief', 'goblin', 'bandit', 'wolf']);
    expect(sortBestiary(all, 'name').map(e => e.monsterId)).toEqual(['bandit', 'goblin', 'chief', 'wolf']);
  });

  it('filters by name and picks the closest unmastered entries', () => {
    expect(filterBestiary([goblin, wolf, chief], ' gob ').map(e => e.monsterId)).toEqual(['goblin', 'chief']);
    expect(closestToNextRank([goblin, wolf, chief, bandit], 2).map(e => e.monsterId)).toEqual(['wolf', 'goblin']);
  });

  it('prefers the fresher recent entries when merging', () => {
    const fresher = { ...goblin, kills: 240 };
    const merged = mergeBestiaryEntries([goblin, wolf], [fresher]);
    expect(merged.find(e => e.monsterId === 'goblin')!.kills).toBe(240);
    expect(merged).toHaveLength(2);
  });

  it('shows authored levels coloured for the viewer and hides derived levels', () => {
    const el = document.createElement('div');
    el.innerHTML = renderBestiaryRow(chief, 3) + renderBestiaryRow(bandit, 3);
    const [chiefRow, banditRow] = [...el.querySelectorAll('.bestiary-row')];
    const badge = chiefRow.querySelector('.bestiary-lvl')!;
    expect(badge.getAttribute('data-con')).toBe('deadly');
    expect(badge.textContent).toContain('L6');
    expect(chiefRow.querySelector('.bestiary-tier')!.textContent).toContain('Boss');
    expect(chiefRow.getAttribute('data-mastered')).toBe('true');
    expect(banditRow.querySelector('.bestiary-lvl')).toBeNull();
    expect(banditRow.querySelector('.bestiary-next')!.textContent).toBe('Next rank at 50');
    expect(banditRow.querySelector('.bestiary-bar')!.getAttribute('aria-valuenow')).toBe('50');
  });
});

describe('BestiaryModal', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fakeClient(bestiary: MasteryEntry[] | null) {
    let listener: (() => void) | null = null;
    let stateListener: ((s: unknown) => void) | null = null;
    const client = {
      lastState: { character: { level: 3, mastery: { discovered: 4, mastered: 1, version: 1, recent: [] as MasteryEntry[] } } },
      lastBestiary: bestiary ? { type: 'bestiary', version: 1, entries: bestiary } : null,
      requestBestiary: vi.fn(),
      onBestiary(cb: () => void) {
        listener = cb;
        return () => { listener = null; };
      },
      subscribe(cb: (s: unknown) => void) {
        stateListener = cb;
        return () => { stateListener = null; };
      },
      deliver(entries: MasteryEntry[]) {
        client.lastBestiary = { type: 'bestiary', version: 1, entries };
        listener?.();
      },
      kill(recent: MasteryEntry[], version: number) {
        client.lastState = { character: { level: 3, mastery: { discovered: 4, mastered: 1, version, recent } } };
        stateListener?.(client.lastState);
      },
      get subscribed() {
        return stateListener !== null;
      },
    };
    return client;
  }

  function killsShown(id: string): string {
    return document.querySelector(`.bestiary-row[data-monster-id="${id}"] .bestiary-kills`)!.textContent!;
  }

  it('refreshes open rows as the party keeps killing, at most once a second', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    const client = fakeClient([goblin, wolf]);
    const modal = new BestiaryModal(client as unknown as GameClient);
    modal.open();
    const art = document.querySelector('.bestiary-row[data-monster-id="goblin"] img');
    vi.setSystemTime(1_000_000 + BESTIARY_REFRESH_MS);
    client.kill([{ ...goblin, kills: 213 }], 2);
    expect(killsShown('goblin')).toBe('213 defeated');
    client.kill([{ ...goblin, kills: 214 }], 3);
    expect(killsShown('goblin')).toBe('213 defeated');
    vi.advanceTimersByTime(BESTIARY_REFRESH_MS);
    expect(killsShown('goblin')).toBe('214 defeated');
    expect(document.querySelector('.bestiary-row[data-monster-id="goblin"] img')).toBe(art);
    modal.close();
    expect(client.subscribed).toBe(false);
  });

  it('opens on the modal stack, requests the list and renders it when it arrives', () => {
    const client = fakeClient(null);
    const modal = new BestiaryModal(client as unknown as GameClient);
    modal.open();
    const overlay = document.querySelector('.bestiary-overlay') as HTMLElement;
    expect(parseInt(overlay.style.zIndex, 10)).toBeGreaterThanOrEqual(1500);
    expect(client.requestBestiary).toHaveBeenCalled();
    expect(overlay.querySelector('.bestiary-empty')!.textContent).toBe('Loading…');
    client.deliver([goblin, wolf, chief]);
    expect(overlay.querySelectorAll('.bestiary-row')).toHaveLength(3);
    expect(overlay.querySelector('.bestiary-summary')!.textContent).toBe('4 discovered · 1 mastered');
    modal.close();
    expect(document.querySelector('.bestiary-overlay')).toBeNull();
  });

  it('searches and sorts', () => {
    const client = fakeClient([goblin, wolf, chief]);
    const modal = new BestiaryModal(client as unknown as GameClient);
    modal.open();
    const search = document.querySelector('.bestiary-search') as HTMLInputElement;
    search.value = 'wolf';
    search.dispatchEvent(new Event('input'));
    expect([...document.querySelectorAll('.bestiary-row')].map(r => r.getAttribute('data-monster-id'))).toEqual(['wolf']);
    search.value = '';
    search.dispatchEvent(new Event('input'));
    const sort = document.querySelector('.bestiary-sort') as HTMLSelectElement;
    sort.value = 'kills';
    sort.dispatchEvent(new Event('change'));
    expect([...document.querySelectorAll('.bestiary-row')].map(r => r.getAttribute('data-monster-id'))).toEqual(['goblin', 'chief', 'wolf']);
    modal.close();
  });

  it('closes on Escape', () => {
    const modal = new BestiaryModal(fakeClient([goblin]) as unknown as GameClient);
    modal.open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    expect(modal.isOpen).toBe(false);
  });
});

describe('bestiary rows and card', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('patches rows in place, keeping portraits, and reorders, adds and drops rows', () => {
    const list = document.createElement('div');
    list.innerHTML = '<div class="bestiary-empty">Loading…</div>';
    syncBestiaryRows(list, [goblin, wolf], 3);
    const [goblinRow, wolfRow] = [...list.children];
    const goblinArt = goblinRow.querySelector('img');
    syncBestiaryRows(list, [{ ...wolf, kills: 10, rank: 1, prevAt: 10, nextAt: 50 }, { ...goblin, kills: 213 }, chief], 3);
    expect([...list.children].map(r => r.getAttribute('data-monster-id'))).toEqual(['wolf', 'goblin', 'chief']);
    expect(list.children[0]).toBe(wolfRow);
    expect(wolfRow.getAttribute('data-rank')).toBe('1');
    expect(list.children[1]).toBe(goblinRow);
    expect(goblinRow.querySelector('img')).toBe(goblinArt);
    expect(goblinRow.querySelector('.bestiary-kills')!.textContent).toBe('213 defeated');
    syncBestiaryRows(list, [chief], 3);
    expect([...list.children].map(r => r.getAttribute('data-monster-id'))).toEqual(['chief']);
  });

  it('only touches the card when what it shows changes, keeping the View all button', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    const card = new BestiaryCard(el);
    const summary = { discovered: 5, mastered: 1, version: 300, recent: [goblin] };
    card.update(summary, [goblin, wolf, chief, bandit, entry({ monsterId: 'rat', name: 'Rat', kills: 1, nextAt: 10 })], 3);
    expect([...el.querySelectorAll('.bestiary-row')].map(r => r.getAttribute('data-monster-id'))).toEqual(['wolf', 'goblin', 'bandit']);
    const button = el.querySelector<HTMLButtonElement>('.bestiary-view-all')!;
    button.focus();
    const rowsBefore = [...el.querySelectorAll('.bestiary-row')];
    const rat = entry({ monsterId: 'rat', name: 'Rat', kills: 2, nextAt: 10 });
    card.update({ ...summary, version: 301, recent: [rat, goblin] }, [goblin, wolf, chief, bandit], 3);
    expect([...el.querySelectorAll('.bestiary-row')]).toEqual(rowsBefore);
    card.update({ ...summary, version: 302, recent: [{ ...goblin, kills: 240 }] }, [goblin, wolf, chief, bandit], 3);
    expect(el.querySelector('.bestiary-row[data-monster-id="goblin"] .bestiary-kills')!.textContent).toBe('240 defeated');
    expect(el.querySelector('.bestiary-view-all')).toBe(button);
    expect(document.activeElement).toBe(button);
    expect(el.querySelector('.bestiary-card-summary')!.textContent).toBe('5 discovered · 1 mastered');
    card.update({ discovered: 0, mastered: 0, version: 0, recent: [] }, [], 3);
    expect(el.querySelector('.bestiary-card-empty')).toBeTruthy();
    expect(el.querySelector('.items-section-count')!.textContent).toBe('(0)');
  });
});

describe('mastery rank-up toasts', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps only rank-ups of known monsters that are worth a toast', () => {
    const known = new Map([['goblin', 1], ['wolf', 0], ['chief', 0]]);
    const ups = masteryRankUps(known, [
      goblin,
      entry({ monsterId: 'wolf', name: 'Wolf', rank: 1 }),
      entry({ monsterId: 'chief', name: 'Goblin Chieftain', rank: 1, tier: 'boss' }),
      entry({ monsterId: 'rat', name: 'Rat', rank: 3 }),
    ]);
    expect(ups.map(e => e.monsterId)).toEqual(['goblin', 'chief']);
    expect(masteryToastText(goblin)).toBe('Mastery rank 2: Goblin · +4 % against them');
  });

  it('counts a monster missing from the known set as rank 0 only when it was just discovered', () => {
    const firstBoss = entry({ monsterId: 'king', name: 'Goblin King', kills: 1, rank: 1, tier: 'boss', bonusPct: 2 });
    expect(masteryRankUps(new Map(), [firstBoss], 1).map(e => e.monsterId)).toEqual(['king']);
    expect(masteryRankUps(new Map(), [firstBoss], 0)).toEqual([]);
    expect(masteryRankUps(new Map(), [firstBoss, { ...chief, rank: 2 }], 1)).toEqual([]);
  });

  function fakeToastClient() {
    const c = {
      isInitialState: true,
      lastState: null,
      stateListener: null as ((s: unknown) => void) | null,
      subscribe(cb: (s: unknown) => void) { c.stateListener = cb; return () => { c.stateListener = null; }; },
      lastBestiary: null,
      requestBestiary: vi.fn(),
      onBestiary() { return () => {}; },
      push(recent: MasteryEntry[], initial = false, discovered = recent.length) {
        c.isInitialState = initial;
        c.stateListener!({ character: { mastery: { discovered, mastered: 0, version: 1, recent } } });
      },
    };
    return c;
  }

  it('treats the state already cached at construction as a snapshot', () => {
    const client = fakeToastClient();
    (client as { lastState: unknown }).lastState = { character: { mastery: { discovered: 1, mastered: 0, version: 1, recent: [goblin] } } };
    client.isInitialState = false;
    const toasts = new MasteryToasts(client as unknown as GameClient, () => {});
    expect(document.querySelector('.mastery-toast')).toBeNull();
    expect(client.requestBestiary).toHaveBeenCalled();
    client.push([{ ...goblin, rank: 3, bonusPct: 6 }]);
    expect(document.querySelector('.mastery-toast')).toBeTruthy();
    toasts.destroy();
  });

  it('toasts a live rank-up, not ranks seen on (re)connect, and opens the bestiary when tapped', () => {
    const client = fakeToastClient();
    const onOpen = vi.fn();
    const toasts = new MasteryToasts(client as unknown as GameClient, onOpen);
    client.push([entry({ monsterId: 'goblin', name: 'Goblin', rank: 1 })], true);
    client.push([{ ...goblin, rank: 2 }], true);
    expect(document.querySelector('.mastery-toast')).toBeNull();
    expect(client.requestBestiary).toHaveBeenCalled();
    client.push([{ ...goblin, rank: 3, bonusPct: 6 }]);
    const toast = document.querySelector('.mastery-toast') as HTMLButtonElement;
    expect(toast.textContent).toBe('⭐ Mastery rank 3: Goblin · +6 % against them');
    toast.click();
    expect(onOpen).toHaveBeenCalled();
    expect(document.querySelector('.mastery-toast')).toBeNull();
    toasts.destroy();
    expect(client.stateListener).toBeNull();
  });

  it('toasts the first kill of a boss, which ranks it up straight away', () => {
    const client = fakeToastClient();
    const toasts = new MasteryToasts(client as unknown as GameClient, () => {});
    client.push([goblin], true, 1);
    client.push([{ ...goblin, kills: 213 }], false, 1);
    expect(document.querySelector('.mastery-toast')).toBeNull();
    const king = entry({ monsterId: 'king', name: 'Goblin King', kills: 1, rank: 1, tier: 'boss', bonusPct: 2 });
    client.push([king, goblin], false, 2);
    expect(document.querySelector('.mastery-toast')!.textContent).toContain('Mastery rank 1: Goblin King');
    toasts.destroy();
  });

  it('does not toast a previously killed boss the client had not seen yet', () => {
    const client = fakeToastClient();
    const toasts = new MasteryToasts(client as unknown as GameClient, () => {});
    client.push([goblin], true, 2);
    client.push([{ ...chief, rank: 2, nextAt: 10, kills: 5 }, goblin], false, 2);
    expect(document.querySelector('.mastery-toast')).toBeNull();
    toasts.destroy();
  });
});
