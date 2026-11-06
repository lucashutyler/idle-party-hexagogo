import { describe, expect, it } from 'vitest';
import { COMBAT_PACE } from '../../shared/src/systems/CombatPace.js';
import type { ReworkConfig } from './rework.js';
import { DEFAULT_REWORK_CONFIG, chooseInterval, classifyTier, collectMonsterUsage, isAlreadyReworked, renderChangelog, rework, staleDescriptions } from './rework.js';
import { enrageTimes, fit, goldRollOptions } from './fit.js';
import type { Place } from './fit.js';
import { classSubsets, defaultSeats, humanSeats, isAutoReplacingTrap } from './policy.js';
import type { TrialSweepRow } from './sweep.js';
import type { Baseline, CellResult, ContentSnapshot } from './types.js';

const CONFIG: ReworkConfig = {
  ...DEFAULT_REWORK_CONFIG,
  hp: { global: 2 },
  damage: { global: 1 },
  xp: { global: 0.5 },
  gold: { global: 0.5 },
  drop: { global: 0.5 },
  items: { drFactor: 3, mrFactor: 5, weaponAtkByClass: { Knight: 2 } },
};

function monster(id: string, hp: number, damage: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, name: id, hp, damage, damageType: 'physical', xp: 100, goldMin: 10, goldMax: 20, drops: [], ...extra };
}

function snapshot(): ContentSnapshot & Record<string, any> {
  return {
    monsters: {
      wolf: monster('wolf', 100, 10, {
        description: 'Bites every few turns.',
        drops: [
          { itemId: 'pelt', chance: 0.2 },
          { itemId: 'tooth', chance: 0.6 },
          { itemId: 'quest_token', chance: 0.1 },
        ],
      }),
      bear: monster('bear', 110, 20),
      gnat: monster('gnat', 80, 5, { skills: [{ skillId: 'fireball', value: 8, cooldown: 2 }] }),
      wall: monster('wall', 500, 0, { passive: true, xp: 0, goldMin: 0, goldMax: 0 }),
      king: monster('king', 5000, 30),
      capstone: monster('capstone', 4000, 25),
      unused: monster('unused', 10, 1),
    },
    items: {
      plate: { id: 'plate', equipSlot: 'chest', damageReductionMin: 2, damageReductionMax: 4, magicReductionMin: 1, magicReductionMax: 1 },
      sword: { id: 'sword', equipSlot: 'mainhand', classRestriction: ['Knight'], bonusAttackMin: 3, bonusAttackMax: 5 },
      staff: { id: 'staff', equipSlot: 'mainhand', classRestriction: ['Mage'], bonusAttackMin: 3, bonusAttackMax: 5 },
      charm: { id: 'charm', equipSlot: 'ring', classRestriction: ['Knight'], bonusAttackMin: 1, bonusAttackMax: 2 },
    },
    zones: {
      low: { id: 'low', displayName: 'Low', levelRange: [4, 6], encounterTable: [{ encounterId: 'pack', weight: 1 }] },
      high: { id: 'high', displayName: 'High', levelRange: [20, 22], encounterTable: [{ encounterId: 'pack', weight: 1 }, { encounterId: 'bears', weight: 1 }] },
    },
    encounters: {
      pack: { id: 'pack', monsterPool: [{ monsterId: 'wolf', min: 1, max: 2 }, { monsterId: 'gnat', min: 1, max: 1 }] },
      bears: { id: 'bears', placements: [{ monsterId: 'bear', gridPosition: 1 }, { monsterId: 'wall', gridPosition: 4 }] },
      court: { id: 'court', placements: [{ monsterId: 'king', gridPosition: 4 }, { monsterId: 'wolf', gridPosition: 1 }] },
      stand: { id: 'stand', placements: [{ monsterId: 'capstone', gridPosition: 4 }] },
      gate: { id: 'gate', placements: [{ monsterId: 'wall', gridPosition: 4 }] },
    },
    sets: {
      kit: { id: 'kit', breakpoints: [{ piecesRequired: 2, bonuses: { damageReductionMin: 1, damageReductionMax: 3, damagePercent: 10 } }] },
    },
    shops: {},
    henchmen: {
      guard: { id: 'guard', name: 'Guard', className: 'Knight', level: 5, maxHp: 50, baseDamage: 4, skillIds: ['knight_guard'] },
    },
    dungeons: {
      crypt: {
        id: 'crypt',
        name: 'Crypt',
        entryRequirements: { minLevel: 10 },
        floors: [
          { encounterTable: [{ encounterId: 'bears', weight: 1 }] },
          { isBoss: true, encounterTable: [{ encounterId: 'court', weight: 1 }] },
        ],
      },
    },
    skills: {
      knight_guard: { id: 'knight_guard', className: 'Knight', type: 'passive', unlockLevel: 1, passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 }], description: '+1 per level.' },
      mage_blast: { id: 'mage_blast', className: 'Mage', type: 'active', unlockLevel: 5, cooldown: 5, activeEffects: [{ kind: 'high_damage_single', damagePercent: 2.5 }], description: 'Hits once.' },
      bm_blast: { id: 'bm_blast', className: 'Mage', type: 'active', unlockLevel: null, cooldown: 5, activeEffects: [{ kind: 'high_damage_single', damagePercent: 1 }], description: 'Grant.' },
      mage_zap: { id: 'mage_zap', className: 'Mage', type: 'active', unlockLevel: 8, cooldown: 1, activeEffects: [{ kind: 'damage_percent', damagePercent: 0.75 }], description: 'Every round.' },
    },
    skillSlotSchedules: {},
    quests: {
      collect: { id: 'collect', description: 'Bring tokens.', objectives: [{ kind: 'collect', itemId: 'quest_token', count: 3 }] },
    },
    npcs: { sage: { id: 'sage' } },
    world: {
      defaultMapId: 'm1',
      maps: [{ id: 'm1', name: 'One' }, { id: 'm2', name: 'Two' }],
      tiles: [
        { id: 't1', mapId: 'm1', zone: 'low' },
        { id: 't2', mapId: 'm2', zone: 'high' },
        { id: 't3', mapId: 'm2', zone: 'high', dungeonId: 'crypt' },
        { id: 't4', mapId: 'm2', zone: 'high', encounterTable: [{ encounterId: 'stand', weight: 1 }] },
      ],
    },
  };
}

const SEED_SKILLS = {
  mage_blast: { id: 'mage_blast', castTime: 1, warmup: 2, trigger: 'enemy_cast' },
  knight_guard: { id: 'knight_guard' },
};

describe('collectMonsterUsage', () => {
  it('finds zones, rooms and floors and clamps dungeon levels to the entry minimum', () => {
    const usage = collectMonsterUsage(snapshot());
    expect(usage.get('wolf')!.map(p => p.kind).sort()).toEqual(['bossFloor', 'zone', 'zone']);
    expect(usage.get('capstone')![0].kind).toBe('room');
    expect(usage.has('unused')).toBe(false);
    const crypt = usage.get('king')![0];
    expect(crypt).toMatchObject({ kind: 'bossFloor', dungeonId: 'crypt', floorIndex: 1, level: 21 });
  });
});

describe('rework', () => {
  it('leaves the input alone and keeps every entry', () => {
    const input = snapshot();
    const before = JSON.stringify(input);
    const { content } = rework(input, CONFIG, SEED_SKILLS);
    expect(JSON.stringify(input)).toBe(before);
    for (const section of ['monsters', 'items', 'zones', 'encounters', 'sets', 'shops', 'henchmen', 'dungeons', 'skills', 'quests', 'npcs']) {
      expect(Object.keys(content[section]).sort()).toEqual(Object.keys(input[section]).sort());
    }
    expect(content.world).toEqual(input.world);
    expect(content.zones).toEqual(input.zones);
    expect(content.encounters).toEqual(input.encounters);
  });

  it('authors level, tier and interval, scaled from the earliest band', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    expect(content.monsters.wolf.level).toBe(5);
    expect(content.monsters.bear.level).toBe(21);
    expect(content.monsters.king.tier).toBe('boss');
    expect(content.monsters.capstone.tier).toBe('boss');
    expect(content.monsters.wolf.tier).toBe('trash');
    expect(content.monsters.unused.tier).toBeUndefined();
    expect(content.monsters.unused.hp).toBe(10);
    expect(content.monsters.wolf.hp).toBe(200);
  });

  it('turns a per-second damage factor into a per-hit value on the chosen interval', () => {
    const { content } = rework(snapshot(), { ...CONFIG, damage: { global: 0.5 } }, SEED_SKILLS);
    const wolf = content.monsters.wolf;
    expect(wolf.damage).toBe(Math.round(10 * 0.5 * wolf.attackInterval));
  });

  it('keeps a wall passive: more HP and scaled drops, nothing else', () => {
    const input = snapshot();
    input.monsters.wall.drops = [{ itemId: 'pelt', chance: 0.2 }];
    const { content } = rework(input, CONFIG, SEED_SKILLS);
    const wall = content.monsters.wall;
    expect(wall.drops[0].chance).toBeCloseTo(0.1);
    expect(wall.passive).toBe(true);
    expect(wall.hp).toBe(1000);
    expect(wall.damage).toBe(0);
    expect(wall.attackInterval).toBeUndefined();
    expect(wall.tier).toBeUndefined();
  });

  it('scales drop chances, quest items included, except high chances', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    const chance = (id: string): number => content.monsters.wolf.drops.find((d: any) => d.itemId === id).chance;
    expect(chance('pelt')).toBeCloseTo(0.1);
    expect(chance('tooth')).toBe(0.6);
    expect(chance('quest_token')).toBeCloseTo(0.05);
  });

  it('rounds gold by factor unless an exact roll is given', () => {
    const scaled = rework(snapshot(), CONFIG, SEED_SKILLS).content.monsters.bear;
    expect([scaled.goldMin, scaled.goldMax]).toEqual([5, 10]);
    const exact = rework(snapshot(), { ...CONFIG, goldRanges: { bear: [0, 0] } }, SEED_SKILLS).content.monsters.bear;
    expect([exact.goldMin, exact.goldMax]).toEqual([0, 0]);
  });

  it('scales item and set rating, and only weapons locked to the named classes', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    expect(content.items.plate).toMatchObject({ damageReductionMin: 6, damageReductionMax: 12, magicReductionMin: 5, magicReductionMax: 5 });
    expect(content.items.sword).toMatchObject({ bonusAttackMin: 6, bonusAttackMax: 10 });
    expect(content.items.staff).toMatchObject({ bonusAttackMin: 3, bonusAttackMax: 5 });
    expect(content.items.charm).toMatchObject({ bonusAttackMin: 1, bonusAttackMax: 2 });
    expect(content.sets.kit.breakpoints[0].bonuses).toEqual({ damageReductionMin: 3, damageReductionMax: 9, damagePercent: 10 });
  });

  it('adopts seed timing, and grant-only variants follow their parent', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    expect(content.skills.mage_blast).toMatchObject({ castTime: 1, warmup: 2, trigger: 'enemy_cast' });
    expect(content.skills.bm_blast).toMatchObject({ castTime: 1, warmup: 2, trigger: 'enemy_cast' });
    expect(content.skills.knight_guard.passiveEffects[0].valuePerLevel).toBe(2);
  });

  it('converts an action-counted warm-up the seed has none for, once', () => {
    const before = snapshot();
    Object.assign(before.skills.mage_blast, { warmup: 3 });
    Object.assign(before.skills.mage_zap, { warmup: 0 });
    before.skills.triggered = { id: 'triggered', className: 'Mage', type: 'active', unlockLevel: 9, cooldown: 4, warmup: 2, trigger: 'enemy_cast', activeEffects: [] };
    const seed = {
      mage_blast: { id: 'mage_blast', charge: 11.5, recovery: 1 },
      mage_zap: { id: 'mage_zap', charge: 2, recovery: 0.5 },
      triggered: { id: 'triggered', charge: 3.5 },
    };
    const { content } = rework(before, CONFIG, seed);
    expect(content.skills.mage_blast.warmup).toBe(6.8);
    expect(content.skills.mage_zap.warmup).toBe(0);
    expect(content.skills.triggered.warmup).toBe(3.6);

    const migrated = snapshot();
    Object.assign(migrated.skills.mage_blast, { charge: 5, warmup: 3 });
    delete migrated.skills.mage_blast.cooldown;
    expect(rework(migrated, CONFIG, seed).content.skills.mage_blast.warmup).toBe(3);
  });

  it('leaves an instant with no recovery: the seed charge wins, else its recovery moves to the charge', () => {
    const before = snapshot();
    Object.assign(before.skills.mage_blast, { trigger: 'enemy_cast', charge: 9, recovery: 0.9 });
    before.skills.custom_block = { id: 'custom_block', className: 'Mage', type: 'active', unlockLevel: 9, charge: 3, recovery: 0.5, activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }] };
    before.skills.custom_strike = { id: 'custom_strike', className: 'Mage', type: 'active', unlockLevel: 9, charge: 3, recovery: 0.5, activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }] };
    const { content } = rework(before, CONFIG, { mage_blast: { id: 'mage_blast', charge: 9.9, trigger: 'enemy_cast' } });
    expect(content.skills.mage_blast.charge).toBe(9.9);
    expect(content.skills.mage_blast.recovery).toBeUndefined();
    expect(content.skills.custom_block.charge).toBe(3.5);
    expect(content.skills.custom_block.recovery).toBeUndefined();
    expect(content.skills.custom_strike).toMatchObject({ charge: 3, recovery: 0.5 });
  });

  it('adds no seed Attack to a class that already has an attack skill', () => {
    const before = snapshot();
    before.skills.mage_basic = { id: 'mage_basic', className: 'Mage', type: 'attack', unlockLevel: 1, charge: 1, recovery: 0 };
    const seed = {
      mage_attack: { id: 'mage_attack', className: 'Mage', type: 'attack', unlockLevel: 1, charge: 2, recovery: 0.5 },
      knight_attack: { id: 'knight_attack', className: 'Knight', type: 'attack', unlockLevel: 1, charge: 3.6, recovery: 0 },
    };
    const { content } = rework(before, CONFIG, seed);
    expect(content.skills.mage_attack).toBeUndefined();
    expect(content.skills.mage_basic).toBeDefined();
    expect(content.skills.knight_attack).toBeDefined();
  });

  it('patches skills and reworks an auto-replacing trap', () => {
    const before = snapshot();
    expect(isAutoReplacingTrap(before.skills.mage_zap)).toBe(true);
    const { content } = rework(before, { ...CONFIG, skills: { mage_zap: { cooldown: 2, effects: { 0: { damagePercent: 1.2 } } } } }, SEED_SKILLS);
    expect(isAutoReplacingTrap(content.skills.mage_zap)).toBe(false);
    expect(content.skills.mage_zap.activeEffects[0].damagePercent).toBe(1.2);
  });

  it('adopts seed charge and recovery in place of a cooldown, and adds the seed Attack skills', () => {
    const seed = {
      mage_blast: { id: 'mage_blast', charge: 11.5, recovery: 1, castTime: 1, warmup: 3 },
      mage_attack: { id: 'mage_attack', name: 'Attack', className: 'Mage', type: 'attack', unlockLevel: 1, sortOrder: -1, charge: 2, recovery: 0.5 },
    };
    const { content } = rework(snapshot(), CONFIG, seed);
    expect(content.skills.mage_blast).toMatchObject({ charge: 11.5, recovery: 1, castTime: 1, warmup: 3 });
    expect(content.skills.mage_blast.cooldown).toBeUndefined();
    expect(content.skills.bm_blast).toMatchObject({ charge: 11.5, recovery: 1 });
    expect(content.skills.bm_blast.cooldown).toBeUndefined();
    expect(content.skills.mage_attack).toMatchObject({ type: 'attack', charge: 2, recovery: 0.5 });
    expect(content.skills.mage_zap.cooldown).toBe(1);
  });

  it('judges a timed skill a trap only when it never leaves its owner a gap to attack in', () => {
    const zap = { type: 'active', activeEffects: [{ kind: 'damage_percent', damagePercent: 0.75 }] };
    expect(isAutoReplacingTrap({ ...zap, cooldown: 1 })).toBe(true);
    expect(isAutoReplacingTrap({ ...zap, charge: 0, recovery: 2 })).toBe(true);
    expect(isAutoReplacingTrap({ ...zap, recovery: 2 })).toBe(true);
    expect(isAutoReplacingTrap({ ...zap, charge: 2, recovery: 0.5 })).toBe(false);
  });

  it('puts checkpoints only on boss floors that can field a boss', () => {
    const input = snapshot();
    input.dungeons.empty = { id: 'empty', name: 'Empty', floors: [{ isBoss: true, encounterTable: [{ encounterId: 'gate', weight: 1 }] }] };
    input.world.tiles.push({ id: 't5', mapId: 'm2', zone: 'high', dungeonId: 'empty' });
    const { content } = rework(input, CONFIG, SEED_SKILLS);
    expect(content.dungeons.crypt.floors[0].checkpoints).toBeUndefined();
    expect(content.dungeons.crypt.floors[1].checkpoints).toEqual([0.66, 0.33]);
    expect(content.dungeons.empty.floors[0].checkpoints).toBeUndefined();
  });

  it('applies text, henchman stats and enrage, and logs them', () => {
    const { content, changelog } = rework(snapshot(), {
      ...CONFIG,
      enrage: { king: { afterSeconds: 200 } },
      henchmen: { guard: { maxHp: 60 } },
      text: { monsters: { wolf: 'Bites every few seconds.' }, skills: { mage_zap: 'Every 2 seconds.' }, quests: { collect: 'Bring three tokens.' } },
    }, SEED_SKILLS);
    expect(content.monsters.king.enrage).toEqual({ afterSeconds: 200 });
    expect(content.henchmen.guard.maxHp).toBe(60);
    expect(content.quests.collect.description).toBe('Bring three tokens.');
    expect(staleDescriptions(content)).toEqual([]);
    expect(changelog.find(c => c.id === 'guard')!.changes).toContain('maxHp: 50 > 60');
    expect(renderChangelog(changelog)).toContain('## monsters');
  });

  it('flags descriptions still counting rounds or turns', () => {
    const stale = staleDescriptions(snapshot());
    expect(stale.map(s => `${s.section}/${s.id}`)).toEqual(['skills/mage_zap', 'monsters/wolf']);
  });

  it('is repeatable', () => {
    expect(rework(snapshot(), CONFIG, SEED_SKILLS).content).toEqual(rework(snapshot(), CONFIG, SEED_SKILLS).content);
  });
});

describe('a second pass', () => {
  it('refuses a snapshot that already carries the rework', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    expect(isAlreadyReworked(snapshot())).toBe(false);
    expect(isAlreadyReworked(content)).toBe(true);
    expect(() => rework(content, CONFIG, SEED_SKILLS)).toThrow(/already carries the rework/);
  });

  it('compounds only when forced', () => {
    const { content } = rework(snapshot(), CONFIG, SEED_SKILLS);
    expect(rework(content, CONFIG, SEED_SKILLS, { force: true }).content.monsters.wolf.hp).toBe(400);
  });
});

describe('monster skill values', () => {
  it('stay out of a per-monster damage factor and follow the skill rule', () => {
    const config: ReworkConfig = { ...CONFIG, damage: { global: 0.5, monsters: { gnat: 0.2 } }, monsterSkills: { bySkill: { fireball: 0.75 } } };
    const { content } = rework(snapshot(), config, SEED_SKILLS);
    expect(content.monsters.gnat.skills[0].value).toBe(6);
  });

  it('default to the global damage factor, with a per-monster factor on top', () => {
    const config: ReworkConfig = { ...CONFIG, damage: { global: 0.5 }, monsterSkills: { monsters: { gnat: 1.5 } } };
    expect(rework(snapshot(), config, SEED_SKILLS).content.monsters.gnat.skills[0].value).toBe(6);
  });

  it('grow a heal with the HP factor only when asked', () => {
    const input = snapshot();
    input.monsters.gnat.skills = [{ skillId: 'heal', value: 10, cooldown: 4 }];
    expect(rework(input, CONFIG, SEED_SKILLS).content.monsters.gnat.skills[0].value).toBe(10);
    const config: ReworkConfig = { ...CONFIG, monsterSkills: { healFollowsHp: true } };
    expect(rework(input, config, SEED_SKILLS).content.monsters.gnat.skills[0].value).toBe(20);
  });
});

describe('small hits', () => {
  const small: ReworkConfig = { ...CONFIG, damage: { global: 0.1 } };

  it('let the interval absorb the rounding', () => {
    const { content } = rework(snapshot(), small, SEED_SKILLS);
    expect(content.monsters.bear.attackInterval).toBeGreaterThan(0);
    expect(content.monsters.bear.damage).toBeLessThan(10);
  });

  it('never override a set interval', () => {
    const input = snapshot();
    const config: ReworkConfig = { ...small, intervals: { ...small.intervals, overrides: { bear: 3 } } };
    expect(rework(input, config, SEED_SKILLS).content.monsters.bear.attackInterval).toBe(3);
  });

  it('never pass the skill cap', () => {
    const input = snapshot();
    input.monsters.bear.skills = [{ skillId: 'fireball', value: 8, cooldown: 3 }];
    expect(rework(input, small, SEED_SKILLS).content.monsters.bear.attackInterval).toBeLessThanOrEqual(1.5);
  });
});

describe('text and grants', () => {
  it('replaces recipe text and flags stale recipes', () => {
    const input = snapshot();
    input.recipes = { frame: { id: 'frame', name: 'Frame', description: 'Fires every other turn.' } };
    expect(staleDescriptions(rework(input, CONFIG, SEED_SKILLS).content).some(s => s.id === 'frame')).toBe(true);
    const config: ReworkConfig = { ...CONFIG, text: { recipes: { frame: 'Fires every 2 seconds.' } } };
    const { content, changelog } = rework(input, config, SEED_SKILLS);
    expect(content.recipes.frame.description).toBe('Fires every 2 seconds.');
    expect(changelog.some(c => c.section === 'recipes' && c.id === 'frame')).toBe(true);
  });

  it('adds a passive to a skill once', () => {
    const config: ReworkConfig = { ...CONFIG, skills: { knight_guard: { addPassiveEffects: [{ kind: 'max_hp_percent', valuePerLevel: 2 }, { kind: 'physical_reduction', valuePerLevel: 9 }] } } };
    const effects = rework(snapshot(), config, SEED_SKILLS).content.skills.knight_guard.passiveEffects;
    expect(effects.map((e: any) => e.kind)).toEqual(['physical_reduction', 'max_hp_percent']);
    expect(effects[0].valuePerLevel).toBe(2);
  });
});

describe('quest drops', () => {
  it('scale with the rest, down to the floor, and a floor never raises a chance', () => {
    const input = snapshot();
    input.monsters.wolf.drops = [{ itemId: 'quest_token', chance: 0.1 }, { itemId: 'quest_token', chance: 0.002 }];
    const config: ReworkConfig = { ...CONFIG, drop: { global: 0.01 }, questDropFloor: 0.005 };
    expect(rework(input, config, SEED_SKILLS).content.monsters.wolf.drops.map((d: any) => d.chance)).toEqual([0.005, 0.002]);
  });
});

describe('goldRollOptions', () => {
  it('never pays more than authored', () => {
    for (const [lo, hi] of goldRollOptions({ goldMin: 6, goldMax: 10 })) expect((lo + hi) / 2).toBeLessThanOrEqual(8);
  });

  it('lets only a poor ordinary monster stop paying', () => {
    const zero = (rolls: [number, number][]): boolean => rolls.some(r => r[1] === 0);
    expect(zero(goldRollOptions({ goldMin: 1, goldMax: 2 }))).toBe(true);
    expect(zero(goldRollOptions({ goldMin: 1, goldMax: 2, tier: 'elite' }))).toBe(false);
    expect(zero(goldRollOptions({ goldMin: 3, goldMax: 4 }))).toBe(false);
  });
});

describe('enrageTimes', () => {
  const trial = (comp: string, sec: number, win = 100): TrialSweepRow => ({
    dungeonId: 'crypt', dungeonName: 'Crypt', regionIndex: 0, comp, level: 21, minLevel: 10, clearPct: win, medianRunSec: sec, bossMedianSec: sec, bossWinPct: win, floorWins: [100, win], floorSecs: [10, sec],
  });
  const reworked = (): ContentSnapshot => rework(snapshot(), CONFIG, SEED_SKILLS).content;

  it('takes the slowest full party with a tank and healer: a duo is under-built', () => {
    expect(enrageTimes([], [trial('K+P', 500), trial('K+P+M', 100), trial('K+A+P', 150), trial('A+M+B', 900)], reworked(), 'king')).toEqual([100, 150]);
  });

  it('falls back to any full-size winner where no tank and healer may enter', () => {
    expect(enrageTimes([], [trial('A+M+B', 300), trial('A+M', 900), trial('M+B+A', 800, 0)], reworked(), 'king')).toEqual([300]);
  });

  it('counts duos, and what hires took on the old engine, for an open-world capstone', () => {
    const cell = (comp: string, medianSec: number): CellResult => ({ comp, medianSec, winPct: 100 } as CellResult);
    const place: Place = { key: 'room|t4', kind: 'room', regionId: 'm2', monsterIds: ['capstone'], old: new Map([['K+hires', cell('K+hires', 230)]]), cur: new Map([['K+P', cell('K+P', 200)], ['K', cell('K', 900)]]) };
    const times = enrageTimes([place], [], reworked(), 'capstone');
    expect(times[0]).toBe(200);
    expect(times[1]).toBeCloseTo(100 * COMBAT_PACE.clock);
  });
});

describe('seats and parties for the sweeps', () => {
  it('seats the leader in the centre and the rest in the first free seats', () => {
    expect(defaultSeats(3)).toEqual([4, 0, 1]);
    expect(defaultSeats(6)).toEqual([4, 0, 1, 2, 3, 5]);
    expect(humanSeats(['Priest', 'Knight'], false, defaultSeats(2)).map(s => s.gridPosition)).toEqual([4, 0]);
  });

  it('lists every class combination once', () => {
    const ids = classSubsets().map(c => c.id);
    expect(ids).toHaveLength(31);
    expect(new Set(ids).size).toBe(31);
    expect(ids).toContain('K+P+M');
  });
});

describe('classifyTier', () => {
  const rules = DEFAULT_REWORK_CONFIG.tiers;
  const band = { hp: 100, damage: 10 };
  const zone = { kind: 'zone', zoneId: 'z', regionId: 'r', level: 5 } as const;
  const room = { kind: 'room', zoneId: 'z', regionId: 'r', level: 5 } as const;
  const bossFloor = { kind: 'bossFloor', zoneId: 'z', regionId: 'r', level: 5, dungeonId: 'd', floorIndex: 0 } as const;

  it('reads boss floors, capstones and elites', () => {
    expect(classifyTier({ id: 'a', hp: 1000 }, [bossFloor], band, () => 1000, rules)).toBe('boss');
    expect(classifyTier({ id: 'b', hp: 100 }, [bossFloor], band, () => 1000, rules)).toBe('trash');
    expect(classifyTier({ id: 'c', hp: 600 }, [room], band, () => 0, rules)).toBe('boss');
    expect(classifyTier({ id: 'd', hp: 600 }, [room, zone], band, () => 0, rules)).toBe('elite');
    expect(classifyTier({ id: 'e', hp: 110 }, [zone], band, () => 0, rules)).toBe('trash');
  });

  it('honours an override', () => {
    expect(classifyTier({ id: 'f', hp: 110 }, [zone], band, () => 0, { ...rules, overrides: { f: 'raid' } })).toBe('raid');
  });
});

describe('chooseInterval', () => {
  const rules = DEFAULT_REWORK_CONFIG.intervals;
  const band = { hp: 100, damage: 10 };

  it('picks by role', () => {
    expect(chooseInterval({ id: 'a', damage: 10 }, 'trash', band, rules)).toBe(rules.normal);
    expect(chooseInterval({ id: 'b', damage: 20 }, 'trash', band, rules)).toBe(rules.heavy);
    expect(chooseInterval({ id: 'c', damage: 5 }, 'trash', band, rules)).toBe(rules.skirmisher);
    expect(chooseInterval({ id: 'd', damage: 10 }, 'boss', band, rules)).toBe(rules.boss);
  });

  it('never lets a skill outpace the actions it would replace', () => {
    expect(chooseInterval({ id: 'e', damage: 10, skills: [{ cooldown: 2 }] }, 'boss', band, rules)).toBe(1);
  });
});

describe('fit', () => {
  function cell(id: string, comp: string, medianSec: number, xpPerHour: number, goldPerHour: number): CellResult {
    return { id, kind: 'zone', regionId: 'm2', regionName: 'Two', regionIndex: 0, zoneId: 'high', zoneName: 'High', level: 21, levelVariant: 'mid', gear: 'shop', comp, table: undefined, medianSec, winPct: 100, xpPerHour, goldPerHour, strata: [{ encounterId: 'pack', sharePct: 100, sims: 10, winPct: 100, medianSec }] } as unknown as CellResult;
  }
  function baseline(cells: CellResult[], pauseMs: number): Baseline {
    return { meta: { pauseMs } as Baseline['meta'], cells, dungeons: [] };
  }
  const options = { damp: 1, monsterOutliers: false, outlierThreshold: 0.1, enrageFactor: 1.6, hpLostTarget: 15, sample: () => [{ wolf: 2 }], trials: [] };

  it('moves a too-short region up in HP', () => {
    const live = snapshot();
    const config = structuredClone(CONFIG);
    const oldB = baseline([cell('a', 'K+P', 230, 100, 100)], 2000);
    const cur = baseline([cell('a', 'K+P', 50, 100, 100)], 1800);
    fit(config, live, live, oldB, cur, ['hp'], options);
    expect(config.hp.regions!.m2).toBeCloseTo(2 * COMBAT_PACE.clock, 1);
  });

  it('fits whole-number gold rolls against the old rate', () => {
    const live = snapshot();
    const config = structuredClone(CONFIG);
    const oldB = baseline([cell('a', 'K+P+M', 60, 100, 300)], 2000);
    const cur = baseline([cell('a', 'K+P+M', 34, 100, 900)], 2000);
    fit(config, live, live, oldB, cur, ['gold'], options);
    const [lo, hi] = config.goldRanges!.wolf;
    const perFight = Math.ceil((2 * (lo + hi)) / 2 / 3);
    expect(perFight * (3600 / 36)).toBeGreaterThan(150);
    expect(perFight * (3600 / 36)).toBeLessThan(600);
  });

  it('scales drops by the kill rate ratio', () => {
    const live = snapshot();
    const config = structuredClone(CONFIG);
    const oldB = baseline([cell('a', 'K+P+M', 58, 100, 100)], 2000);
    const cur = baseline([cell('a', 'K+P+M', 28, 100, 100)], 2000);
    fit(config, live, live, oldB, cur, ['drop'], options);
    expect(config.drop.monsters!.wolf).toBeCloseTo(0.5 / COMBAT_PACE.rewardMultiplier, 2);
  });
});
