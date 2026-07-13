import { describe, it, expect } from 'vitest';
import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import type { ItemDefinition, SkillDefinition, SkillSlot } from '@idle-party-rpg/shared';
import { PlayerSession } from '../src/game/PlayerSession.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import { wrapGrids, fakeWorldMeta } from './testGrids.js';

// Content-driven schedule: both slots usable at level 1 so the tests don't need level grinding.
const KNIGHT_SCHEDULE: SkillSlot[] = [
  { type: 'passive', unlocksAtLevel: 1 },
  { type: 'active', unlocksAtLevel: 1 },
];

function makeSkills(): Record<string, SkillDefinition> {
  return {
    knight_guard: {
      id: 'knight_guard', name: 'Guard', description: '', className: 'Knight', type: 'passive',
      unlockLevel: 1, sortOrder: 0, passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 2 }],
    },
    knight_bash: {
      id: 'knight_bash', name: 'Bash', description: '', className: 'Knight', type: 'active',
      unlockLevel: 3, sortOrder: 1, cooldown: 3, activeEffects: [{ kind: 'stun_single', stunChance: 0.2 }],
    },
    mage_zap: {
      id: 'mage_zap', name: 'Zap', description: '', className: 'Mage', type: 'active',
      unlockLevel: 1, sortOrder: 0, cooldown: 3, activeEffects: [{ kind: 'damage_percent', damagePercent: 1.3 }],
    },
  };
}

function makeContentStore(skills: Record<string, SkillDefinition>, items: Record<string, ItemDefinition>): ContentStore {
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getWorld: () => ({ tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getItem: (id: string) => items[id],
    getAllItems: () => items,
    getAllSets: () => ({}),
    getAllZones: () => ({}),
    getAllQuests: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllMonsters: () => ({}),
    getMonster: () => undefined,
    getNpc: () => undefined,
    getAllNpcs: () => ({}),
    getShop: () => undefined,
    getAllShops: () => ({}),
    getSkill: (id: string) => skills[id],
    getAllSkills: () => skills,
    getSkillSlotSchedule: (className: string) => (className === 'Knight' ? KNIGHT_SCHEDULE : undefined),
    getAllSkillSlotSchedules: () => ({ Knight: KNIGHT_SCHEDULE }),
  } as unknown as ContentStore;
}

function makeGrid(): HexGrid {
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'plains', 'zone', 'tile-start'));
  return grid;
}

function makeSession(
  skills: Record<string, SkillDefinition> = makeSkills(),
  items: Record<string, ItemDefinition> = {},
): PlayerSession {
  const session = new PlayerSession('alice', wrapGrids(makeGrid()), makeContentStore(skills, items));
  session.setClass('Knight');
  return session;
}

/** Reach into the session's private character to adjust the level (test-only). */
function setLevel(session: PlayerSession, level: number): void {
  (session as unknown as { character: { level: number } }).character.level = level;
}

const RING: ItemDefinition = {
  id: 'magic_ring', name: 'Magic Ring', rarity: 'rare', equipSlot: 'ring', value: 1,
  grantedSkillIds: ['mage_zap'],
};

describe('PlayerSession skill loadout (content-driven)', () => {
  it('builds the default loadout from the content schedule on class select', () => {
    const session = makeSession();
    const loadout = session.getSkillLoadout()!;
    expect(loadout.unlockedSkills).toEqual(['knight_guard']);
    expect(loadout.equippedSkills).toEqual(['knight_guard', null]);
  });

  it('rejects equipping a cross-class skill without a grant', () => {
    const session = makeSession(makeSkills(), { magic_ring: RING });
    expect(session.handleEquipSkill('mage_zap', 1)).toBe(false);
  });

  it('makes an item-granted skill equippable and nulls its slot when the item is unequipped', () => {
    const session = makeSession(makeSkills(), { magic_ring: RING });

    session.addToInventory('magic_ring', 1);
    expect(session.handleEquipItem('magic_ring')).toBe(true);
    expect(session.getGrantedSkillIds()).toEqual(['mage_zap']);

    // Grant makes the cross-class skill equippable into a matching slot
    expect(session.handleEquipSkill('mage_zap', 1)).toBe(true);
    expect(session.getSkillLoadout()!.equippedSkills[1]).toBe('mage_zap');

    // Combat resolves the equipped skill from content (no grant auto-append)
    const combatInfo = session.getCombatInfo();
    expect(combatInfo.equippedSkills[1]?.id).toBe('mage_zap');

    // State exposes the granted ids (required client field)
    expect(session.getState([]).character?.grantedSkillIds).toEqual(['mage_zap']);

    // Losing the grant reconciles the loadout: the slot is nulled
    expect(session.handleUnequipItem('ring').success).toBe(true);
    expect(session.getGrantedSkillIds()).toEqual([]);
    expect(session.getSkillLoadout()!.equippedSkills[1]).toBeNull();
    expect(session.getState([]).character?.grantedSkillIds).toEqual([]);
  });

  it('autoUnlockSkills respects an edited unlockLevel and clears newly-locked equipped skills', () => {
    const skills = makeSkills();
    const session = makeSession(skills);

    // Level 1: bash (unlockLevel 3) is not learned
    session.autoUnlockSkills();
    expect(session.getSkillLoadout()!.unlockedSkills).toEqual(['knight_guard']);

    // Level 3: bash unlocks and can be equipped
    setLevel(session, 3);
    session.autoUnlockSkills();
    expect(session.getSkillLoadout()!.unlockedSkills).toContain('knight_bash');
    expect(session.handleEquipSkill('knight_bash', 1)).toBe(true);

    // Content edit raises the unlock level above the player: skill un-learns and its slot clears
    skills['knight_bash'].unlockLevel = 5;
    session.autoUnlockSkills();
    expect(session.getSkillLoadout()!.unlockedSkills).not.toContain('knight_bash');
    expect(session.getSkillLoadout()!.equippedSkills[1]).toBeNull();
  });

  it('reconciles away skills that were removed from content', () => {
    const skills = makeSkills();
    const session = makeSession(skills);
    expect(session.getSkillLoadout()!.equippedSkills[0]).toBe('knight_guard');

    delete skills['knight_guard'];
    session.autoUnlockSkills();
    expect(session.getSkillLoadout()!.unlockedSkills).toEqual([]);
    expect(session.getSkillLoadout()!.equippedSkills[0]).toBeNull();
  });
});
