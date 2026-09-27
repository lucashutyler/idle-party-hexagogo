import { describe, it, expect, afterEach, vi } from 'vitest';
import { SEED_ENCOUNTERS, resolveEncounter } from '../src/systems/EncounterTypes';
import { SEED_MONSTERS } from '../src/systems/MonsterTypes';
import { SEED_ITEMS } from '../src/systems/ItemTypes';
import { DEV_MIXED_ENCOUNTER_ID, DEV_SEED_VERSION, DEV_ZONE_PREFIX, generateDevWorld } from '../src/seed/SeedDevWorld';

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
      for (const entry of encounter.monsterPool ?? []) {
        expect(SEED_MONSTERS[entry.monsterId], `${encounter.id} → ${entry.monsterId}`).toBeDefined();
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

describe('dev world seed', () => {
  const world = generateDevWorld();

  it('bumps the seed version', () => {
    expect(DEV_SEED_VERSION).toBe(2);
  });

  it('ships the dev_mixed encounter built from seed monsters', () => {
    expect(world.encounters).toHaveLength(1);
    const mixed = world.encounters[0];
    expect(mixed.id).toBe(DEV_MIXED_ENCOUNTER_ID);
    expect(mixed.id.startsWith(DEV_ZONE_PREFIX)).toBe(true);
    const ids = (mixed.monsterPool ?? []).map(e => e.monsterId).sort();
    expect(ids).toEqual(['bandit', 'bandit_cutthroat', 'goblin', 'goblin_shaman', 'wolf']);
    for (const id of ids) expect(SEED_MONSTERS[id]).toBeDefined();
  });

  it('points every themed dev zone at dev_mixed and keeps the road zone peaceful', () => {
    const themed = world.zones.filter(z => z.encounterTable.length > 0);
    const peaceful = world.zones.filter(z => z.encounterTable.length === 0);
    expect(themed).toHaveLength(20);
    for (const zone of themed) expect(zone.encounterTable).toEqual([{ encounterId: DEV_MIXED_ENCOUNTER_ID, weight: 1 }]);
    expect(peaceful.map(z => z.displayName)).toEqual(['Old Roads']);
  });

  it('ships copies of the caster monsters for servers seeded before they existed', () => {
    expect(world.monsters.map(m => m.id).sort()).toEqual(['bandit_cutthroat', 'goblin_shaman']);
    const shaman = world.monsters.find(m => m.id === 'goblin_shaman')!;
    expect(shaman).toEqual(SEED_MONSTERS.goblin_shaman);
    expect(shaman).not.toBe(SEED_MONSTERS.goblin_shaman);
    expect(shaman.skills).not.toBe(SEED_MONSTERS.goblin_shaman.skills);
  });

  it('is deterministic', () => {
    const again = generateDevWorld();
    expect(again.encounters).toEqual(world.encounters);
    expect(again.zones).toEqual(world.zones);
  });
});
