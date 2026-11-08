import { describe, expect, it } from 'vitest';
import {
  PARTY_XP_SHARE,
  STARTER_ZONE_LONE_XP_SHARE,
  XP_LEVEL_GAP,
  fightXp,
  floorMonsterXp,
  floorPayFactor,
  isHarmlessMonster,
  levelGapXpFactor,
  partyXpBonus,
  partyXpShare,
} from '../src/systems/XpRules';
import type { FightXpInput, XpMonster } from '../src/systems/XpRules';
import type { SkillDefinition } from '../src/systems/SkillTypes';

function monster(xp: number, level?: number, over: Partial<XpMonster> = {}): XpMonster {
  return {
    xp,
    level,
    levelSource: level === undefined ? 'derived' : 'authored',
    maxHp: 100,
    damage: 10,
    ...over,
  };
}

function pay(over: Partial<FightXpInput> = {}): number {
  return fightXp({ monsters: [monster(100, 10)], memberLevel: 10, topHumanLevel: 10, bodies: 1, rewardMultiplier: 1, ...over });
}

describe('partyXpShare', () => {
  it('pays each member by bodies in the fight', () => {
    expect([1, 2, 3, 4, 5].map(n => partyXpShare(n))).toEqual([1, 0.91, 0.82, 0.76, 0.72]);
    expect(PARTY_XP_SHARE.slice(1)).toEqual([1, 0.91, 0.82, 0.76, 0.72]);
  });

  it('holds at the last entry and never reads off the table', () => {
    expect(partyXpShare(6)).toBe(0.72);
    expect(partyXpShare(0)).toBe(1);
  });

  it('takes no cut in a starter zone, and a lone player keeps 80 %', () => {
    expect(partyXpShare(1, true)).toBe(STARTER_ZONE_LONE_XP_SHARE);
    for (const bodies of [2, 3, 4, 5]) expect(partyXpShare(bodies, true)).toBe(1);
  });
});

describe('levelGapXpFactor going backwards', () => {
  it('pays in full down to 2 levels below the member', () => {
    expect(levelGapXpFactor(30, 30, 30)).toBe(1);
    expect(levelGapXpFactor(29, 30, 30)).toBe(1);
    expect(levelGapXpFactor(28, 30, 30)).toBe(1);
  });

  it('decays from the 3rd level below', () => {
    expect(levelGapXpFactor(27, 30, 30)).toBeCloseTo(Math.exp(-0.4), 12);
    expect(levelGapXpFactor(25, 30, 30)).toBeCloseTo(Math.exp(-1.2), 12);
    expect(levelGapXpFactor(24, 30, 30)).toBeCloseTo(Math.exp(-1.6), 12);
  });

  it('stops at the floor', () => {
    expect(levelGapXpFactor(23, 30, 30)).toBe(XP_LEVEL_GAP.floor);
    expect(levelGapXpFactor(1, 60, 60)).toBe(0.2);
  });
});

describe('levelGapXpFactor going up', () => {
  it('adds 12 % a level up to 5 levels over the highest human', () => {
    expect(levelGapXpFactor(31, 30, 30)).toBeCloseTo(1.12, 12);
    expect(levelGapXpFactor(33, 30, 30)).toBeCloseTo(1.36, 12);
    expect(levelGapXpFactor(35, 30, 30)).toBeCloseTo(1.6, 12);
  });

  it('falls 7 % a level past that', () => {
    expect(levelGapXpFactor(36, 30, 30)).toBeCloseTo(1.6 * 0.93, 12);
    expect(levelGapXpFactor(40, 30, 30)).toBeCloseTo(1.6 * 0.93 ** 5, 12);
  });

  it('reads the bonus on the highest human, and the decay on the member', () => {
    expect(levelGapXpFactor(31, 10, 30)).toBeCloseTo(1.12, 12);
    expect(levelGapXpFactor(30, 10, 30)).toBe(1);
    expect(levelGapXpFactor(20, 10, 30)).toBe(1);
    expect(levelGapXpFactor(20, 30, 30)).toBe(0.2);
    expect(levelGapXpFactor(20, 22, 40)).toBe(1);
    expect(levelGapXpFactor(20, 23, 40)).toBeCloseTo(Math.exp(-0.4), 12);
  });

  it('gives a harmless monster no bonus at any gap', () => {
    expect(levelGapXpFactor(31, 30, 30, true)).toBeCloseTo(0.93, 12);
    expect(levelGapXpFactor(35, 30, 30, true)).toBeCloseTo(0.93 ** 5, 12);
    expect(levelGapXpFactor(30, 30, 30, true)).toBe(1);
    expect(levelGapXpFactor(20, 30, 30, true)).toBe(0.2);
  });
});

describe('isHarmlessMonster', () => {
  it('reads walls, 1 HP fodder and monsters that cannot hurt anyone', () => {
    expect(isHarmlessMonster(monster(1, 1, { passive: true }))).toBe(true);
    expect(isHarmlessMonster(monster(1, 1, { maxHp: 1 }))).toBe(true);
    expect(isHarmlessMonster(monster(1, 1, { damage: 1 }))).toBe(true);
    expect(isHarmlessMonster(monster(1, 1, { damage: 0, skills: [] }))).toBe(true);
  });

  it('does not count a monster with real damage, or a weak hitter with a skill', () => {
    expect(isHarmlessMonster(monster(1, 1, { damage: 2 }))).toBe(false);
    expect(isHarmlessMonster(monster(1, 1, { damage: 1, skills: [{ skillId: 'fireball', value: 9, cooldown: 3 }] }))).toBe(false);
  });
});

describe('floor factors', () => {
  it('reads absent and invalid factors as paying in full', () => {
    for (const bad of [undefined, null, 'half', NaN, Infinity, -0.1, 1.5]) expect(floorPayFactor(bad)).toBe(1);
    expect(floorPayFactor(0)).toBe(0);
    expect(floorPayFactor(0.25)).toBe(0.25);
    expect(floorPayFactor(1)).toBe(1);
  });

  it('cuts a monster that pays to at least 1, and leaves one that paid nothing at nothing', () => {
    expect(floorMonsterXp(100, 0.25)).toBe(25);
    expect(floorMonsterXp(100, 0.004)).toBe(1);
    expect(floorMonsterXp(100, 0)).toBe(1);
    expect(floorMonsterXp(10, 0.125)).toBe(1);
    expect(floorMonsterXp(9, 0.5)).toBe(5);
    expect(floorMonsterXp(0, 0.5)).toBe(0);
    expect(floorMonsterXp(-5, 0.5)).toBe(0);
  });

  it('leaves XP alone at a factor of 1, fractions included', () => {
    expect(floorMonsterXp(100, 1)).toBe(100);
    expect(floorMonsterXp(0.25, 1)).toBe(0.25);
  });

  it('applies the cut before the level gap', () => {
    expect(pay({ monsters: [monster(100, 35)], floorXpFactor: 0.5 })).toBe(Math.ceil(50 * 1.6 * 0.93 ** 20));
    expect(pay({ monsters: [monster(3, 10)], floorXpFactor: 0.5, memberLevel: 13, topHumanLevel: 13 })).toBe(Math.ceil(2 * Math.exp(-0.4)));
  });

  it('pays in full on a bad factor', () => {
    expect(pay({ floorXpFactor: 7 })).toBe(100);
    expect(pay({ floorXpFactor: NaN })).toBe(100);
  });
});

describe('fightXp', () => {
  it('multiplies the pot by the bonus, the reward multiplier and the share', () => {
    expect(pay({ bodies: 3, xpBonus: 1.5, rewardMultiplier: 2 })).toBe(246);
  });

  it('pays every monster in the fight by its own level, and flat with no authored level', () => {
    const monsters = [monster(100, 10), monster(100, 11), monster(100)];
    expect(pay({ monsters })).toBe(Math.ceil(100 + 112 + 100));
  });

  it('never scales an unauthored monster, even far below the member', () => {
    expect(pay({ monsters: [monster(100, 1, { levelSource: 'derived' })], memberLevel: 60, topHumanLevel: 60 })).toBe(100);
    expect(pay({ monsters: [monster(100)], memberLevel: 60, topHumanLevel: 60 })).toBe(100);
  });

  it('pays a carried friend the carrier-level bonus, and the carrier the decay', () => {
    const fight = { monsters: [monster(100, 22)], topHumanLevel: 30, bodies: 2 };
    expect(pay({ ...fight, memberLevel: 10 })).toBe(91);
    expect(pay({ ...fight, memberLevel: 30 })).toBe(Math.ceil(100 * Math.exp(-0.4 * 6 > Math.log(0.2) ? -0.4 * 6 : Math.log(0.2)) * 0.91));
  });

  it('pays a harmless monster over the party no bonus', () => {
    expect(pay({ monsters: [monster(100, 15, { damage: 1 })] })).toBe(Math.ceil(100 * 0.93 ** 5));
    expect(pay({ monsters: [monster(100, 15)] })).toBe(160);
  });

  describe('starter zones', () => {
    it('takes no cut for a party and 80 % from a lone player', () => {
      expect(pay({ starterZone: true, bodies: 1 })).toBe(80);
      expect(pay({ starterZone: true, bodies: 2 })).toBe(100);
      expect(pay({ starterZone: true, bodies: 5 })).toBe(100);
    });

    it('is the usual table without the flag', () => {
      expect(pay({ starterZone: false, bodies: 5 })).toBe(72);
      expect(pay({ bodies: 1 })).toBe(100);
    });
  });

  describe('rounding', () => {
    it('rounds up per member', () => {
      expect(pay({ monsters: [monster(1, 10)], bodies: 2 })).toBe(1);
      expect(pay({ monsters: [monster(11, 10)], bodies: 2 })).toBe(11);
      expect(pay({ monsters: [monster(10.5, 10)] })).toBe(11);
    });

    it('sums fractional monster XP before rounding', () => {
      const monsters = [monster(0.25), monster(0.25), monster(0.25)];
      expect(pay({ monsters })).toBe(1);
      expect(pay({ monsters: [...monsters, monster(0.25), monster(0.25)] })).toBe(2);
    });

    it('does not round a whole result up on float noise', () => {
      expect(50 * 1.1 * 1.8).toBeGreaterThan(99);
      expect(pay({ monsters: [monster(50, 10)], xpBonus: 1.1, rewardMultiplier: 1.8 })).toBe(99);
      expect(750 * 1.1 * 0.76).toBeGreaterThan(627);
      expect(pay({ monsters: [monster(750, 10)], xpBonus: 1.1, bodies: 4 })).toBe(627);
    });

    it('pays exactly nothing for a fight that pays nothing', () => {
      expect(Object.is(pay({ monsters: [monster(0, 10)] }), 0)).toBe(true);
      expect(pay({ monsters: [] })).toBe(0);
    });

    it('skips non-finite XP', () => {
      expect(pay({ monsters: [monster(NaN, 10), monster(Infinity), monster(10, 10)] })).toBe(10);
    });
  });
});

describe('partyXpBonus', () => {
  const skill = (flatValue: number): SkillDefinition => ({
    id: 's', name: 's', description: '', className: 'Bard', type: 'passive', unlockLevel: 1, sortOrder: 0,
    passiveEffects: [{ kind: 'xp_bonus', flatValue }],
  });

  it('adds every copy across the bodies, ignoring empty slots', () => {
    expect(partyXpBonus([{ equippedSkills: [skill(0.2), null] }, { equippedSkills: [skill(0.1)] }])).toBeCloseTo(1.3, 12);
    expect(partyXpBonus([{ equippedSkills: [null] }])).toBe(1);
    expect(partyXpBonus([])).toBe(1);
  });
});
