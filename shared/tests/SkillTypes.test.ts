import { describe, it, expect } from 'vitest';
import {
  SEED_SKILLS,
  SEED_SKILL_SLOT_SCHEDULES,
  migrateLegacySkill,
  canEquipSkill,
  equipSkillInSlot,
  unequipSkillFromSlot,
  createDefaultSkillLoadout,
  reconcileSkillLoadout,
  getSkillById,
  getSkillsForClass,
  getSlotSchedule,
  getUnlockedSkillsForLevel,
  getSkillTrigger,
  getSkillCardType,
  SKILL_TRIGGER_VALUES,
  SKILL_TRIGGER_INFO,
  SKILL_CARD_TYPE_INFO,
} from '../src/systems/SkillTypes';
import type { SkillContent, SkillDefinition, SkillSlot } from '../src/systems/SkillTypes';
import type { ClassName } from '../src/systems/CharacterStats';
import { SKILL_OPTION_CATALOG } from '../src/systems/SkillOptionCatalog';
import { COMBAT_PACE, paceActionSeconds, paceKit, paceSkillSeconds } from '../src/systems/CombatPace';
import { IGNITE_MAX_STACKS, SUNDER_MAX_STACKS, WAR_SONG_MAX_STACKS } from '../src/systems/CombatScaling';
import { MIN_COOLDOWN_MS, SCORCH_MS } from '../src/systems/CombatTiming';
import { validateSkillDefinition } from '../src/systems/SkillOptionCatalog';

const CONTENT: SkillContent = { skills: SEED_SKILLS, slotSchedules: SEED_SKILL_SLOT_SCHEDULES };

const ALL_CLASSES = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] as const;

/** Real seconds as a card writes them: one decimal, or a whole number within a tenth of one. */
function cardSeconds(seconds: number): number {
  const whole = Math.round(seconds);
  return Math.abs(seconds - whole) <= 0.1 + 1e-9 ? whole : Math.round(seconds * 10) / 10;
}

function ownSeconds(skill: SkillDefinition, authored: number): number {
  return cardSeconds(paceSkillSeconds(COMBAT_PACE, skill, skill.className, authored));
}

/** The historical 55 skill ids — these live in player saves and must never change. */
const HISTORICAL_SKILL_IDS: Record<string, string[]> = {
  Knight: [
    'knight_guard', 'knight_bash', 'knight_fortify', 'knight_intercept', 'knight_shield_bash',
    'knight_shield_slam', 'knight_iron_will', 'knight_sunder', 'knight_tenacity', 'knight_dispel', 'knight_war_cry',
  ],
  Archer: [
    'archer_pierce', 'archer_cut_down', 'archer_marksman', 'archer_triple_shot', 'archer_brave',
    'archer_snipe', 'archer_exploit_weakness', 'archer_bleed', 'archer_precision', 'archer_crippling_shot', 'archer_focus',
  ],
  Priest: [
    'priest_bless', 'priest_minor_heal', 'priest_devotion', 'priest_smite', 'priest_blessed_arms',
    'priest_cure', 'priest_consecrate', 'priest_mending', 'priest_martyr', 'priest_sanctuary', 'priest_resurrection',
  ],
  Mage: [
    'mage_burn', 'mage_magic_missile', 'mage_intensify', 'mage_zap', 'mage_ignite',
    'mage_blizzard', 'mage_arcane_surge', 'mage_chain_lightning', 'mage_overflow', 'mage_arcane_blast', 'mage_scorch',
  ],
  Bard: [
    'bard_rally', 'bard_dissonance', 'bard_tempo', 'bard_drumroll', 'bard_nimble',
    'bard_war_song', 'bard_inspiration', 'bard_lullaby', 'bard_unnerve', 'bard_chaos', 'bard_encore',
  ],
};

describe('SkillTypes', () => {
  describe('SEED_SKILL_SLOT_SCHEDULES', () => {
    it('every class has the historical 5-slot schedule', () => {
      for (const cn of ALL_CLASSES) {
        expect(SEED_SKILL_SLOT_SCHEDULES[cn]).toEqual([
          { type: 'passive', unlocksAtLevel: 1 },
          { type: 'active', unlocksAtLevel: 5 },
          { type: 'passive', unlocksAtLevel: 10 },
          { type: 'passive', unlocksAtLevel: 30 },
          { type: 'passive', unlocksAtLevel: 50 },
        ]);
      }
    });

    it('getSlotSchedule returns the content schedule when present', () => {
      const custom: SkillSlot[] = [{ type: 'active', unlocksAtLevel: 1 }];
      const content: SkillContent = { skills: SEED_SKILLS, slotSchedules: { Knight: custom } };
      expect(getSlotSchedule('Knight', content)).toEqual(custom);
    });

    it('getSlotSchedule falls back to the seed schedule when the class is missing', () => {
      const content: SkillContent = { skills: SEED_SKILLS, slotSchedules: {} };
      expect(getSlotSchedule('Knight', content)).toEqual(SEED_SKILL_SLOT_SCHEDULES.Knight);
    });
  });

  describe('migrateLegacySkill', () => {
    it('converts a legacy passive: treeOrder 0 → unlockLevel 1, singular effect wrapped', () => {
      const migrated = migrateLegacySkill({
        id: 'legacy_guard', name: 'Guard', description: 'd', className: 'Knight', type: 'passive',
        treeOrder: 0,
        passiveEffect: { kind: 'physical_reduction', valuePerLevel: 2 },
      } as never);
      expect(migrated.unlockLevel).toBe(1);
      expect(migrated.sortOrder).toBe(0);
      expect(migrated.passiveEffects).toEqual([{ kind: 'physical_reduction', valuePerLevel: 2 }]);
      expect(migrated.activeEffects).toBeUndefined();
      expect((migrated as Record<string, unknown>).passiveEffect).toBeUndefined();
      expect((migrated as Record<string, unknown>).treeOrder).toBeUndefined();
    });

    it('converts a legacy active: treeOrder N → unlockLevel N*5, cooldown preserved', () => {
      const migrated = migrateLegacySkill({
        id: 'legacy_bash', name: 'Bash', description: 'd', className: 'Knight', type: 'active',
        treeOrder: 7,
        activeEffect: { kind: 'stacking_mark', markMultiplier: 0.25 },
        cooldown: 3,
      } as never);
      expect(migrated.unlockLevel).toBe(35);
      expect(migrated.sortOrder).toBe(7);
      expect(migrated.activeEffects).toEqual([{ kind: 'stacking_mark', markMultiplier: 0.25 }]);
      expect(migrated.cooldown).toBe(3);
    });

    it('passes castTime, warmup and trigger through legacy migration', () => {
      const migrated = migrateLegacySkill({
        id: 'legacy_timing', name: 'Timing', description: 'd', className: 'Mage', type: 'active',
        treeOrder: 2, activeEffect: { kind: 'damage_percent', damagePercent: 1 },
        cooldown: 2.5, castTime: 1.5, warmup: 0, trigger: 'ally_low_hp',
      } as never);
      expect(migrated).toMatchObject({ cooldown: 2.5, castTime: 1.5, warmup: 0, trigger: 'ally_low_hp' });
      const plain = migrateLegacySkill({ id: 'p', name: 'P', description: 'd', className: 'Mage', type: 'active', treeOrder: 1, activeEffect: { kind: 'damage_percent', damagePercent: 1 }, cooldown: 1 } as never);
      expect(plain).not.toHaveProperty('castTime');
      expect(plain).not.toHaveProperty('warmup');
      expect(plain).not.toHaveProperty('trigger');
    });

    it('passes an already-migrated skill through unchanged (deep copy)', () => {
      const modern: SkillDefinition = {
        id: 'modern', name: 'Modern', description: 'd', className: 'Mage', type: 'active',
        unlockLevel: null, sortOrder: 3, cooldown: 2,
        passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }],
        activeEffects: [{ kind: 'damage_percent', damagePercent: 0.5 }],
      };
      const migrated = migrateLegacySkill(modern);
      expect(migrated).toEqual(modern);
      expect(migrated).not.toBe(modern);
      expect(migrated.passiveEffects![0]).not.toBe(modern.passiveEffects![0]);
    });

    it('prefers explicit unlockLevel/sortOrder over treeOrder derivation', () => {
      const migrated = migrateLegacySkill({
        id: 'mixed', name: 'Mixed', description: 'd', className: 'Bard', type: 'passive',
        treeOrder: 4, unlockLevel: 12, sortOrder: 9,
        passiveEffect: { kind: 'xp_bonus', flatValue: 0.2 },
      } as never);
      expect(migrated.unlockLevel).toBe(12);
      expect(migrated.sortOrder).toBe(9);
    });
  });

  describe('getUnlockedSkillsForLevel', () => {
    it('Knight at level 1 has its Attack and first skill unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 1, CONTENT);
      expect(unlocked).toEqual(['knight_attack', 'knight_guard']);
    });

    it('Knight at level 5 has its Attack and first two skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 5, CONTENT);
      expect(unlocked).toEqual(['knight_attack', 'knight_guard', 'knight_bash']);
    });

    it('Knight at level 50 has all 12 skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 50, CONTENT);
      expect(unlocked).toHaveLength(12);
    });

    it('grant-only skills (unlockLevel null) are never included', () => {
      const grantOnly: SkillDefinition = {
        id: 'grant_only', name: 'Grant Only', description: 'd', className: 'Knight', type: 'passive',
        unlockLevel: null, sortOrder: 99,
        passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }],
      };
      const content: SkillContent = {
        skills: { ...SEED_SKILLS, grant_only: grantOnly },
        slotSchedules: SEED_SKILL_SLOT_SCHEDULES,
      };
      expect(getUnlockedSkillsForLevel('Knight', 100, content)).not.toContain('grant_only');
    });
  });

  describe('canEquipSkill', () => {
    it('allows equipping passive in passive slot', () => {
      expect(canEquipSkill('knight_guard', 0, 'Knight', 1, ['knight_guard'], [], CONTENT)).toBe(true);
    });

    it('rejects equipping passive in active slot', () => {
      expect(canEquipSkill('knight_guard', 1, 'Knight', 5, ['knight_guard'], [], CONTENT)).toBe(false);
    });

    it('rejects equipping active in passive slot', () => {
      expect(canEquipSkill('knight_bash', 0, 'Knight', 5, ['knight_guard', 'knight_bash'], [], CONTENT)).toBe(false);
    });

    it('allows equipping active in active slot at level 5+', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 5, ['knight_guard', 'knight_bash'], [], CONTENT)).toBe(true);
    });

    it('rejects equipping in slot not yet unlocked by level', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 4, ['knight_guard', 'knight_bash'], [], CONTENT)).toBe(false);
    });

    it('rejects equipping unobtained skill', () => {
      expect(canEquipSkill('knight_bash', 1, 'Knight', 5, ['knight_guard'], [], CONTENT)).toBe(false);
    });

    it('allows equipping a granted cross-class skill', () => {
      // A Knight granted the Bard's Rally can slot it into a passive slot.
      expect(canEquipSkill('bard_rally', 0, 'Knight', 1, [], ['bard_rally'], CONTENT)).toBe(true);
    });

    it('rejects a cross-class skill without a grant even when in unlockedSkills', () => {
      // unlockedSkills only covers the player's own class tree.
      expect(canEquipSkill('bard_rally', 0, 'Knight', 1, ['bard_rally'], [], CONTENT)).toBe(false);
    });
  });

  describe('equipSkillInSlot', () => {
    it('equips skill in slot', () => {
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null, null, null] };
      const result = equipSkillInSlot('knight_guard', 0, 'Knight', 1, loadout, [], CONTENT);
      expect(result).toEqual(['knight_guard', null, null, null, null]);
    });

    it('moves skill from one slot to another', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['knight_guard' as string | null, null, null, null, null],
      };
      // Equip into slot 2 (passive at level 10) — should unequip from slot 0
      const result = equipSkillInSlot('knight_guard', 2, 'Knight', 10, loadout, [], CONTENT);
      expect(result).toEqual([null, null, 'knight_guard', null, null]);
    });

    it('returns null for invalid equip', () => {
      const loadout = { unlockedSkills: ['knight_guard'], equippedSkills: [null, null, null, null, null] };
      const result = equipSkillInSlot('knight_guard', 1, 'Knight', 5, loadout, [], CONTENT);
      expect(result).toBeNull(); // passive in active slot
    });
  });

  describe('unequipSkillFromSlot', () => {
    it('clears the slot', () => {
      const result = unequipSkillFromSlot(0, ['knight_guard', null, null, null, null]);
      expect(result).toEqual([null, null, null, null, null]);
    });

    it('ignores out-of-range slot', () => {
      const equipped = ['knight_guard' as string | null, null, null, null, null];
      const result = unequipSkillFromSlot(7, equipped);
      expect(result).toEqual(equipped);
    });
  });

  describe('createDefaultSkillLoadout', () => {
    it('unlocks and equips first passive for Knight', () => {
      const loadout = createDefaultSkillLoadout('Knight', CONTENT);
      expect(loadout.unlockedSkills).toEqual(['knight_guard']);
      expect(loadout.equippedSkills).toEqual(['knight_guard', null, null, null, null]);
    });

    it('slot count follows the class schedule', () => {
      const content: SkillContent = {
        skills: SEED_SKILLS,
        slotSchedules: { Knight: [{ type: 'passive', unlocksAtLevel: 1 }, { type: 'active', unlocksAtLevel: 5 }] },
      };
      const loadout = createDefaultSkillLoadout('Knight', content);
      expect(loadout.equippedSkills).toEqual(['knight_guard', null]);
    });

    it('falls back to an all-null loadout when the class has no skills', () => {
      const content: SkillContent = { skills: {}, slotSchedules: SEED_SKILL_SLOT_SCHEDULES };
      const loadout = createDefaultSkillLoadout('Knight', content);
      expect(loadout.unlockedSkills).toEqual([]);
      expect(loadout.equippedSkills).toEqual([null, null, null, null, null]);
    });

    it('leaves everything unequipped when the class has no level-1 passive (agrees with reconcile)', () => {
      const content: SkillContent = {
        skills: { ...SEED_SKILLS, knight_guard: { ...SEED_SKILLS.knight_guard, unlockLevel: 10 } },
        slotSchedules: SEED_SKILL_SLOT_SCHEDULES,
      };
      const loadout = createDefaultSkillLoadout('Knight', content);
      expect(loadout.unlockedSkills).toEqual([]);
      expect(loadout.equippedSkills).toEqual([null, null, null, null, null]);
      // A level-1 character reconciling this loadout must not change it further.
      const reconciled = reconcileSkillLoadout(loadout, 'Knight', 1, [], content);
      expect(reconciled.equippedSkills).toEqual(loadout.equippedSkills);
    });
  });

  describe('reconcileSkillLoadout', () => {
    const fullLoadout = {
      unlockedSkills: HISTORICAL_SKILL_IDS.Knight,
      equippedSkills: ['knight_guard', 'knight_bash', 'knight_fortify', 'knight_iron_will', 'knight_tenacity'] as (string | null)[],
    };

    it('keeps a fully valid loadout unchanged', () => {
      const result = reconcileSkillLoadout(fullLoadout, 'Knight', 50, [], CONTENT);
      expect(result.equippedSkills).toEqual(fullLoadout.equippedSkills);
      expect(result.unlockedSkills).toEqual(fullLoadout.unlockedSkills);
    });

    it('truncates equippedSkills when the schedule shrinks', () => {
      const content: SkillContent = {
        skills: SEED_SKILLS,
        slotSchedules: { Knight: [{ type: 'passive', unlocksAtLevel: 1 }, { type: 'active', unlocksAtLevel: 5 }, { type: 'passive', unlocksAtLevel: 10 }] },
      };
      const result = reconcileSkillLoadout(fullLoadout, 'Knight', 50, [], content);
      expect(result.equippedSkills).toEqual(['knight_guard', 'knight_bash', 'knight_fortify']);
    });

    it('pads equippedSkills when the schedule grows', () => {
      const content: SkillContent = {
        skills: SEED_SKILLS,
        slotSchedules: {
          Knight: [...SEED_SKILL_SLOT_SCHEDULES.Knight, { type: 'passive', unlocksAtLevel: 60 }, { type: 'active', unlocksAtLevel: 70 }],
        },
      };
      const result = reconcileSkillLoadout(fullLoadout, 'Knight', 50, [], content);
      expect(result.equippedSkills).toEqual([...fullLoadout.equippedSkills, null, null]);
    });

    it('nulls entries whose skill type mismatches the slot type', () => {
      const loadout = {
        unlockedSkills: HISTORICAL_SKILL_IDS.Knight,
        equippedSkills: ['knight_bash', 'knight_guard', null, null, null] as (string | null)[], // active in passive slot + passive in active slot
      };
      const result = reconcileSkillLoadout(loadout, 'Knight', 50, [], CONTENT);
      expect(result.equippedSkills).toEqual([null, null, null, null, null]);
    });

    it('nulls an equipped granted skill once the grant is lost, keeps it while granted', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['bard_rally', null, null, null, null] as (string | null)[],
      };
      const kept = reconcileSkillLoadout(loadout, 'Knight', 1, ['bard_rally'], CONTENT);
      expect(kept.equippedSkills[0]).toBe('bard_rally');
      const lost = reconcileSkillLoadout(loadout, 'Knight', 1, [], CONTENT);
      expect(lost.equippedSkills[0]).toBeNull();
    });

    it('nulls entries whose skill is missing from content', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['deleted_skill', null, null, null, null] as (string | null)[],
      };
      const result = reconcileSkillLoadout(loadout, 'Knight', 50, [], CONTENT);
      expect(result.equippedSkills[0]).toBeNull();
    });

    it('nulls a class skill the player has not reached the unlock level for', () => {
      const loadout = {
        unlockedSkills: ['knight_guard', 'knight_war_cry'],
        equippedSkills: ['knight_war_cry', null, null, null, null] as (string | null)[],
      };
      const result = reconcileSkillLoadout(loadout, 'Knight', 10, [], CONTENT);
      expect(result.equippedSkills[0]).toBeNull();
    });

    it('nulls an equipped skill once its slot is raised above the player level, keeps it once level catches up', () => {
      const loadout = {
        unlockedSkills: ['knight_guard'],
        equippedSkills: ['knight_guard', null, null, null, null] as (string | null)[],
      };
      const raisedSchedule: SkillContent = {
        skills: SEED_SKILLS,
        slotSchedules: { Knight: [{ type: 'passive', unlocksAtLevel: 40 }, ...SEED_SKILL_SLOT_SCHEDULES.Knight.slice(1)] },
      };
      const underLevel = reconcileSkillLoadout(loadout, 'Knight', 10, [], raisedSchedule);
      expect(underLevel.equippedSkills[0]).toBeNull();
      const atLevel = reconcileSkillLoadout(loadout, 'Knight', 40, [], raisedSchedule);
      expect(atLevel.equippedSkills[0]).toBe('knight_guard');
    });

    it('every class default loadout survives reconcile unchanged at level 1', () => {
      for (const className of Object.keys(SEED_SKILL_SLOT_SCHEDULES) as ClassName[]) {
        const defaultLoadout = createDefaultSkillLoadout(className, CONTENT);
        const result = reconcileSkillLoadout(defaultLoadout, className, 1, [], CONTENT);
        expect(result.equippedSkills).toEqual(defaultLoadout.equippedSkills);
      }
    });
  });

  describe('getSkillById / getSkillsForClass', () => {
    it('finds knight_guard', () => {
      const skill = getSkillById('knight_guard', CONTENT);
      expect(skill).toBeDefined();
      expect(skill!.name).toBe('Guard');
      expect(skill!.className).toBe('Knight');
    });

    it('returns undefined for unknown id', () => {
      expect(getSkillById('nonexistent', CONTENT)).toBeUndefined();
    });

    it('getSkillsForClass returns the class tree sorted by sortOrder', () => {
      const skills = getSkillsForClass('Knight', CONTENT);
      expect(skills.map(s => s.id)).toEqual(['knight_attack', ...HISTORICAL_SKILL_IDS.Knight]);
    });
  });

  describe('SEED_SKILLS (structural invariants)', () => {
    it('has the 55 historical skills, ids preserved verbatim, and one Attack per class', () => {
      expect(Object.keys(SEED_SKILLS)).toHaveLength(60);
      for (const cn of ALL_CLASSES) {
        for (const id of HISTORICAL_SKILL_IDS[cn]) {
          expect(SEED_SKILLS[id], `missing seed skill ${id}`).toBeDefined();
          expect(SEED_SKILLS[id].className).toBe(cn);
        }
      }
    });

    it('every class has 6 passives, 5 actives and an Attack', () => {
      for (const cn of ALL_CLASSES) {
        const skills = getSkillsForClass(cn, CONTENT);
        expect(skills.filter(s => s.type === 'passive')).toHaveLength(6);
        expect(skills.filter(s => s.type === 'active')).toHaveLength(5);
        expect(skills.filter(s => s.type === 'attack')).toHaveLength(1);
      }
    });

    it('every class unlocks at levels 1 (twice), 5, 10, ..., 50', () => {
      for (const cn of ALL_CLASSES) {
        const levels = getSkillsForClass(cn, CONTENT).map(s => s.unlockLevel).sort((a, b) => (a ?? 0) - (b ?? 0));
        expect(levels).toEqual([1, 1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
      }
    });

    it('actives play on charge and recovery, instants on charge alone; no skill uses cooldown or the legacy singular fields', () => {
      for (const skill of Object.values(SEED_SKILLS)) {
        expect(skill.cooldown, skill.id).toBeUndefined();
        if (skill.type === 'active') {
          expect(typeof skill.charge, skill.id).toBe('number');
          expect(typeof skill.recovery, skill.id).toBe(getSkillTrigger(skill) ? 'undefined' : 'number');
          expect(skill.activeEffects?.length).toBeGreaterThanOrEqual(1);
        } else if (skill.type === 'passive') {
          expect(skill.charge, skill.id).toBeUndefined();
          expect(skill.recovery, skill.id).toBeUndefined();
          expect(skill.passiveEffects?.length).toBeGreaterThanOrEqual(1);
        }
        expect((skill as Record<string, unknown>).passiveEffect).toBeUndefined();
        expect((skill as Record<string, unknown>).activeEffect).toBeUndefined();
        expect((skill as Record<string, unknown>).treeOrder).toBeUndefined();
      }
    });

    it('passes content validation, with every class in one world', () => {
      for (const skill of Object.values(SEED_SKILLS)) {
        expect(validateSkillDefinition(skill, CONTENT), skill.id).toEqual([]);
      }
    });

    it('every Attack comes first, at level 1, and keeps the class\'s current action gap', () => {
      const expected = { Knight: [3.6, 0], Archer: [0.4, 1.6], Priest: [1.4, 0.4], Mage: [2, 0.5], Bard: [1.8, 0.7] };
      for (const cn of ALL_CLASSES) {
        const attack = SEED_SKILLS[`${cn.toLowerCase()}_attack`];
        expect(getSkillsForClass(cn, CONTENT)[0].id).toBe(attack.id);
        expect(attack).toMatchObject({ name: 'Attack', type: 'attack', className: cn, unlockLevel: 1, charge: expected[cn][0], recovery: expected[cn][1] });
        expect(attack.activeEffects).toBeUndefined();
        expect(attack.passiveEffects).toBeUndefined();
        expect(attack.charge! + attack.recovery!).toBeCloseTo(COMBAT_PACE.classSeconds[cn]!);
      }
    });

    it('a fresh character starts on its passive and keeps the 5-slot schedule, with Attack in no slot', () => {
      for (const cn of ALL_CLASSES) {
        const loadout = createDefaultSkillLoadout(cn, CONTENT);
        expect(loadout.equippedSkills).toHaveLength(5);
        expect(loadout.equippedSkills.filter(Boolean)).toHaveLength(1);
        expect(loadout.equippedSkills[0]).toBe(HISTORICAL_SKILL_IDS[cn][0]);
        for (let slot = 0; slot < 5; slot++) {
          expect(canEquipSkill(`${cn.toLowerCase()}_attack`, slot, cn, 50, getUnlockedSkillsForLevel(cn, 50, CONTENT), [], CONTENT)).toBe(false);
        }
      }
    });

    it('every seed option kind exists in SKILL_OPTION_CATALOG with the right slot type', () => {
      for (const skill of Object.values(SEED_SKILLS)) {
        for (const effect of skill.passiveEffects ?? []) {
          expect(SKILL_OPTION_CATALOG[effect.kind], `missing catalog entry ${effect.kind}`).toBeDefined();
          expect(SKILL_OPTION_CATALOG[effect.kind].slotType).toBe('passive');
        }
        for (const effect of skill.activeEffects ?? []) {
          expect(SKILL_OPTION_CATALOG[effect.kind], `missing catalog entry ${effect.kind}`).toBeDefined();
          expect(SKILL_OPTION_CATALOG[effect.kind].slotType).toBe('active');
        }
      }
    });
  });
});

describe('skill cards and triggers', () => {
  const active = (overrides: Partial<SkillDefinition>): SkillDefinition => ({
    id: 'x', name: 'X', description: 'd', className: 'Knight', type: 'active', unlockLevel: 1, sortOrder: 1, cooldown: 1,
    activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }], ...overrides,
  });
  const passive = (overrides: Partial<SkillDefinition>): SkillDefinition => ({
    id: 'y', name: 'Y', description: 'd', className: 'Knight', type: 'passive', unlockLevel: 1, sortOrder: 0, ...overrides,
  });

  it('lists every trigger with a label and description', () => {
    expect([...SKILL_TRIGGER_VALUES]).toEqual(['ally_targeted', 'self_hit', 'enemy_cast', 'ally_afflicted', 'ally_low_hp']);
    for (const t of SKILL_TRIGGER_VALUES) {
      expect(SKILL_TRIGGER_INFO[t].label.trim()).not.toBe('');
      expect(SKILL_TRIGGER_INFO[t].description.trim()).not.toBe('');
    }
  });

  it('has the spec card labels, icons and blurbs', () => {
    expect(SKILL_CARD_TYPE_INFO).toEqual({
      basic: { label: 'Basic attack', icon: '🗡️', blurb: 'Always in use, whenever nothing above it is ready' },
      action: { label: 'Action', icon: '⚔️', blurb: 'Uses your turn when ready, once it would do something' },
      instant: { label: 'Instant', icon: '⚡', blurb: 'Fires on its own when something happens' },
      passive: { label: 'Passive', icon: '◆', blurb: 'Always on' },
    });
  });

  it('infers triggers for authored Intercept/Shield Slam skills that carry none', () => {
    expect(getSkillTrigger(active({ activeEffects: [{ kind: 'redirect_hit' }] }))).toBe('ally_targeted');
    expect(getSkillTrigger(active({ activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }] }))).toBe('self_hit');
    expect(getSkillTrigger(active({}))).toBeUndefined();
    expect(getSkillTrigger(active({ trigger: 'ally_low_hp', activeEffects: [{ kind: 'redirect_hit' }] }))).toBe('ally_low_hp');
    expect(getSkillTrigger(passive({ trigger: 'self_hit', passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }] }))).toBeUndefined();
  });

  it('derives the card type (first match wins)', () => {
    expect(getSkillCardType(passive({ passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }] }))).toBe('passive');
    expect(getSkillCardType(passive({ passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }, { kind: 'overflow' }] }))).toBe('instant');
    expect(getSkillCardType(active({ trigger: 'enemy_cast', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] }))).toBe('instant');
    expect(getSkillCardType(active({ trigger: 'ally_low_hp', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] }))).toBe('instant');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'redirect_hit' }] }))).toBe('instant');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'shield_non_knight', shieldMultiplier: 2 }] }))).toBe('action');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'damage_percent', damagePercent: 1 }] }))).toBe('action');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }, { kind: 'chaos' }] }))).toBe('action');
    expect(getSkillCardType(active({ activeEffects: [] }))).toBe('action');
  });

  it('seed skills follow the card table', () => {
    const expected: Record<string, [string, number, number | undefined, { castTime?: number; warmup?: number; trigger?: string }?]> = {
      knight_bash: ['action', 6.3, 0.9],
      knight_intercept: ['instant', 1.8, undefined, { trigger: 'ally_targeted' }],
      knight_shield_slam: ['instant', 1.8, undefined, { trigger: 'self_hit' }],
      knight_sunder: ['action', 9, 0.9, { warmup: 1.8 }],
      knight_dispel: ['instant', 9.9, undefined, { trigger: 'enemy_cast' }],
      archer_cut_down: ['action', 4.4, 1.6],
      archer_triple_shot: ['action', 6.4, 1.6],
      archer_snipe: ['action', 8, 2, { castTime: 1 }],
      archer_bleed: ['action', 4.4, 1.6],
      archer_crippling_shot: ['action', 4.4, 1.6],
      priest_minor_heal: ['action', 0.9, 0.9],
      priest_smite: ['action', 2.7, 0.9],
      priest_cure: ['instant', 5.4, undefined, { trigger: 'ally_afflicted' }],
      priest_mending: ['instant', 7.2, undefined, { trigger: 'ally_low_hp' }],
      priest_sanctuary: ['action', 0.9, 0.9],
      mage_magic_missile: ['action', 7, 0.5],
      mage_zap: ['action', 2, 0.5],
      mage_chain_lightning: ['action', 2, 0.5],
      mage_blizzard: ['action', 14, 1, { castTime: 1.5 }],
      mage_arcane_blast: ['action', 11.5, 1, { castTime: 1 }],
      bard_dissonance: ['action', 6.8, 0.7],
      bard_drumroll: ['instant', 7.2, undefined, { trigger: 'enemy_cast' }],
      bard_war_song: ['action', 9.3, 0.7, { warmup: 0 }],
      bard_lullaby: ['action', 11.8, 0.7],
      bard_chaos: ['action', 14.3, 0.7],
    };
    const actives = Object.values(SEED_SKILLS).filter(s => s.type === 'active').map(s => s.id).sort();
    expect(actives).toEqual(Object.keys(expected).sort());
    for (const [id, [cardType, charge, recovery, timing]] of Object.entries(expected)) {
      const skill = SEED_SKILLS[id];
      expect(getSkillCardType(skill), id).toBe(cardType);
      expect(skill.charge, id).toBe(charge);
      expect(skill.recovery, id).toBe(recovery);
      expect(skill.castTime, id).toBe(timing?.castTime);
      expect(skill.warmup, id).toBe(timing?.warmup);
      expect(skill.trigger, id).toBe(timing?.trigger);
    }
    expect(SEED_SKILLS.archer_bleed.activeEffects![0]).toMatchObject({ dotTicks: 3 });
    expect(SEED_SKILLS.archer_crippling_shot.activeEffects![0]).toMatchObject({ debuffPercent: 0.3, debuffDuration: 3 });
    expect(SEED_SKILLS.bard_lullaby.activeEffects![0]).toMatchObject({ debuffDuration: 3 });
    expect(SEED_SKILLS.priest_mending.description).toBe(`When an ally drops below half health, heal them for level × 2 HP every ${COMBAT_PACE.clock} seconds for ${3 * COMBAT_PACE.clock} seconds.`);
  });

  it('seed passives with an event hook are Instant cards, and stay passive with no charge', () => {
    const instants = Object.values(SEED_SKILLS).filter(s => s.type === 'passive' && getSkillCardType(s) === 'instant');
    for (const skill of instants) {
      expect(skill.charge, skill.id).toBeUndefined();
      expect(skill.recovery, skill.id).toBeUndefined();
    }
    expect(instants.map(s => s.id).sort()).toEqual([
      'archer_focus', 'knight_shield_bash', 'mage_arcane_surge', 'mage_ignite', 'mage_overflow', 'mage_scorch',
      'priest_martyr', 'priest_resurrection',
    ]);
  });

  it('seed descriptions use seconds, not turns or rounds', () => {
    for (const skill of Object.values(SEED_SKILLS)) {
      expect(skill.description, skill.id).not.toMatch(/\bturns?\b|\brounds?\b|\bticks?\b/i);
    }
    const { clock } = COMBAT_PACE;
    for (const id of ['bard_tempo', 'bard_encore']) {
      expect(SEED_SKILLS[id].description, id).toContain(`charge ${clock} s faster`);
      expect(SEED_SKILLS[id].description, id).toContain(`at least a ${MIN_COOLDOWN_MS / 1000 * clock} s cycle`);
      expect(SEED_SKILLS[id].description, id).toContain('Attack, recovery and skills that counter enemy spells are unaffected.');
    }
    expect(SEED_SKILLS.mage_scorch.description).toContain(`for ${ownSeconds(SEED_SKILLS.mage_scorch, SCORCH_MS / 1000)} s`);
    expect(SEED_SKILLS.knight_shield_bash.description).toContain(`stun the attacker for ${clock} seconds`);
  });

  it('seed cards leave how often they come round to the charge and recovery they show', () => {
    for (const skill of Object.values(SEED_SKILLS)) {
      if (skill.type === 'passive') continue;
      expect(skill.description, skill.id).not.toMatch(/\bcooldown\b|^[\w ]+, (about )?every \d/i);
      const cadenceWords = skill.description.match(/\bevery [\d.]+ seconds?\b/g) ?? [];
      expect(cadenceWords, skill.id).toEqual(skill.id === 'priest_mending' ? [`every ${COMBAT_PACE.clock} seconds`] : []);
    }
  });

  it('seed cards state what an action does at its class pace', () => {
    const { clock } = COMBAT_PACE;
    const kit = (className: ClassName) => paceKit(COMBAT_PACE, className);
    const percent = (fraction: number) => Math.round(fraction * 100);
    const first = (id: string) => SEED_SKILLS[id].activeEffects![0];

    expect(SEED_SKILLS.knight_bash.description).toContain(`with a ${percent(Math.min(1, first('knight_bash').stunChance! * kit('Knight')))}% chance to stun it for ${clock} seconds`);
    const mark = first('knight_sunder').markMultiplier!;
    expect(SEED_SKILLS.knight_sunder.description).toContain(`take ${percent(mark * kit('Knight'))}% increased damage from attacks (up to ${percent(mark * SUNDER_MAX_STACKS)}%, on a second use)`);
    expect(SEED_SKILLS.archer_snipe.description).toContain(`Take aim for ${ownSeconds(SEED_SKILLS.archer_snipe, SEED_SKILLS.archer_snipe.castTime!)} seconds`);
    expect(SEED_SKILLS.archer_bleed.description).toContain(`over ${cardSeconds(first('archer_bleed').dotTicks! * clock)} seconds`);
    expect(SEED_SKILLS.archer_crippling_shot.description).toContain(`by 30% for ${ownSeconds(SEED_SKILLS.archer_crippling_shot, first('archer_crippling_shot').debuffDuration!)} seconds`);
    expect(SEED_SKILLS.mage_blizzard.description).toContain(`Channel for ${ownSeconds(SEED_SKILLS.mage_blizzard, SEED_SKILLS.mage_blizzard.castTime!)} seconds`);
    expect(SEED_SKILLS.mage_arcane_blast.description).toContain(`Channel for ${ownSeconds(SEED_SKILLS.mage_arcane_blast, SEED_SKILLS.mage_arcane_blast.castTime!)} seconds`);
    expect(SEED_SKILLS.bard_lullaby.description).toContain(`less damage for ${ownSeconds(SEED_SKILLS.bard_lullaby, first('bard_lullaby').debuffDuration!)} seconds`);
    expect(SEED_SKILLS.bard_drumroll.description).toContain(`a ${percent(first('bard_drumroll').stunChance!)}% chance to stun each enemy for ${clock} seconds`);
    const song = first('bard_war_song').buffPercent!;
    expect(SEED_SKILLS.bard_war_song.description).toContain(`by ${percent(song * kit('Bard'))}% for the rest of combat (stacks up to ${percent(song * WAR_SONG_MAX_STACKS)}%)`);
    const dissonance = Math.round(first('bard_dissonance').damagePerLevel! * kit('Bard') * 100) / 100;
    expect(SEED_SKILLS.bard_dissonance.description).toContain(`Deal ${dissonance} damage per level, rounded down`);
  });

  it('seed passives state what they add at the pace of the hits they ride on', () => {
    const kits = ALL_CLASSES.map(className => paceKit(COMBAT_PACE, className));
    const mageKit = paceKit(COMBAT_PACE, 'Mage');
    const burn = SEED_SKILLS.mage_burn.passiveEffects![0].valuePerLevel!;
    expect(SEED_SKILLS.mage_burn.description).toContain(`+${Math.round(burn * mageKit * 10) / 10} magical damage per level`);
    expect(SEED_SKILLS.mage_ignite.description).toContain(`Stacks up to ${Math.round(IGNITE_MAX_STACKS / mageKit)} times`);
    const arms = SEED_SKILLS.priest_blessed_arms.passiveEffects![0].valuePerLevel!;
    expect(SEED_SKILLS.priest_blessed_arms.description).toContain(`+${arms * Math.min(...kits)} to +${arms * Math.max(...kits)} holy damage per Priest level, by class`);
  });
});
