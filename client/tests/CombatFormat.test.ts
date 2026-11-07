import { describe, expect, it } from 'vitest';
import {
  enrageSlotText,
  formatAmount,
  formatClock,
  formatDuration,
  formatMultiplier,
  formatSeconds,
  hasToughTier,
  hpTier,
  initials,
  interruptStampText,
  isBossOrRaid,
  masteryLine,
  monsterLevelBadge,
  pipsKey,
  statusIcon,
  statusPips,
} from '../src/combat/CombatFormat';
import { CombatLogFormatter } from '../src/combat/CombatLogFormatter';

describe('number formatting', () => {
  it('formats the fight clock as m:ss', () => {
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7400)).toBe('0:07');
    expect(formatClock(65_000)).toBe('1:05');
    expect(formatClock(-50)).toBe('0:00');
  });

  it('formats countdowns with one decimal under ten seconds', () => {
    expect(formatSeconds(0)).toBe('');
    expect(formatSeconds(2340)).toBe('2.4');
    expect(formatSeconds(1000)).toBe('1.0');
    expect(formatSeconds(12_100)).toBe('13');
    expect(formatSeconds(9990)).toBe('10');
  });

  it('formats static durations without trailing zeros', () => {
    expect(formatDuration(2000)).toBe('2s');
    expect(formatDuration(1500)).toBe('1.5s');
    expect(formatDuration(1250)).toBe('1.3s');
  });

  it('abbreviates large amounts', () => {
    expect(formatAmount(12)).toBe('12');
    expect(formatAmount(9999)).toBe('9999');
    expect(formatAmount(12_345)).toBe('12.3k');
    expect(formatAmount(123_456)).toBe('123k');
    expect(formatAmount(1_234_567)).toBe('1.2M');
    expect(formatAmount(-40)).toBe('40');
  });

  it('buckets HP fractions', () => {
    expect(hpTier(1)).toBe('high');
    expect(hpTier(0.6)).toBe('mid');
    expect(hpTier(0.5)).toBe('low');
    expect(hpTier(0.2)).toBe('critical');
  });

  it('derives portrait initials', () => {
    expect(initials('Goblin Shaman')).toBe('GS');
    expect(initials('wolf')).toBe('WO');
    expect(initials('Bram #2')).toBe('BR');
    expect(initials('')).toBe('?');
  });
});

describe('status pips', () => {
  it('orders stun and shield before statuses and carries stacks', () => {
    const pips = statusPips({
      hp: 10, stunMs: 400, shield: 12,
      statuses: [{ kind: 'dot', name: 'Ignite', stacks: 3 }, { kind: 'mark', name: 'Sunder', stacks: 2 }],
    });
    expect(pips.map(p => p.icon)).toEqual(['💫', '🛡', '🔥', '🎯']);
    expect(pips[2].count).toBe(3);
    expect(pips[3].count).toBe(2);
    expect(pipsKey(pips)).toBe('💫|🛡|🔥3|🎯2');
  });

  it('shows nothing on a dead unit', () => {
    expect(statusPips({ hp: 0, stunMs: 500, shield: 5, statuses: [{ kind: 'dot', name: 'Bleed' }] })).toEqual([]);
  });

  it('maps status kinds and names to icons', () => {
    expect(statusIcon({ kind: 'dot', name: 'Bleed' }).icon).toBe('🩸');
    expect(statusIcon({ kind: 'dot', name: 'Rot' }).icon).toBe('☠');
    expect(statusIcon({ kind: 'hot', name: 'Mending' })).toEqual({ icon: '✚', tone: 'good' });
    expect(statusIcon({ kind: 'buff', name: 'War Song' }).icon).toBe('🎵');
    expect(statusIcon({ kind: 'debuff', name: 'Crippling Shot' }).icon).toBe('⬇');
    expect(statusIcon({ kind: 'chaos', name: 'Chaos' }).icon).toBe('🌀');
  });
});

describe('CombatLogFormatter', () => {
  it('colours names with one combined pattern and rewrites the viewer as You', () => {
    const f = new CombatLogFormatter();
    f.setRoster('Kay', ['Pia', 'Old Tom'], ['Goblin', 'Goblin Shaman']);
    expect(f.format('Kay hits Goblin Shaman for 5 physical damage'))
      .toBe('<span class="log-name-self">You</span> hit <span class="log-name-enemy">Goblin Shaman</span> for 5 <span class="dmg-physical">physical</span> damage');
    expect(f.format("Kay's Bash stuns Goblin!"))
      .toBe('<span class="log-name-self">Your</span> Bash stuns <span class="log-name-enemy">Goblin</span>!');
    expect(f.format('Kay has fallen!')).toBe('<span class="log-name-self">You</span> have fallen!');
    expect(f.format('Kay intercepts an attack')).toBe('<span class="log-name-self">You</span> intercept an attack');
    expect(f.format('Kay misses Goblin')).toBe('<span class="log-name-self">You</span> miss <span class="log-name-enemy">Goblin</span>');
    expect(f.format('Kay applies Bleed')).toBe('<span class="log-name-self">You</span> apply Bleed');
    expect(f.format('Kay cures Pia')).toBe('<span class="log-name-self">You</span> cure <span class="log-name-party">Pia</span>');
    expect(f.format('Old Tom heals Pia')).toBe('<span class="log-name-party">Old Tom</span> heals <span class="log-name-party">Pia</span>');
  });

  it('lowercases the viewer mid-sentence and keeps capitals after a sentence break', () => {
    const f = new CombatLogFormatter();
    f.setRoster('Kay', ['Pia'], ['Goblin']);
    expect(f.format('Goblin hits Kay for 3')).toBe('<span class="log-name-enemy">Goblin</span> hits <span class="log-name-self">you</span> for 3');
    expect(f.format("Pia intercepts Goblin's attack aimed at Kay!"))
      .toBe('<span class="log-name-party">Pia</span> intercepts <span class="log-name-enemy">Goblin</span>\'s attack aimed at <span class="log-name-self">you</span>!');
    expect(f.format("Pia counters Kay's foe")).toBe('<span class="log-name-party">Pia</span> counters <span class="log-name-self">your</span> foe');
    expect(f.format("Goblin falls! Kay's turn")).toBe('<span class="log-name-enemy">Goblin</span> falls! <span class="log-name-self">Your</span> turn');
  });

  it('does not colour names inside longer words and escapes HTML', () => {
    const f = new CombatLogFormatter();
    f.setRoster('Al', [], ['Rat']);
    expect(f.format('Alice <b>Rattles</b> Rat')).toBe('Alice &lt;b&gt;Rattles&lt;/b&gt; <span class="log-name-enemy">Rat</span>');
  });

  it('rebuilds only when the roster changes and drops cached lines then', () => {
    const f = new CombatLogFormatter();
    expect(f.setRoster('Kay', ['Pia'], ['Wolf'])).toBe(true);
    expect(f.setRoster('Kay', ['Pia'], ['Wolf'])).toBe(false);
    expect(f.format('Wolf bites', 'k1')).toContain('log-name-enemy');
    f.setRoster('Kay', ['Pia'], []);
    expect(f.format('Wolf bites', 'k1')).toBe('Wolf bites');
  });
});

describe('interruptStampText', () => {
  it('stamps COUNTERED! only for interrupts the engine marks as counters', () => {
    expect(interruptStampText({ countered: true })).toBe('COUNTERED!');
    expect(interruptStampText({})).toBe('INTERRUPTED!');
  });
});

describe('monster levels and tiers', () => {
  it('badges authored levels only, coloured by the gap to the viewer', () => {
    expect(monsterLevelBadge({ level: 9, levelSource: 'authored' }, 5)).toEqual({ level: 9, con: 'deadly', label: 'Deadly', glyph: '☠' });
    expect(monsterLevelBadge({ level: 12, levelSource: 'authored' }, 10)).toMatchObject({ con: 'even', glyph: '●' });
    expect(monsterLevelBadge({ level: 2, levelSource: 'authored' }, 30)).toMatchObject({ con: 'trivial', glyph: '·' });
    expect(monsterLevelBadge({ level: 9, levelSource: 'authored' }, undefined)).toMatchObject({ con: 'even' });
  });

  it('never badges derived or missing levels', () => {
    expect(monsterLevelBadge({ level: 41, levelSource: 'derived' }, 5)).toBeNull();
    expect(monsterLevelBadge({ level: 4 }, 5)).toBeNull();
    expect(monsterLevelBadge({ levelSource: 'authored' }, 5)).toBeNull();
    expect(monsterLevelBadge(undefined, 5)).toBeNull();
  });

  it('classifies tiers', () => {
    expect(hasToughTier('trash')).toBe(false);
    expect(hasToughTier(undefined)).toBe(false);
    expect(hasToughTier('elite')).toBe(true);
    expect(isBossOrRaid('elite')).toBe(false);
    expect(isBossOrRaid('boss')).toBe(true);
    expect(isBossOrRaid('raid')).toBe(true);
  });
});

describe('boss bar text', () => {
  it('counts the enrage down rounded up, then shows the multiplier', () => {
    expect(enrageSlotText({ state: 'pending', remainingMs: 287_400, multiplier: 1 })).toBe('⏱ 4:48');
    expect(enrageSlotText({ state: 'soon', remainingMs: 200, multiplier: 1 })).toBe('⏱ 0:01');
    expect(enrageSlotText({ state: 'on', remainingMs: 0, multiplier: 1.6000000001 })).toBe('🔥 ×1.6');
  });

  it('formats multipliers with at most two decimals', () => {
    expect(formatMultiplier(1.1)).toBe('×1.1');
    expect(formatMultiplier(1.256)).toBe('×1.26');
    expect(formatMultiplier(2)).toBe('×2');
  });

  it('marks enrage as a bad status', () => {
    expect(statusIcon({ kind: 'enrage', name: 'Enraged', stacks: 3 })).toEqual({ icon: '😡', tone: 'bad' });
    expect(statusPips({ hp: 10, stunMs: 0, shield: 0, statuses: [{ kind: 'enrage', name: 'Enraged', stacks: 3 }] }))
      .toEqual([{ icon: '😡', tone: 'bad', title: 'Enraged', count: 3 }]);
  });
});

describe('masteryLine', () => {
  it('shows stars, bonus and progress to the next rank', () => {
    expect(masteryLine({ rank: 2, maxRank: 5, kills: 212, nextAt: 250, bonusPct: 4 })).toBe('★★☆☆☆ · +4 % · 212 / 250 kills');
    expect(masteryLine({ rank: 0, maxRank: 5, kills: 3, nextAt: 10, bonusPct: 0 })).toBe('☆☆☆☆☆ · 3 / 10 kills');
    expect(masteryLine({ rank: 5, maxRank: 5, kills: 12_000, nextAt: null, bonusPct: 10 })).toBe('★★★★★ Mastered · +10 %');
  });
});
