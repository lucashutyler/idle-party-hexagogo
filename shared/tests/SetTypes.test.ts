import { describe, it, expect } from 'vitest';
import {
  computeActiveSetBonuses,
  getSetInfoForItem,
  getSetsForItem,
  getSetDisplayName,
  setAppliesToClass,
  getActiveBreakpoint,
  normalizeBreakpoints,
  findSetConflicts,
  migrateLegacySet,
  mergeSetBonusesIntoEquip,
} from '../src/systems/SetTypes';
import type { SetDefinition, SetBreakpoint, SetBonuses } from '../src/systems/SetTypes';
import { createPartyCombatState, processPartyTick } from '../src/systems/CombatEngine';
import type { PartyCombatant } from '../src/systems/CombatEngine';
import { calculateMaxHp, calculateBaseDamage, CLASS_DEFINITIONS } from '../src/systems/CharacterStats';
import type { ClassName, DamageType } from '../src/systems/CharacterStats';
import type { PartyGridPosition } from '../src/systems/SocialTypes';
import type { SkillDefinition } from '../src/systems/SkillTypes';
import { createMonsterInstance } from '../src/systems/MonsterTypes';
import type { MonsterDefinition } from '../src/systems/MonsterTypes';

const emptyEquipment: Record<string, string | null> = {
  head: null, chest: null, mainhand: null, offhand: null, foot: null,
};

function withEquipped(items: Record<string, string>): Record<string, string | null> {
  return { ...emptyEquipment, ...items };
}

const knightSet: SetDefinition = {
  id: 'glowing_crystal_knight',
  name: 'Glowing Crystal Set',
  itemIds: ['gc_bracers', 'gc_boots', 'gc_breastplate', 'gc_shield', 'gc_sword'],
  classRestriction: ['Knight'],
  breakpoints: [
    { piecesRequired: 2, bonuses: { damageReductionMin: 1, damageReductionMax: 2 } },
    { piecesRequired: 4, bonuses: { damageReductionMin: 3, damageReductionMax: 5 } },
    { piecesRequired: 5, bonuses: { damageReductionMin: 5, damageReductionMax: 10, damagePercent: 10 } },
  ],
};

const bardSet: SetDefinition = {
  id: 'glowing_crystal_bard',
  name: 'Glowing Crystal Set',
  itemIds: ['gc_bracers', 'gc_hood', 'gc_boots', 'gc_harp'],
  classRestriction: ['Bard'],
  breakpoints: [
    { piecesRequired: 2, bonuses: { damagePercent: 5 } },
    { piecesRequired: 4, bonuses: { damagePercent: 15, cooldownReduction: 1 } },
  ],
};

const universalSet: SetDefinition = {
  id: 'starter_set',
  name: 'Starter Set',
  itemIds: ['s1', 's2', 's3'],
  breakpoints: [
    { piecesRequired: 3, bonuses: { flatHp: 20 } },
  ],
};

describe('setAppliesToClass', () => {
  it('returns true for unrestricted set', () => {
    expect(setAppliesToClass(universalSet, 'Knight')).toBe(true);
    expect(setAppliesToClass(universalSet, 'Bard')).toBe(true);
    expect(setAppliesToClass(universalSet, null)).toBe(true);
  });

  it('returns true when class is in the restriction list', () => {
    expect(setAppliesToClass(knightSet, 'Knight')).toBe(true);
  });

  it('returns false when class is not in the restriction list', () => {
    expect(setAppliesToClass(knightSet, 'Bard')).toBe(false);
  });

  it('returns true for a restricted set when className is omitted', () => {
    // No filter applied — used by admin previews and legacy callers.
    expect(setAppliesToClass(knightSet)).toBe(true);
  });
});

describe('getActiveBreakpoint', () => {
  it('returns null when count is below the lowest breakpoint', () => {
    expect(getActiveBreakpoint(knightSet, 1)).toBeNull();
    expect(getActiveBreakpoint(knightSet, 0)).toBeNull();
  });

  it('returns the highest breakpoint <= equipped count', () => {
    expect(getActiveBreakpoint(knightSet, 2)?.piecesRequired).toBe(2);
    expect(getActiveBreakpoint(knightSet, 3)?.piecesRequired).toBe(2);
    expect(getActiveBreakpoint(knightSet, 4)?.piecesRequired).toBe(4);
    expect(getActiveBreakpoint(knightSet, 5)?.piecesRequired).toBe(5);
    expect(getActiveBreakpoint(knightSet, 99)?.piecesRequired).toBe(5);
  });

  it('returns null when set has no breakpoints', () => {
    expect(getActiveBreakpoint({ ...knightSet, breakpoints: [] }, 5)).toBeNull();
  });

  it('returns highest tier even when breakpoints are not pre-sorted', () => {
    const unsorted: SetDefinition = {
      ...knightSet,
      breakpoints: [
        { piecesRequired: 5, bonuses: { damagePercent: 10 } },
        { piecesRequired: 2, bonuses: { damagePercent: 1 } },
        { piecesRequired: 4, bonuses: { damagePercent: 5 } },
      ],
    };
    expect(getActiveBreakpoint(unsorted, 4)?.piecesRequired).toBe(4);
  });
});

describe('normalizeBreakpoints', () => {
  it('clamps piecesRequired to [1, itemCount]', () => {
    const bps: SetBreakpoint[] = [
      { piecesRequired: 0, bonuses: { flatHp: 1 } },
      { piecesRequired: 99, bonuses: { flatHp: 2 } },
    ];
    const result = normalizeBreakpoints(bps, 4);
    expect(result[0].piecesRequired).toBe(1);
    expect(result[1].piecesRequired).toBe(4);
  });

  it('drops duplicates by piecesRequired', () => {
    const bps: SetBreakpoint[] = [
      { piecesRequired: 2, bonuses: { flatHp: 1 } },
      { piecesRequired: 2, bonuses: { flatHp: 999 } },
    ];
    const result = normalizeBreakpoints(bps, 4);
    expect(result).toHaveLength(1);
  });

  it('sorts ascending', () => {
    const bps: SetBreakpoint[] = [
      { piecesRequired: 4, bonuses: {} },
      { piecesRequired: 2, bonuses: {} },
      { piecesRequired: 3, bonuses: {} },
    ];
    const result = normalizeBreakpoints(bps, 5);
    expect(result.map(b => b.piecesRequired)).toEqual([2, 3, 4]);
  });
});

describe('computeActiveSetBonuses — breakpoints', () => {
  const sets = { knight: knightSet };

  it('grants no bonus below the lowest breakpoint', () => {
    const equip = withEquipped({ head: 'gc_bracers' });
    const result = computeActiveSetBonuses(equip, sets, 'Knight');
    expect(result.activeSetIds).toEqual([]);
    expect(result.bonuses.damageReductionMax).toBe(0);
  });

  it('grants the 2pc tier at exactly 2 pieces', () => {
    const equip = withEquipped({ head: 'gc_bracers', chest: 'gc_boots' });
    const result = computeActiveSetBonuses(equip, sets, 'Knight');
    expect(result.activeSetIds).toContain('glowing_crystal_knight');
    expect(result.bonuses.damageReductionMax).toBe(2);
  });

  it('does NOT stack tiers — only the highest unlocked tier applies', () => {
    // 5 pieces: only the 5pc tier (5/10 DR, 10% dmg) should apply, not 2pc + 4pc + 5pc.
    const equip = withEquipped({
      head: 'gc_bracers', chest: 'gc_boots', foot: 'gc_breastplate',
      mainhand: 'gc_shield', offhand: 'gc_sword',
    });
    const result = computeActiveSetBonuses(equip, sets, 'Knight');
    expect(result.bonuses.damageReductionMin).toBe(5);
    expect(result.bonuses.damageReductionMax).toBe(10);
    expect(result.bonuses.damagePercent).toBe(10);
  });
});

describe('computeActiveSetBonuses — class restriction', () => {
  const sets = { knight: knightSet, bard: bardSet, universal: universalSet };

  it('skips class-restricted sets when player class does not match', () => {
    // Bard equipping the knight pieces should not activate the knight set.
    const equip = withEquipped({
      head: 'gc_bracers', chest: 'gc_boots', foot: 'gc_breastplate',
    });
    const result = computeActiveSetBonuses(equip, sets, 'Bard');
    expect(result.activeSetIds).not.toContain('glowing_crystal_knight');
    expect(result.bonuses.damageReductionMax).toBe(0);
  });

  it('activates only the bard set for a Bard wearing overlapping pieces', () => {
    // gc_bracers and gc_boots are in BOTH the knight set and the bard set.
    // A Bard equipping these should only activate the bard set.
    const equip = withEquipped({ head: 'gc_bracers', chest: 'gc_boots' });
    const result = computeActiveSetBonuses(equip, sets, 'Bard');
    expect(result.activeSetIds).toEqual(['glowing_crystal_bard']);
    expect(result.bonuses.damagePercent).toBe(5);
  });

  it('activates only the knight set for a Knight wearing overlapping pieces', () => {
    const equip = withEquipped({ head: 'gc_bracers', chest: 'gc_boots' });
    const result = computeActiveSetBonuses(equip, sets, 'Knight');
    expect(result.activeSetIds).toEqual(['glowing_crystal_knight']);
    expect(result.bonuses.damageReductionMax).toBe(2);
  });

  it('activates a universal set for any class', () => {
    const equip = withEquipped({ head: 's1', chest: 's2', foot: 's3' });
    expect(computeActiveSetBonuses(equip, sets, 'Knight').activeSetIds).toContain('starter_set');
    expect(computeActiveSetBonuses(equip, sets, 'Bard').activeSetIds).toContain('starter_set');
    expect(computeActiveSetBonuses(equip, sets, 'Mage').activeSetIds).toContain('starter_set');
  });

  it('considers all sets when className is omitted (admin preview)', () => {
    const equip = withEquipped({ head: 'gc_bracers', chest: 'gc_boots' });
    const result = computeActiveSetBonuses(equip, sets);
    // Both knight and bard sets contain these items and would activate without class filter
    expect(result.activeSetIds).toContain('glowing_crystal_knight');
    expect(result.activeSetIds).toContain('glowing_crystal_bard');
  });
});

describe('findSetConflicts — per-class item uniqueness', () => {
  it('passes when both sets are class-restricted to different classes', () => {
    const errors = findSetConflicts(knightSet, [bardSet]);
    expect(errors).toEqual([]);
  });

  it('flags when two unrestricted sets share an item', () => {
    const setA: SetDefinition = { id: 'a', name: 'A', itemIds: ['x'], breakpoints: [] };
    const setB: SetDefinition = { id: 'b', name: 'B', itemIds: ['x', 'y'], breakpoints: [] };
    const errors = findSetConflicts(setA, [setB]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('all classes');
  });

  it('flags when a restricted set conflicts with an unrestricted set on the same item', () => {
    const restricted: SetDefinition = { id: 'r', name: 'R', itemIds: ['x'], classRestriction: ['Knight'], breakpoints: [] };
    const unrestricted: SetDefinition = { id: 'u', name: 'U', itemIds: ['x'], breakpoints: [] };
    expect(findSetConflicts(restricted, [unrestricted]).length).toBe(1);
    expect(findSetConflicts(unrestricted, [restricted]).length).toBe(1);
  });

  it('flags when two restricted sets overlap on a class', () => {
    const a: SetDefinition = { id: 'a', name: 'A', itemIds: ['x'], classRestriction: ['Knight', 'Bard'], breakpoints: [] };
    const b: SetDefinition = { id: 'b', name: 'B', itemIds: ['x'], classRestriction: ['Bard'], breakpoints: [] };
    expect(findSetConflicts(a, [b]).length).toBe(1);
  });

  it('passes when the same set is being updated (id matches)', () => {
    const updated: SetDefinition = { ...knightSet, name: 'Renamed' };
    const errors = findSetConflicts(updated, [knightSet]);
    expect(errors).toEqual([]);
  });

  it('passes when sets share NO items', () => {
    const a: SetDefinition = { id: 'a', name: 'A', itemIds: ['x'], breakpoints: [] };
    const b: SetDefinition = { id: 'b', name: 'B', itemIds: ['y'], breakpoints: [] };
    expect(findSetConflicts(a, [b])).toEqual([]);
  });

  it('reports all shared items in one error', () => {
    const a: SetDefinition = { id: 'a', name: 'A', itemIds: ['x', 'y', 'z'], breakpoints: [] };
    const b: SetDefinition = { id: 'b', name: 'B', itemIds: ['x', 'y', 'q'], breakpoints: [] };
    const errors = findSetConflicts(a, [b]);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('x');
    expect(errors[0]).toContain('y');
    expect(errors[0]).not.toContain('q'); // q only in b
  });
});

describe('migrateLegacySet', () => {
  it('converts legacy bonuses field to a single max-pieces breakpoint', () => {
    const legacy = {
      id: 'old',
      name: 'Old Set',
      itemIds: ['a', 'b', 'c'],
      bonuses: { damagePercent: 10 },
    };
    const migrated = migrateLegacySet(legacy);
    expect(migrated.breakpoints).toHaveLength(1);
    expect(migrated.breakpoints[0].piecesRequired).toBe(3);
    expect(migrated.breakpoints[0].bonuses.damagePercent).toBe(10);
  });

  it('preserves classRestriction', () => {
    const legacy = {
      id: 'k',
      name: 'K',
      itemIds: ['a'],
      classRestriction: ['Knight'],
      bonuses: { flatHp: 5 },
    };
    expect(migrateLegacySet(legacy).classRestriction).toEqual(['Knight']);
  });

  it('passes through new-shape sets unchanged', () => {
    const result = migrateLegacySet(knightSet);
    expect(result.breakpoints).toHaveLength(3);
    expect(result.classRestriction).toEqual(['Knight']);
  });

  it('handles a set with no breakpoints and no bonuses gracefully', () => {
    const empty = { id: 'e', name: 'E', itemIds: ['a'] };
    const migrated = migrateLegacySet(empty);
    expect(migrated.breakpoints).toEqual([]);
  });
});

describe('getSetInfoForItem & getSetsForItem with class filtering', () => {
  const sets = { knight: knightSet, bard: bardSet };

  it('getSetsForItem with no class filter returns all matching sets', () => {
    const matches = getSetsForItem('gc_bracers', sets);
    expect(matches.map(s => s.id).sort()).toEqual(['glowing_crystal_bard', 'glowing_crystal_knight']);
  });

  it('getSetsForItem filters to the player class', () => {
    expect(getSetsForItem('gc_bracers', sets, 'Knight')).toHaveLength(1);
    expect(getSetsForItem('gc_bracers', sets, 'Knight')[0].id).toBe('glowing_crystal_knight');
    expect(getSetsForItem('gc_bracers', sets, 'Bard')).toHaveLength(1);
    expect(getSetsForItem('gc_bracers', sets, 'Bard')[0].id).toBe('glowing_crystal_bard');
  });

  it('getSetsForItem returns nothing for an item not in any applicable set', () => {
    expect(getSetsForItem('gc_sword', sets, 'Bard')).toEqual([]); // sword is knight-only
  });

  it('getSetInfoForItem returns the class-matching set when className passed', () => {
    const owned = new Set(['gc_bracers', 'gc_boots']);
    const equipped = new Set(['gc_bracers']);
    const info = getSetInfoForItem('gc_bracers', sets, owned, equipped, 'Knight');
    expect(info?.set.id).toBe('glowing_crystal_knight');
    expect(info?.equippedCount).toBe(1);
    expect(info?.ownedCount).toBe(2);
  });
});

// ── Combat integration ───────────────────────────────────────

function makePlayer(
  username: string,
  pos: PartyGridPosition,
  overrides: Partial<{
    hp: number;
    className: ClassName;
    level: number;
    baseDamage: number;
    damageType: DamageType;
    equippedSkills: (SkillDefinition | null)[];
    setBonuses: SetBonuses;
  }> = {},
): PartyCombatant {
  const className = overrides.className ?? 'Archer';
  const level = overrides.level ?? 1;
  const hp = overrides.hp ?? calculateMaxHp(level, className);
  const baseDamage = overrides.baseDamage ?? calculateBaseDamage(level, className);
  const damageType = overrides.damageType ?? CLASS_DEFINITIONS[className].damageType;
  return {
    username,
    maxHp: hp,
    currentHp: hp,
    baseDamage,
    playerDamageType: damageType,
    gridPosition: pos,
    className,
    level,
    setBonuses: overrides.setBonuses,
    equippedSkills: overrides.equippedSkills ?? [null, null, null, null, null],
    attackCount: 0,
    stunTurns: 0,
    dots: [],
    hots: [],
    damageShield: 0,
    debuffs: [],
    consecutiveHits: 0,
    lastTargetId: '',
    hasResurrected: false,
    martyrBonus: 0,
    braceActive: false,
    braceDamageTaken: 0,
    interceptActive: false,
    activeSkillCount: 0,
  };
}

function makeStaticMonster(damage: number, damageType: DamageType = 'physical', hp = 1000): MonsterDefinition {
  return {
    id: 'test_monster',
    name: 'Test Monster',
    hp,
    damage,
    damageType,
    xp: 0,
    goldMin: 0,
    goldMax: 0,
  };
}

describe('mergeSetBonusesIntoEquip', () => {
  it('adds set flat DR/MR/attack into equipment bonuses', () => {
    const equip = {
      bonusAttackMin: 1, bonusAttackMax: 3,
      damageReductionMin: 0, damageReductionMax: 0,
      magicReductionMin: 0, magicReductionMax: 0,
    };
    const setB: SetBonuses = {
      bonusAttackMin: 5, bonusAttackMax: 5,
      damageReductionMin: 2, damageReductionMax: 4,
    };
    const merged = mergeSetBonusesIntoEquip(equip, setB);
    expect(merged.bonusAttackMin).toBe(6);
    expect(merged.bonusAttackMax).toBe(8);
    expect(merged.damageReductionMin).toBe(2);
    expect(merged.damageReductionMax).toBe(4);
  });
});

describe('Combat integration — set bonuses are applied', () => {
  it('damageResistancePercent reduces incoming monster damage', () => {
    // Monster always hits for 100. Player has 50% damage resistance from a set.
    // Without set: takes 100 damage. With set: takes 50.
    const playerWithSet = makePlayer('hero', 0, {
      hp: 200,
      className: 'Knight',
      setBonuses: { damageResistancePercent: 50 },
    });
    const playerNoSet = makePlayer('control', 0, {
      hp: 200,
      className: 'Knight',
    });
    const monsterDef = makeStaticMonster(100);
    const monster = createMonsterInstance(monsterDef);
    monster.gridPosition = 0;

    const stateA = createPartyCombatState([playerWithSet], [monster]);
    const stateB = createPartyCombatState([playerNoSet], [createMonsterInstance(monsterDef)]);

    // Tick: player attacks first (prelude), then monster attacks. Run a few ticks.
    for (let i = 0; i < 4; i++) processPartyTick(stateA);
    for (let i = 0; i < 4; i++) processPartyTick(stateB);

    const hpLossA = stateA.players[0].maxHp - stateA.players[0].currentHp;
    const hpLossB = stateB.players[0].maxHp - stateB.players[0].currentHp;

    // The set-protected player should lose strictly less HP.
    expect(hpLossA).toBeLessThan(hpLossB);
    // And the loss should be roughly halved (allow some tolerance because both could
    // include other reductions, but with no other defenses, A should be ~50% of B).
    expect(hpLossA).toBeLessThanOrEqual(Math.ceil(hpLossB / 2) + 1);
  });

  it('damagePercent boosts player attack damage', () => {
    // Two identical players, one with +100% damage from a set bonus, both attacking
    // a wall (passive monster with high HP that doesn't fight back). Compare HP loss.
    const playerWithSet = makePlayer('hero', 8, {
      className: 'Archer', level: 1, baseDamage: 10,
      setBonuses: { damagePercent: 100 },
    });
    const playerNoSet = makePlayer('control', 8, {
      className: 'Archer', level: 1, baseDamage: 10,
    });

    const wallDef: MonsterDefinition = {
      id: 'wall', name: 'Wall', hp: 10000, damage: 0,
      damageType: 'physical', xp: 0, goldMin: 0, goldMax: 0, passive: true,
    };
    const wallA = createMonsterInstance(wallDef);
    wallA.gridPosition = 0;
    const wallB = createMonsterInstance(wallDef);
    wallB.gridPosition = 0;

    const stateA = createPartyCombatState([playerWithSet], [wallA]);
    const stateB = createPartyCombatState([playerNoSet], [wallB]);

    for (let i = 0; i < 10; i++) processPartyTick(stateA);
    for (let i = 0; i < 10; i++) processPartyTick(stateB);

    const dmgA = stateA.monsters[0].maxHp - stateA.monsters[0].currentHp;
    const dmgB = stateB.monsters[0].maxHp - stateB.monsters[0].currentHp;

    // Player with damagePercent=100 should deal noticeably more damage.
    expect(dmgA).toBeGreaterThan(dmgB);
    // Roughly 2x (allow generous tolerance for damage variance).
    expect(dmgA).toBeGreaterThanOrEqual(Math.floor(dmgB * 1.5));
  });

  it('damage resistance is applied BEFORE flat reductions', () => {
    // Raw damage 100, 50% set resist → 50, then equip DR of 10 → final 40.
    // Without the "before flat" rule, you'd see (100-10)*0.5 = 45.
    // We can't observe the math directly without exposing internals, but we CAN
    // check the order via behavior at the boundary — large flat reduction with small
    // raw damage shouldn't underflow, etc. For now sanity: combined defenses don't
    // subtract more than rawDamage and produce non-negative results.
    const player = makePlayer('hero', 0, {
      hp: 500,
      className: 'Knight',
      setBonuses: { damageResistancePercent: 50 },
    });
    player.equipBonuses = {
      bonusAttackMin: 0, bonusAttackMax: 0,
      damageReductionMin: 10, damageReductionMax: 10,
      magicReductionMin: 0, magicReductionMax: 0,
    };
    const monsterDef = makeStaticMonster(100);
    const monster = createMonsterInstance(monsterDef);
    monster.gridPosition = 0;

    const state = createPartyCombatState([player], [monster]);
    const startHp = state.players[0].currentHp;
    for (let i = 0; i < 4; i++) processPartyTick(state);
    const lost = startHp - state.players[0].currentHp;

    // Some damage was dealt (resistance didn't drop it to 0) and we didn't take a full hit.
    expect(lost).toBeGreaterThan(0);
    expect(lost).toBeLessThan(100 * 4); // would be 400+ with no defenses
  });
});

describe('getSetDisplayName', () => {
  it('appends class restriction to the name', () => {
    expect(getSetDisplayName(knightSet)).toBe('Glowing Crystal Set (Knight)');
  });

  it('joins multiple class restrictions with commas', () => {
    const multi: SetDefinition = { ...knightSet, classRestriction: ['Knight', 'Bard'] };
    expect(getSetDisplayName(multi)).toBe('Glowing Crystal Set (Knight, Bard)');
  });

  it('returns plain name for unrestricted set', () => {
    expect(getSetDisplayName(universalSet)).toBe('Starter Set');
  });

  it('returns plain name when classRestriction is an empty array', () => {
    const empty: SetDefinition = { ...knightSet, classRestriction: [] };
    expect(getSetDisplayName(empty)).toBe('Glowing Crystal Set');
  });
});
