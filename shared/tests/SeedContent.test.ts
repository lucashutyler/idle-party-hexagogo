import { describe, it, expect, afterEach, vi } from 'vitest';
import { SEED_ENCOUNTERS, resolveEncounter } from '../src/systems/EncounterTypes';
import { SEED_MONSTERS } from '../src/systems/MonsterTypes';
import type { MonsterTier } from '../src/systems/MonsterTypes';
import { SEED_ITEMS } from '../src/systems/ItemTypes';
import { SEED_DUNGEONS } from '../src/systems/DungeonTypes';
import { MONSTER_SKILL_CATALOG } from '../src/systems/MonsterSkills';
import { effectiveMonsterLevel, effectiveMonsterTier } from '../src/systems/MonsterLevels';
import { suggestMonsterStats } from '../src/systems/MonsterTemplates';
import { DEV_MIXED_ENCOUNTER_ID, DEV_RAID_DUNGEON_ID, DEV_SEED_VERSION, generateDevWorld } from '../src/seed/SeedDevWorld';

afterEach(() => { vi.restoreAllMocks(); });

describe('seed encounters', () => {
  it('mix the new casters into Darkwood and the Crystal Caves (Hatchetmill untouched)', () => {
    expect(SEED_ENCOUNTERS.darkwood_goblins.monsterPool).toContainEqual({ monsterId: 'goblin_shaman', min: 0, max: 1 });
    expect(SEED_ENCOUNTERS.darkwood_bandits.monsterPool).toContainEqual({ monsterId: 'bandit_cutthroat', min: 0, max: 1 });
    expect(SEED_ENCOUNTERS.crystal_caves_goblins.monsterPool).toContainEqual({ monsterId: 'goblin_shaman', min: 0, max: 1 });
    expect(SEED_ENCOUNTERS.hatchetmill_goblins.monsterPool).toEqual([{ monsterId: 'goblin', min: 1, max: 2 }]);
  });

  it('only reference seed monsters, whose drops are seed items', () => {
    for (const encounter of Object.values(SEED_ENCOUNTERS)) {
      for (const id of [...(encounter.monsterPool ?? []), ...(encounter.placements ?? [])].map(e => e.monsterId)) {
        expect(SEED_MONSTERS[id], `${encounter.id} → ${id}`).toBeDefined();
      }
    }
    for (const monster of Object.values(SEED_MONSTERS)) {
      for (const drop of monster.drops ?? []) {
        expect(SEED_ITEMS[drop.itemId], `${monster.id} drop ${drop.itemId}`).toBeDefined();
      }
    }
  });

  it('can roll a shaman into a Darkwood goblin pack', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.99);
    const ids = resolveEncounter(SEED_ENCOUNTERS.darkwood_goblins, SEED_MONSTERS).map(m => m.id);
    expect(ids).toContain('goblin_shaman');
    expect(ids.filter(id => id === 'goblin').length).toBeGreaterThanOrEqual(2);
  });
});

describe('seed levels, tiers and the Chieftain', () => {
  it('authors a level and tier on every seed monster', () => {
    const expected: Record<string, [number, MonsterTier]> = {
      goblin: [1, 'trash'], goblin_shaman: [2, 'trash'], wolf: [3, 'trash'], bandit: [4, 'trash'],
      bandit_cutthroat: [5, 'elite'], stone_wall: [1, 'trash'], goblin_chieftain: [6, 'boss'],
    };
    expect(Object.keys(SEED_MONSTERS).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, [level, tier]] of Object.entries(expected)) {
      expect(effectiveMonsterLevel(SEED_MONSTERS[id]), id).toEqual({ level, source: 'authored' });
      expect(effectiveMonsterTier(SEED_MONSTERS[id]), id).toBe(tier);
    }
  });

  it('gives the Chieftain catalog skills and an 8-minute enrage', () => {
    const chief = SEED_MONSTERS.goblin_chieftain;
    for (const s of chief.skills ?? []) expect(MONSTER_SKILL_CATALOG[s.skillId], s.skillId).toBeDefined();
    expect(chief.enrage).toEqual({ afterSeconds: 480 });
  });

  it('ends the seed dungeon on an explicit Chieftain floor', () => {
    const floors = SEED_DUNGEONS.crystal_caves_trial.floors;
    const boss = floors[floors.length - 1];
    expect(boss.isBoss).toBe(true);
    expect(boss.encounterTable).toEqual([{ encounterId: 'goblin_chieftain_court', weight: 1 }]);
    const court = SEED_ENCOUNTERS.goblin_chieftain_court;
    expect(court.type).toBe('explicit');
    expect(court.placements!.map(p => p.monsterId).sort()).toEqual(['goblin', 'goblin', 'goblin_chieftain']);
    expect(new Set(court.placements!.map(p => p.gridPosition)).size).toBe(3);
  });
});

describe('dev world seed', () => {
  const world = generateDevWorld();
  const monsters = new Map(world.monsters.map(m => [m.id, m]));
  const encounters = new Map(world.encounters.map(e => [e.id, e]));
  const themed = world.zones.filter(z => z.encounterTable.length > 0);

  it('bumps the seed version', () => {
    expect(DEV_SEED_VERSION).toBe(3);
  });

  it('gives each themed zone its own encounters, and keeps the road zone peaceful', () => {
    expect(themed).toHaveLength(20);
    expect(world.zones.filter(z => z.encounterTable.length === 0).map(z => z.displayName)).toEqual(['Old Roads']);
    for (const zone of themed) {
      expect(zone.encounterTable.map(e => e.encounterId)).not.toContain(DEV_MIXED_ENCOUNTER_ID);
      for (const entry of zone.encounterTable) {
        expect(entry.encounterId.startsWith(zone.id), entry.encounterId).toBe(true);
        expect(encounters.has(entry.encounterId), entry.encounterId).toBe(true);
      }
    }
  });

  it('scales every zone monster to its zone with an authored level from the templates', () => {
    const roles = { brute: 'bruiser', skirmisher: 'skirmisher', caster: 'caster', elite: undefined } as const;
    for (const zone of themed) {
      const [lo, hi] = zone.levelRange;
      const ids = new Set(zone.encounterTable.flatMap(e => encounters.get(e.encounterId)!.monsterPool!.map(p => p.monsterId)));
      expect(ids.size).toBe(4);
      for (const id of ids) {
        const m = monsters.get(id)!;
        expect(m.level, id).toBeGreaterThanOrEqual(lo);
        expect(m.level, id).toBeLessThanOrEqual(hi);
        const kind = id.slice(zone.id.length + 1) as keyof typeof roles;
        expect(m.hp, id).toBe(suggestMonsterStats(m.level!, m.tier ?? 'trash', roles[kind]).hp);
      }
      expect([...ids].filter(id => monsters.get(id)!.tier === 'elite')).toHaveLength(1);
    }
  });

  it('ships a raid linked from one Forgotten Vale room', () => {
    expect(world.dungeons.map(d => d.id)).toEqual([DEV_RAID_DUNGEON_ID]);
    const raid = world.dungeons[0];
    const bossFloor = raid.floors[raid.floors.length - 1];
    expect(bossFloor.isBoss).toBe(true);
    const bossIds = bossFloor.encounterTable.flatMap(e => encounters.get(e.encounterId)!.placements!.map(p => p.monsterId));
    expect(bossIds.map(id => [monsters.get(id)!.tier, monsters.get(id)!.level])).toEqual([['raid', 25]]);
    for (const floor of raid.floors) for (const e of floor.encounterTable) expect(encounters.get(e.encounterId)?.type).toBe('explicit');
    const entrances = world.tiles.filter(t => t.dungeonId);
    expect(entrances).toHaveLength(1);
    expect(entrances[0]).toMatchObject({ dungeonId: DEV_RAID_DUNGEON_ID, zone: 'dev_forgotten_vale', type: 'dungeon' });
  });

  it('references only monsters it ships', () => {
    for (const e of world.encounters) {
      for (const id of [...(e.monsterPool ?? []).map(p => p.monsterId), ...(e.placements ?? []).map(p => p.monsterId)]) {
        expect(monsters.has(id), `${e.id} → ${id}`).toBe(true);
      }
    }
  });

  it('is deterministic', () => {
    const again = generateDevWorld();
    expect(again.encounters).toEqual(world.encounters);
    expect(again.zones).toEqual(world.zones);
    expect(again.monsters).toEqual(world.monsters);
    expect(again.dungeons).toEqual(world.dungeons);
  });
});
