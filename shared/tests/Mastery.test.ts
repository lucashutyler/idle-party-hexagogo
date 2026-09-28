import { describe, it, expect } from 'vitest';
import {
  MASTERY_THRESHOLDS,
  masteryRank,
  nextMasteryAt,
  prevMasteryAt,
  masteryBonus,
  isMasteryMoment,
  buildMasteryEntry,
  masteryRanks,
} from '../src/systems/Mastery';

describe('masteryRank', () => {
  it('counts thresholds reached per tier', () => {
    expect(masteryRank(0)).toBe(0);
    expect(masteryRank(9)).toBe(0);
    expect(masteryRank(10)).toBe(1);
    expect(masteryRank(249, 'trash')).toBe(2);
    expect(masteryRank(10_000, 'trash')).toBe(5);
    expect(masteryRank(1, 'boss')).toBe(1);
    expect(masteryRank(15, 'raid')).toBe(5);
    expect(masteryRank(4, 'elite')).toBe(0);
  });

  it('treats bad counts as zero', () => {
    expect(masteryRank(-5)).toBe(0);
    expect(masteryRank(NaN)).toBe(0);
  });

  it('has five ascending thresholds for every tier', () => {
    for (const thresholds of Object.values(MASTERY_THRESHOLDS)) {
      expect(thresholds).toHaveLength(5);
      for (let i = 1; i < thresholds.length; i++) expect(thresholds[i]).toBeGreaterThan(thresholds[i - 1]);
    }
  });
});

describe('next/prev thresholds', () => {
  it('reports the surrounding thresholds', () => {
    expect(nextMasteryAt(0)).toBe(10);
    expect(prevMasteryAt(0)).toBe(0);
    expect(nextMasteryAt(60)).toBe(250);
    expect(prevMasteryAt(60)).toBe(50);
    expect(nextMasteryAt(10_000)).toBeNull();
    expect(prevMasteryAt(10_000)).toBe(10_000);
  });
});

describe('masteryBonus', () => {
  it('adds 2 % per rank, capped at rank 5', () => {
    expect(masteryBonus(0)).toBe(0);
    expect(masteryBonus(3)).toBeCloseTo(0.06);
    expect(masteryBonus(9)).toBeCloseTo(0.1);
    expect(masteryBonus(-1)).toBe(0);
  });
});

describe('isMasteryMoment', () => {
  it('keeps trash rank 1 in the journal only', () => {
    expect(isMasteryMoment(1)).toBe(false);
    expect(isMasteryMoment(2, 'trash')).toBe(true);
    expect(isMasteryMoment(1, 'elite')).toBe(true);
    expect(isMasteryMoment(1, 'boss')).toBe(true);
    expect(isMasteryMoment(0, 'raid')).toBe(false);
  });
});

describe('buildMasteryEntry', () => {
  it('fills rank, thresholds and bonus', () => {
    expect(buildMasteryEntry('goblin', 60, { name: 'Goblin', level: 1 })).toEqual({
      monsterId: 'goblin',
      name: 'Goblin',
      level: 1,
      kills: 60,
      rank: 2,
      maxRank: 5,
      nextAt: 250,
      prevAt: 50,
      bonusPct: 4,
    });
  });

  it('keeps derived-level and tier markers', () => {
    const entry = buildMasteryEntry('chief', 3, { name: 'Chief', level: 9, levelDerived: true, tier: 'boss' });
    expect(entry.levelDerived).toBe(true);
    expect(entry.tier).toBe('boss');
    expect(entry.rank).toBe(2);
  });
});

describe('masteryRanks', () => {
  it('keeps only ranked monsters, using each tier', () => {
    const tiers: Record<string, 'trash' | 'boss'> = { chief: 'boss' };
    expect(masteryRanks({ goblin: 55, wolf: 3, chief: 3 }, id => tiers[id])).toEqual({ goblin: 2, chief: 2 });
  });

  it('keeps monster ids that are built-in object keys as plain keys', () => {
    const kills = JSON.parse('{"__proto__": 55, "constructor": 10}') as Record<string, number>;
    const ranks = masteryRanks(kills, () => 'trash');
    expect(Object.entries(ranks).sort()).toEqual([['__proto__', 2], ['constructor', 1]]);
    expect(ranks['__proto__']).toBe(2);
    expect(ranks.toString).toBeUndefined();
    expect(Object.getPrototypeOf(ranks)).toBeNull();
  });
});
