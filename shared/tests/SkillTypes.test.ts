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

const CONTENT: SkillContent = { skills: SEED_SKILLS, slotSchedules: SEED_SKILL_SLOT_SCHEDULES };

const ALL_CLASSES = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'] as const;

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
    it('Knight at level 1 has only the first skill unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 1, CONTENT);
      expect(unlocked).toEqual(['knight_guard']);
    });

    it('Knight at level 5 has first two skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 5, CONTENT);
      expect(unlocked).toEqual(['knight_guard', 'knight_bash']);
    });

    it('Knight at level 50 has all 11 skills unlocked', () => {
      const unlocked = getUnlockedSkillsForLevel('Knight', 50, CONTENT);
      expect(unlocked).toHaveLength(11);
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
      expect(skills.map(s => s.id)).toEqual(HISTORICAL_SKILL_IDS.Knight);
    });
  });

  describe('SEED_SKILLS (structural invariants)', () => {
    it('has exactly 55 skills with the historical ids preserved verbatim', () => {
      expect(Object.keys(SEED_SKILLS)).toHaveLength(55);
      for (const cn of ALL_CLASSES) {
        for (const id of HISTORICAL_SKILL_IDS[cn]) {
          expect(SEED_SKILLS[id], `missing seed skill ${id}`).toBeDefined();
          expect(SEED_SKILLS[id].className).toBe(cn);
        }
      }
    });

    it('every class has 6 passives and 5 actives', () => {
      for (const cn of ALL_CLASSES) {
        const skills = getSkillsForClass(cn, CONTENT);
        expect(skills.filter(s => s.type === 'passive')).toHaveLength(6);
        expect(skills.filter(s => s.type === 'active')).toHaveLength(5);
      }
    });

    it('every class unlocks at levels 1, 5, 10, ..., 50', () => {
      for (const cn of ALL_CLASSES) {
        const levels = getSkillsForClass(cn, CONTENT).map(s => s.unlockLevel).sort((a, b) => (a ?? 0) - (b ?? 0));
        expect(levels).toEqual([1, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50]);
      }
    });

    it('actives all have cooldown >= 1; no skill uses the legacy singular fields', () => {
      for (const skill of Object.values(SEED_SKILLS)) {
        if (skill.type === 'active') {
          expect(skill.cooldown).toBeGreaterThanOrEqual(1);
          expect(skill.activeEffects?.length).toBeGreaterThanOrEqual(1);
        } else {
          expect(skill.passiveEffects?.length).toBeGreaterThanOrEqual(1);
        }
        expect((skill as Record<string, unknown>).passiveEffect).toBeUndefined();
        expect((skill as Record<string, unknown>).activeEffect).toBeUndefined();
        expect((skill as Record<string, unknown>).treeOrder).toBeUndefined();
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
      attack: { label: 'Attack', icon: '⚔️', blurb: 'Uses your action when ready' },
      support: { label: 'Support', icon: '✚', blurb: 'Held until someone needs it' },
      enchantment: { label: 'Enchantment', icon: '✨', blurb: 'Lingering effect' },
      instant: { label: 'Instant', icon: '⚡', blurb: 'Fires off-turn when its trigger happens' },
      interrupt: { label: 'Interrupt', icon: '✋', blurb: 'Counters an enemy spell' },
      passive: { label: 'Passive', icon: '◆', blurb: 'Always on' },
      triggered: { label: 'Triggered', icon: '↯', blurb: 'Passive that fires on an event' },
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
    expect(getSkillCardType(passive({ passiveEffects: [{ kind: 'crit_chance', flatValue: 0.1 }, { kind: 'overflow' }] }))).toBe('triggered');
    expect(getSkillCardType(active({ trigger: 'enemy_cast', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] }))).toBe('interrupt');
    expect(getSkillCardType(active({ trigger: 'ally_low_hp', activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }] }))).toBe('instant');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'redirect_hit' }] }))).toBe('instant');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'shield_non_knight', shieldMultiplier: 2 }] }))).toBe('support');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'heal_lowest', healMultiplier: 4 }, { kind: 'damage_percent', damagePercent: 1 }] }))).toBe('attack');
    expect(getSkillCardType(active({ activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }, { kind: 'chaos' }] }))).toBe('enchantment');
    expect(getSkillCardType(active({ activeEffects: [] }))).toBe('attack');
  });

  it('seed skills follow the card table', () => {
    const expected: Record<string, [string, number, { castTime?: number; warmup?: number; trigger?: string }?]> = {
      knight_bash: ['attack', 2],
      knight_intercept: ['instant', 2, { trigger: 'ally_targeted' }],
      knight_shield_slam: ['instant', 1, { trigger: 'self_hit' }],
      knight_sunder: ['attack', 3, { warmup: 1 }],
      knight_dispel: ['interrupt', 5, { trigger: 'enemy_cast' }],
      archer_cut_down: ['attack', 3],
      archer_triple_shot: ['attack', 4],
      archer_snipe: ['attack', 5, { castTime: 1 }],
      archer_bleed: ['attack', 3],
      archer_crippling_shot: ['attack', 3],
      priest_minor_heal: ['support', 1],
      priest_smite: ['attack', 2],
      priest_cure: ['instant', 3, { trigger: 'ally_afflicted' }],
      priest_mending: ['instant', 4, { trigger: 'ally_low_hp' }],
      priest_sanctuary: ['support', 1],
      mage_magic_missile: ['attack', 3],
      mage_zap: ['attack', 1],
      mage_chain_lightning: ['attack', 1],
      mage_blizzard: ['attack', 6, { castTime: 1.5 }],
      mage_arcane_blast: ['attack', 5, { castTime: 1 }],
      bard_dissonance: ['attack', 3],
      bard_drumroll: ['interrupt', 4, { trigger: 'enemy_cast' }],
      bard_war_song: ['enchantment', 4, { warmup: 0 }],
      bard_lullaby: ['enchantment', 5],
      bard_chaos: ['enchantment', 6],
    };
    const actives = Object.values(SEED_SKILLS).filter(s => s.type === 'active').map(s => s.id).sort();
    expect(actives).toEqual(Object.keys(expected).sort());
    for (const [id, [cardType, cooldown, timing]] of Object.entries(expected)) {
      const skill = SEED_SKILLS[id];
      expect(getSkillCardType(skill), id).toBe(cardType);
      expect(skill.cooldown, id).toBe(cooldown);
      expect(skill.castTime, id).toBe(timing?.castTime);
      expect(skill.warmup, id).toBe(timing?.warmup);
      expect(skill.trigger, id).toBe(timing?.trigger);
    }
    expect(SEED_SKILLS.archer_bleed.activeEffects![0]).toMatchObject({ dotTicks: 3 });
    expect(SEED_SKILLS.archer_crippling_shot.activeEffects![0]).toMatchObject({ debuffPercent: 0.3, debuffDuration: 3 });
    expect(SEED_SKILLS.bard_lullaby.activeEffects![0]).toMatchObject({ debuffDuration: 3 });
    expect(SEED_SKILLS.priest_mending.description).toBe('When an ally drops below half health, heal them for level × 2 HP each second for 3 seconds.');
  });

  it('seed passives with an event hook are triggered cards', () => {
    const triggered = Object.values(SEED_SKILLS).filter(s => getSkillCardType(s) === 'triggered').map(s => s.id).sort();
    expect(triggered).toEqual([
      'archer_focus', 'knight_shield_bash', 'mage_arcane_surge', 'mage_ignite', 'mage_overflow', 'mage_scorch',
      'priest_martyr', 'priest_resurrection',
    ]);
  });

  it('seed descriptions use seconds, not turns or rounds', () => {
    for (const skill of Object.values(SEED_SKILLS)) {
      expect(skill.description, skill.id).not.toMatch(/\bturns?\b|\brounds?\b|\bticks?\b/i);
    }
    expect(SEED_SKILLS.bard_tempo.description).toContain('1 s');
    expect(SEED_SKILLS.bard_encore.description).toContain('1 s');
    expect(SEED_SKILLS.mage_scorch.description).toContain('2 s');
    expect(SEED_SKILLS.knight_shield_bash.description).toContain('1 second');
  });
});
