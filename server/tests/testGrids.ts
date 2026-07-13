import { DEFAULT_MAP_ID, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '@idle-party-rpg/shared';
import type { HexGrid, SkillSlot } from '@idle-party-rpg/shared';
import type { WorldGrids } from '../src/game/WorldGrids.js';

/**
 * Wrap a single pre-built HexGrid as a WorldGrids exposing it as the default
 * ('overworld') map — lets tests keep building a HexGrid directly while feeding
 * the multi-map registry the production code now expects.
 */
export function wrapGrids(grid: HexGrid): WorldGrids {
  return {
    get: (id: string) => (id === DEFAULT_MAP_ID ? grid : undefined),
    getOrThrow: (id: string) => {
      if (id !== DEFAULT_MAP_ID) throw new Error(`No grid for map "${id}"`);
      return grid;
    },
    has: (id: string) => id === DEFAULT_MAP_ID,
    mapIds: () => [DEFAULT_MAP_ID],
    totalSize: () => grid.size,
    rebuild: () => {},
  } as unknown as WorldGrids;
}

/** A default-map `maps` registry + defaultMapId for fake getWorld() implementations. */
export function fakeWorldMeta(startTile = { col: 0, row: 0 }) {
  return {
    defaultMapId: DEFAULT_MAP_ID,
    maps: [{ id: DEFAULT_MAP_ID, name: 'Overworld', startTile }],
  };
}

/** Seed-backed skill content accessors — spread into fake ContentStore objects. */
export function fakeSkillContent() {
  return {
    getSkill: (id: string) => SEED_SKILLS[id],
    getAllSkills: () => SEED_SKILLS,
    getSkillSlotSchedule: (className: string) => (SEED_SKILL_SLOT_SCHEDULES as Record<string, SkillSlot[]>)[className],
    getAllSkillSlotSchedules: () => SEED_SKILL_SLOT_SCHEDULES as Record<string, SkillSlot[]>,
  };
}
