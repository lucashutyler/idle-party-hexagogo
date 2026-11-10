import { describe, expect, it } from 'vitest';
import type { ClientXpGauge } from '@idle-party-rpg/shared';
import { formatXpAmount, levelEtaText, xpGaugeLines, xpSinceLine } from '../src/ui/XpGaugeText';

const CHAR = { level: 7, xp: 0, xpForNextLevel: 36_000 };

function lines(gauge: ClientXpGauge | undefined, longFight = false) {
  return xpGaugeLines(gauge, CHAR, longFight);
}

describe('formatXpAmount', () => {
  it('shows two significant figures with a suffix', () => {
    expect(formatXpAmount(36_123)).toBe('36k');
    expect(formatXpAmount(1_234)).toBe('1.2k');
    expect(formatXpAmount(151_000)).toBe('150k');
    expect(formatXpAmount(1_250_000)).toBe('1.3m');
    expect(formatXpAmount(987)).toBe('990');
    expect(formatXpAmount(7)).toBe('7');
    expect(formatXpAmount(0)).toBe('0');
  });

  it('switches to the next suffix exactly at a thousand, including what rounds up to it', () => {
    expect(formatXpAmount(1000)).toBe('1k');
    expect(formatXpAmount(996)).toBe('1k');
    expect(formatXpAmount(1_000_000)).toBe('1m');
  });
});

describe('levelEtaText', () => {
  it.each([
    [30, 'about 1 min'],
    [7 * 60, 'about 7 min'],
    [9 * 60, 'about 9 min'],
    [12 * 60, 'about 10 min'],
    [23 * 60, 'about 25 min'],
    [57 * 60, 'about 55 min'],
    [58 * 60, 'about 1 h'],
    [4 * 3600, 'about 4 h'],
    [23.4 * 3600, 'about 23 h'],
    [23.6 * 3600, 'about 1 day'],
    [4 * 86_400, 'about 4 days'],
    [30 * 86_400, 'about 30 days'],
    [30.7 * 86_400, 'over a month'],
    [31 * 86_400, 'over a month'],
    [400 * 86_400, 'over a month'],
  ])('%s s reads %s', (seconds, text) => {
    expect(levelEtaText(seconds)).toBe(text);
  });

  it('says not at this rate when the rate is nothing', () => {
    expect(levelEtaText(null)).toBe('not at this rate');
    expect(levelEtaText(Number.POSITIVE_INFINITY)).toBe('not at this rate');
  });
});

describe('xpGaugeLines', () => {
  it('says about while estimating or settling, and drops it once steady', () => {
    expect(lines({ basis: 'estimate', perHour: 12_000 })).toEqual({ rate: 'about 12k XP/hr', level: 'Level 8 in about 3 h' });
    expect(lines({ basis: 'settling', perHour: 12_000 }).rate).toBe('about 12k XP/hr');
    expect(lines({ basis: 'steady', perHour: 12_000 })).toEqual({ rate: '12k XP/hr', level: 'Level 8 in about 3 h' });
  });

  it('counts only what is still needed for the next level', () => {
    expect(xpGaugeLines({ basis: 'steady', perHour: 12_000 }, { ...CHAR, xp: 30_000 }, false).level).toBe('Level 8 in about 30 min');
  });

  it('says Measuring before there is anything to go on', () => {
    expect(lines(undefined)).toEqual({ rate: 'Measuring', level: 'Level 8: measuring' });
    expect(lines({ basis: 'measuring' })).toEqual({ rate: 'Measuring', level: 'Level 8: measuring' });
  });

  it('calls a room that pays no XP what it is', () => {
    expect(lines({ basis: 'steady', perHour: 0, noXp: true })).toEqual({ rate: '0 XP/hr: this room pays no XP', level: 'Level 8: not from here' });
  });

  it('notes a room the party mostly loses, and a long fight under way ahead of it', () => {
    expect(lines({ basis: 'settling', perHour: 3_000, losing: true }).rate).toBe('about 3k XP/hr (mostly losing here)');
    expect(lines({ basis: 'steady', perHour: 12_000, longFightInMs: 0 }, true).rate).toBe('12k XP/hr (long fight under way)');
    expect(lines({ basis: 'settling', perHour: 3_000, losing: true, longFightInMs: 0 }, true).rate).toBe('about 3k XP/hr (long fight under way)');
  });

  it('says not at this rate for a room that pays but where nothing is earned', () => {
    expect(lines({ basis: 'steady', perHour: 0, losing: true }).level).toBe('Level 8: not at this rate');
  });

  it('labels a dungeon figure as this run so far, with no time to level', () => {
    expect(lines({ basis: 'run', perHour: 21_000 })).toEqual({ rate: '21k XP/hr this run so far', level: null });
    expect(lines({ basis: 'run', perHour: 21_000, losing: true }, true).rate).toBe('21k XP/hr this run so far');
    expect(lines({ basis: 'run' })).toEqual({ rate: 'Measuring', level: null });
  });
});

describe('xpSinceLine', () => {
  it('gives the time of the reset, what was earned and for how long', () => {
    const start = new Date(2026, 10, 9, 9, 40).getTime();
    expect(xpSinceLine(start, 75_400, start + 5 * 3_600_000 + 5 * 60_000)).toBe('Since 09:40: 75k XP in 5 h');
    expect(xpSinceLine(start, 0, start + 30_000)).toBe('Since 09:40: 0 XP in 0 min');
    expect(xpSinceLine(start, 12_000, start + 42 * 60_000)).toBe('Since 09:40: 12k XP in 42 min');
  });

  it('adds the date once the reset was on another day, and counts hours up to two days', () => {
    const start = new Date(2026, 10, 7, 22, 5).getTime();
    expect(xpSinceLine(start, 640_000, start + 30 * 3_600_000)).toBe('Since 11/07 22:05: 640k XP in 30 h');
    expect(xpSinceLine(start, 2_000_000, start + 60 * 3_600_000)).toBe('Since 11/07 22:05: 2m XP in 2 days');
  });
});
