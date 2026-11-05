import { describe, expect, it } from 'vitest';
import {
  autoRetreatLikely,
  autoRetreatLine,
  forecastAriaLabel,
  forecastBand,
  forecastHeadline,
  forecastRangeLine,
  forecastRemainingMs,
  forecastSampleLine,
  forecastVerdict,
  formatApproxDuration,
  formatEnemyLevels,
  formatResumeMarker,
  formatWinPct,
  formatWinRange,
  isExactForecast,
  isForecastStale,
  parseDungeonResume,
  worstStratumLine,
} from '../src/combat/ForecastFormat';

const P = ' %';

function stats(winPct: number, ci: [number, number], extra: { sims?: number; medianMs?: number | null } = {}) {
  return { winPct, ci, sims: extra.sims ?? 200, medianMs: extra.medianMs ?? null };
}

describe('forecastVerdict', () => {
  it('uses the room bands Safe / Good / Slow / Losing', () => {
    expect(forecastVerdict(stats(95, [92, 98]), 'room').verdict).toBe('safe');
    expect(forecastVerdict(stats(80, [75, 85]), 'room').verdict).toBe('good');
    expect(forecastVerdict(stats(55, [50, 60]), 'room').verdict).toBe('slow');
    expect(forecastVerdict(stats(20, [15, 25]), 'room').verdict).toBe('losing');
  });

  it('uses Safe / Likely / Risky / Deadly for dungeons and live fights', () => {
    expect(forecastVerdict(stats(95, [92, 98]), 'dungeon').label).toBe('Safe');
    expect(forecastVerdict(stats(80, [75, 85]), 'dungeon').label).toBe('Likely');
    expect(forecastVerdict(stats(55, [50, 60]), 'battle').label).toBe('Risky');
    expect(forecastVerdict(stats(20, [15, 25]), 'battle').label).toBe('Deadly');
  });

  it('steps down one band when the CI lower bound is two bands below the point estimate', () => {
    expect(forecastVerdict(stats(92, [60, 99]), 'room')).toMatchObject({ verdict: 'good', band: 1 });
    expect(forecastVerdict(stats(78, [30, 95]), 'dungeon')).toMatchObject({ verdict: 'risky', band: 2 });
  });

  it('keeps the band when the lower bound is only one band lower', () => {
    expect(forecastVerdict(stats(75, [55, 90]), 'room').verdict).toBe('good');
    expect(forecastVerdict(stats(20, [0, 45]), 'battle').verdict).toBe('deadly');
  });

  it('bands at the thresholds', () => {
    expect(forecastBand(90)).toBe(0);
    expect(forecastBand(89.9)).toBe(1);
    expect(forecastBand(70)).toBe(1);
    expect(forecastBand(40)).toBe(2);
    expect(forecastBand(39.9)).toBe(3);
    expect(forecastBand(Number.NaN)).toBe(3);
  });
});

describe('display rule', () => {
  it('shows the exact number only when the Wilson half-width is at most 7 points', () => {
    expect(isExactForecast(stats(81, [74, 88]))).toBe(true);
    expect(formatWinPct(stats(81, [74, 88]))).toBe(`81${P}`);
    expect(isExactForecast(stats(62, [39, 78], { sims: 20 }))).toBe(false);
    expect(formatWinPct(stats(62, [39, 78], { sims: 20 }))).toBe(`~62${P}`);
  });

  it('never calls a zero-sample estimate exact', () => {
    expect(isExactForecast(stats(50, [50, 50], { sims: 0 }))).toBe(false);
  });

  it('gives the likely range only for loose estimates', () => {
    expect(formatWinRange(stats(62, [39, 78], { sims: 20 }))).toBe(`likely 39–78${P}`);
    expect(formatWinRange(stats(81, [74, 88]))).toBeNull();
    expect(forecastRangeLine(stats(62, [39, 78], { sims: 20 }))).toBe(`Win chance ~62${P}, likely 39–78${P}`);
    expect(forecastRangeLine(stats(81, [74, 88]))).toBeNull();
  });

  it('includes the verdict word in the aria label', () => {
    expect(forecastAriaLabel(stats(62, [39, 78], { sims: 20 }), 'battle')).toBe(`Win chance about 62${P}, Risky`);
    expect(forecastAriaLabel(stats(95, [93, 97]), 'room')).toBe(`Win chance 95${P}, Safe`);
  });
});

describe('formatApproxDuration', () => {
  it('formats short, medium and long durations', () => {
    expect(formatApproxDuration(12_000)).toBe('~0:12');
    expect(formatApproxDuration(400)).toBe('~0:01');
    expect(formatApproxDuration(290_000)).toBe('~4:50');
    expect(formatApproxDuration(100_000)).toBe('~1:40');
    expect(formatApproxDuration(23 * 60_000)).toBe('~23 min');
    expect(formatApproxDuration(95 * 60_000)).toBe('~1 h 35 min');
    expect(formatApproxDuration(120 * 60_000)).toBe('~2 h');
  });

  it('returns an empty string for missing values', () => {
    expect(formatApproxDuration(null)).toBe('');
    expect(formatApproxDuration(undefined)).toBe('');
    expect(formatApproxDuration(Number.NaN)).toBe('');
  });
});

describe('forecastHeadline', () => {
  it('words rooms as fights won out of ten with the typical fight length', () => {
    expect(forecastHeadline(stats(92, [89, 95], { medianMs: 12_000 }), 'room')).toBe('Wins ~9 in 10 fights · ~0:12 each');
    expect(forecastHeadline(stats(100, [98, 100], { medianMs: 8_000 }), 'room')).toBe('Wins every fight · ~0:08 each');
    expect(forecastHeadline(stats(97, [94, 99]), 'room')).toBe('Wins nearly every fight');
    expect(forecastHeadline(stats(0, [0, 2]), 'room')).toBe('Loses every fight');
    expect(forecastHeadline(stats(3, [1, 6]), 'room')).toBe('Wins almost no fights');
  });

  it('words dungeons as runs cleared', () => {
    expect(forecastHeadline(stats(70, [60, 78], { medianMs: 12 * 60_000 }), 'dungeon')).toBe('Clears ~7 in 10 runs · ~12 min each');
    expect(forecastHeadline(stats(0, [0, 8]), 'dungeon')).toBe("Can't clear it yet");
  });

  it('words live fights as this attempt, with the time left when known', () => {
    const live = stats(62, [39, 78], { sims: 20, medianMs: 100_000 });
    expect(forecastHeadline(live, 'battle')).toBe(`~62${P} to win this attempt`);
    expect(forecastHeadline(live, 'battle', 40_000)).toBe(`~62${P} to win this attempt · ~1:00 left`);
    expect(forecastRemainingMs({ medianMs: null }, 1000)).toBeNull();
    expect(forecastRemainingMs({ medianMs: 5000 }, 9000)).toBe(0);
  });
});

describe('secondary lines', () => {
  it('names the sample size with the right noun', () => {
    expect(forecastSampleLine({ sims: 20 }, 'room')).toBe('Estimate from 20 simulated fights');
    expect(forecastSampleLine({ sims: 40 }, 'dungeon')).toBe('Estimate from 40 simulated runs');
    expect(forecastSampleLine({ sims: 1 }, 'battle')).toBe('Estimate from 1 simulated fight');
  });

  it('describes the worst encounter by share', () => {
    expect(worstStratumLine({ label: 'Bandits', winPct: 41, sharePct: 33 })).toBe(`1 in 3 fights here are Bandits: wins 41${P}`);
    expect(worstStratumLine({ label: 'Pack', winPct: 23, sharePct: 40 })).toBe(`2 in 5 fights here are Pack: wins 23${P}`);
    expect(worstStratumLine({ label: 'Wolves', winPct: 10, sharePct: 70 })).toBe(`7 in 10 fights here are Wolves: wins 10${P}`);
    expect(worstStratumLine({ label: 'Rats', winPct: 55, sharePct: 10 })).toBe(`1 in 10 fights here are Rats: wins 55${P}`);
  });

  it('describes the auto-retreat policy', () => {
    expect(autoRetreatLine(25)).toBe(`Auto-retreat: below 25${P}`);
    expect(autoRetreatLine(0)).toBe('Auto-retreat: off');
    expect(autoRetreatLine(undefined)).toBe('Auto-retreat: off');
  });

  it('predicts a relocation only when the whole upper bound is under the threshold', () => {
    expect(autoRetreatLikely({ ci: [40, 54], sims: 200 }, 60)).toBe(true);
    expect(autoRetreatLikely({ ci: [40, 54], sims: 200 }, 40)).toBe(false);
    expect(autoRetreatLikely({ ci: [15, 26.1], sims: 200 }, 25)).toBe(false);
    expect(autoRetreatLikely({ ci: [0, 10], sims: 30 }, 0)).toBe(false);
    expect(autoRetreatLikely({ ci: [0, 0], sims: 0 }, 60)).toBe(false);
  });

  it('shows enemy levels only when authored', () => {
    expect(formatEnemyLevels({ enemyLevels: [8, 10] })).toBe('L8–10');
    expect(formatEnemyLevels({ enemyLevels: [5, 5] })).toBe('L5');
    expect(formatEnemyLevels({})).toBeNull();
  });

  it('marks a result stale when the party key moved on', () => {
    expect(isForecastStale({ partyKey: 'pk1' }, 'pk2')).toBe(true);
    expect(isForecastStale({ partyKey: 'pk1' }, 'pk1')).toBe(false);
    expect(isForecastStale({ partyKey: 'pk1' }, undefined)).toBe(false);
  });
});

describe('dungeon resume point', () => {
  it('reads floor, checkpoint and wipes from the forecast key', () => {
    expect(parseDungeonResume('2026.09.27.1|4|pkabc|dungeon:crystal_trial:2:1:1')).toEqual({ floorIndex: 2, phase: 1, wipes: 1 });
    expect(parseDungeonResume('dungeon:odd:id:with:colons:0:0:0')).toEqual({ floorIndex: 0, phase: 0, wipes: 0 });
  });

  it('rejects other targets and malformed keys', () => {
    expect(parseDungeonResume('v|1|pk|room:abc')).toBeNull();
    expect(parseDungeonResume('v|1|pk|dungeon:x:a:b:c')).toBeNull();
    expect(parseDungeonResume('v|1|pk|dungeon:x:1')).toBeNull();
    expect(parseDungeonResume('')).toBeNull();
    expect(parseDungeonResume(undefined)).toBeNull();
  });

  it('formats the resume marker, or nothing for a fresh start', () => {
    expect(formatResumeMarker({ floorIndex: 2, phase: 2 })).toBe('Resume: Floor 3 · Checkpoint 2');
    expect(formatResumeMarker({ floorIndex: 2, phase: 0 })).toBe('Resume: Floor 3');
    expect(formatResumeMarker({ floorIndex: 0, phase: 0 })).toBeNull();
    expect(formatResumeMarker(null)).toBeNull();
  });
});
