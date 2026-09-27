import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateDevWorld,
  DEV_SEED_MARKER_ZONE_ID,
  DEV_MIXED_ENCOUNTER_ID,
} from '@idle-party-rpg/shared';
import type { EncounterDefinition, ItemDefinition, MonsterDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import { ContentStore } from '../src/game/ContentStore.js';
import { seedDevContent } from '../src/game/DevSeed.js';

/** A dev world as an older seed left it: every generated zone present, encounter tables empty, no casters. */
async function legacyDevWorld(store: ContentStore): Promise<void> {
  const { zones, tiles } = generateDevWorld({ seed: 1 });
  await store.mergeSeedContent(zones.map(z => ({ ...z, encounterTable: [] })), tiles);
}

describe('Dev seed content merge', () => {
  let save: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    save = vi.spyOn(ContentStore.prototype, 'save').mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('merges the dev encounters and caster monsters on a fresh seed', async () => {
    const store = new ContentStore();
    expect(await seedDevContent(store)).toBe(true);

    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)?.encounterTable).toEqual([{ encounterId: DEV_MIXED_ENCOUNTER_ID, weight: 1 }]);
    expect(store.getEncounter(DEV_MIXED_ENCOUNTER_ID)).toBeDefined();
    expect(store.getMonster('goblin_shaman')?.skills?.length).toBeGreaterThan(0);
    expect(store.getMonster('bandit_cutthroat')?.skills?.length).toBeGreaterThan(0);
  });

  it('upgrades an older dev world in place, then leaves it alone', async () => {
    const store = new ContentStore();
    await legacyDevWorld(store);
    expect(store.getEncounter(DEV_MIXED_ENCOUNTER_ID)).toBeUndefined();

    expect(await seedDevContent(store)).toBe(true);
    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)?.encounterTable[0]?.encounterId).toBe(DEV_MIXED_ENCOUNTER_ID);
    expect(store.getEncounter(DEV_MIXED_ENCOUNTER_ID)).toBeDefined();
    expect(store.getMonster('goblin_shaman')).toBeDefined();

    save.mockClear();
    expect(await seedDevContent(store)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('never overwrites authored encounters, monsters or non-empty zone tables', async () => {
    const store = new ContentStore();
    await legacyDevWorld(store);
    const authoredZone: ZoneDefinition = {
      ...store.getZone(DEV_SEED_MARKER_ZONE_ID)!,
      encounterTable: [{ encounterId: 'authored', weight: 3 }],
    };
    await store.addOrUpdateZone(authoredZone);
    const authoredShaman: MonsterDefinition = {
      id: 'goblin_shaman', name: 'Custom Shaman', hp: 99, damage: 9, damageType: 'magical', xp: 1, goldMin: 0, goldMax: 0,
    };
    await store.addOrUpdateMonster(authoredShaman);
    const authoredEncounter: EncounterDefinition = { id: DEV_MIXED_ENCOUNTER_ID, name: 'Mine', type: 'random', monsterPool: [], roomMax: 1 };
    await store.addOrUpdateEncounter(authoredEncounter);

    const { zones, encounters, monsters } = generateDevWorld({ seed: 1 });
    await store.upgradeSeedContent(zones, encounters, monsters);

    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)!.encounterTable).toEqual([{ encounterId: 'authored', weight: 3 }]);
    expect(store.getMonster('goblin_shaman')).toEqual(authoredShaman);
    expect(store.getEncounter(DEV_MIXED_ENCOUNTER_ID)).toEqual(authoredEncounter);
    expect(store.getMonster('bandit_cutthroat')).toBeDefined();
  });

  it('drops loot entries for items the live world does not have', async () => {
    const store = new ContentStore();
    const { monsters } = generateDevWorld({ seed: 1 });
    const shaman = monsters.find(m => m.id === 'goblin_shaman')!;
    const [kept, ...missing] = shaman.drops!.map(d => d.itemId);
    await store.addOrUpdateItem({ id: kept, name: kept } as ItemDefinition);

    await store.upgradeSeedContent([], [], monsters);

    const drops = store.getMonster('goblin_shaman')!.drops!.map(d => d.itemId);
    expect(drops).toContain(kept);
    for (const id of missing) expect(drops).not.toContain(id);
  });
});
