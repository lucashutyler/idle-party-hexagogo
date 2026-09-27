import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasteryEntry } from '@idle-party-rpg/shared';
import {
  BestiaryModal,
  closestToNextRank,
  filterBestiary,
  masteryProgress,
  masteryStars,
  mergeBestiaryEntries,
  nextRankText,
  renderBestiaryRow,
  sortBestiary,
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

  function fakeClient(bestiary: MasteryEntry[] | null) {
    let listener: (() => void) | null = null;
    const client = {
      lastState: { character: { level: 3, mastery: { discovered: 4, mastered: 1, version: 1, recent: [] } } },
      lastBestiary: bestiary ? { type: 'bestiary', version: 1, entries: bestiary } : null,
      requestBestiary: vi.fn(),
      onBestiary(cb: () => void) {
        listener = cb;
        return () => { listener = null; };
      },
      deliver(entries: MasteryEntry[]) {
        client.lastBestiary = { type: 'bestiary', version: 1, entries };
        listener?.();
      },
    };
    return client;
  }

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
