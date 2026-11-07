import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  generateDevWorld,
  DEV_SEED_MARKER_ZONE_ID,
  DEV_MIXED_ENCOUNTER_ID,
  DEV_RAID_DUNGEON_ID,
} from '@idle-party-rpg/shared';
import type { EncounterDefinition, ItemDefinition, MonsterDefinition, WorldTileDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import { ContentStore } from '../src/game/ContentStore.js';
import { seedDevContent } from '../src/game/DevSeed.js';

const LEGACY_TABLE = [{ encounterId: DEV_MIXED_ENCOUNTER_ID, weight: 1 }];
const MIXED: EncounterDefinition = {
  id: DEV_MIXED_ENCOUNTER_ID, name: 'Mixed', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 2 }], roomMax: 6,
};

function generatedEntrance(): WorldTileDefinition {
  return generateDevWorld({ seed: 1 }).tiles.find(t => t.dungeonId === DEV_RAID_DUNGEON_ID)!;
}

function liveTileAt(store: ContentStore, tile: WorldTileDefinition): WorldTileDefinition | undefined {
  return store.getWorld().tiles.find(t => t.mapId === tile.mapId && t.col === tile.col && t.row === tile.row);
}

/**
 * A dev world as the v2 seed left it: every generated zone on the shared mixed table (the road
 * zone stays empty), the raid entrance still a plain room, no zone-scaled monsters and no raid.
 */
async function v2DevWorld(store: ContentStore, editEntrance: (tile: WorldTileDefinition) => void = () => {}): Promise<void> {
  const { zones, tiles } = generateDevWorld({ seed: 1 });
  const legacyZones = zones.map(z => ({ ...z, encounterTable: z.encounterTable.length > 0 ? LEGACY_TABLE.map(e => ({ ...e })) : [] }));
  const legacyTiles = tiles.map(t => {
    if (t.dungeonId !== DEV_RAID_DUNGEON_ID) return t;
    const plain: WorldTileDefinition = { ...t, type: 'plains', name: 'Misted Holt' };
    delete plain.dungeonId;
    editEntrance(plain);
    return plain;
  });
  await store.mergeSeedContent(legacyZones, legacyTiles, { encounters: [MIXED] });
}

describe('Dev seed content merge', () => {
  let save: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    save = vi.spyOn(ContentStore.prototype, 'save').mockResolvedValue(undefined);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); });

  it('merges zone-scaled monsters, per-zone encounters and the raid on a fresh seed', async () => {
    const store = new ContentStore();
    expect(await seedDevContent(store)).toBe(true);

    const { zones, monsters, encounters } = generateDevWorld({ seed: 1 });
    const marker = zones.find(z => z.id === DEV_SEED_MARKER_ZONE_ID)!;
    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)?.encounterTable).toEqual(marker.encounterTable);
    for (const e of encounters) expect(store.getEncounter(e.id), e.id).toBeDefined();
    for (const m of monsters) expect(store.getMonster(m.id)?.level, m.id).toBeGreaterThanOrEqual(1);
    expect(store.getEncounter(DEV_MIXED_ENCOUNTER_ID)).toBeUndefined();

    const raid = store.getDungeon(DEV_RAID_DUNGEON_ID);
    expect(raid?.floors.some(f => f.isBoss)).toBe(true);
    expect(liveTileAt(store, generatedEntrance())?.dungeonId).toBe(DEV_RAID_DUNGEON_ID);
  });

  it('leaves a seeded world alone on the next boot, keeping later edits', async () => {
    const store = new ContentStore();
    expect(await seedDevContent(store)).toBe(true);
    await store.addOrUpdateZone({ ...store.getZone(DEV_SEED_MARKER_ZONE_ID)!, encounterTable: [] });
    const firstMonster = generateDevWorld({ seed: 1 }).monsters[0].id;
    expect((await store.deleteMonster(firstMonster)).success).toBe(true);
    save.mockClear();

    expect(await seedDevContent(store)).toBe(false);
    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)!.encounterTable).toEqual([]);
    expect(store.getMonster(firstMonster)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('upgrades a v2 world once: new definitions, untouched tables switched, entrance linked', async () => {
    const store = new ContentStore();
    await v2DevWorld(store);
    const entrance = generatedEntrance();
    const guid = liveTileAt(store, entrance)!.id;

    expect(await seedDevContent(store)).toBe(true);

    const { zones, monsters, encounters } = generateDevWorld({ seed: 1 });
    for (const z of zones) expect(store.getZone(z.id)?.encounterTable, z.id).toEqual(z.encounterTable);
    for (const m of monsters) expect(store.getMonster(m.id), m.id).toBeDefined();
    for (const e of encounters) expect(store.getEncounter(e.id), e.id).toBeDefined();
    expect(store.getDungeon(DEV_RAID_DUNGEON_ID)).toBeDefined();
    const linked = liveTileAt(store, entrance)!;
    expect(linked.dungeonId).toBe(DEV_RAID_DUNGEON_ID);
    expect(linked.type).toBe('dungeon');
    expect(linked.id).toBe(guid);

    save.mockClear();
    expect(await seedDevContent(store)).toBe(false);
    expect(save).not.toHaveBeenCalled();
  });

  it('never clobbers edited zone tables, authored monsters or an edited entrance room', async () => {
    const store = new ContentStore();
    await v2DevWorld(store, tile => { tile.shopId = 'vale_shop'; });
    const { zones, monsters } = generateDevWorld({ seed: 1 });
    const [authoredZone, emptiedZone] = zones.filter(z => z.id !== DEV_SEED_MARKER_ZONE_ID && z.encounterTable.length > 0);
    await store.addOrUpdateZone({ ...store.getZone(authoredZone.id)!, encounterTable: [{ encounterId: 'authored', weight: 3 }] });
    await store.addOrUpdateZone({ ...store.getZone(emptiedZone.id)!, encounterTable: [] });
    const authoredMonster: MonsterDefinition = { ...monsters[0], name: 'Custom Brute', hp: 99, level: 2 };
    await store.addOrUpdateMonster(authoredMonster);

    expect(await seedDevContent(store)).toBe(true);

    expect(store.getZone(authoredZone.id)!.encounterTable).toEqual([{ encounterId: 'authored', weight: 3 }]);
    expect(store.getZone(emptiedZone.id)!.encounterTable).toEqual([]);
    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)!.encounterTable).toEqual(zones.find(z => z.id === DEV_SEED_MARKER_ZONE_ID)!.encounterTable);
    expect(store.getMonster(monsters[0].id)).toEqual(authoredMonster);
    const entrance = liveTileAt(store, generatedEntrance())!;
    expect(entrance.dungeonId).toBeUndefined();
    expect(entrance.shopId).toBe('vale_shop');
    expect(store.getDungeon(DEV_RAID_DUNGEON_ID)).toBeDefined();
  });

  it('keeps edits made after the upgrade across a reboot', async () => {
    const store = new ContentStore();
    await v2DevWorld(store);
    expect(await seedDevContent(store)).toBe(true);

    const quietZone: ZoneDefinition = { ...store.getZone(DEV_SEED_MARKER_ZONE_ID)!, encounterTable: [] };
    await store.addOrUpdateZone(quietZone);
    const firstMonster = generateDevWorld({ seed: 1 }).monsters[0].id;
    expect((await store.deleteMonster(firstMonster)).success).toBe(true);
    save.mockClear();

    expect(await seedDevContent(store)).toBe(false);
    expect(store.getZone(DEV_SEED_MARKER_ZONE_ID)!.encounterTable).toEqual([]);
    expect(store.getMonster(firstMonster)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('does not upgrade again after the raid is deleted', async () => {
    const store = new ContentStore();
    await v2DevWorld(store);
    expect(await seedDevContent(store)).toBe(true);
    const firstMonster = generateDevWorld({ seed: 1 }).monsters[0].id;
    expect((await store.deleteMonster(firstMonster)).success).toBe(true);
    expect((await store.deleteDungeon(DEV_RAID_DUNGEON_ID)).success).toBe(true);
    save.mockClear();

    expect(await seedDevContent(store)).toBe(false);
    expect(store.getDungeon(DEV_RAID_DUNGEON_ID)).toBeUndefined();
    expect(store.getMonster(firstMonster)).toBeUndefined();
    expect(save).not.toHaveBeenCalled();
  });

  it('keeps a renamed entrance room as the author left it', async () => {
    const store = new ContentStore();
    await v2DevWorld(store, tile => { tile.name = 'Author Room'; });

    expect(await seedDevContent(store)).toBe(true);

    const entrance = liveTileAt(store, generatedEntrance())!;
    expect(entrance.name).toBe('Author Room');
    expect(entrance.dungeonId).toBeUndefined();
    expect(store.getDungeon(DEV_RAID_DUNGEON_ID)).toBeDefined();
  });

  it('drops loot entries for items the live world does not have', async () => {
    const store = new ContentStore();
    await store.addOrUpdateItem({ id: 'kept', name: 'Kept' } as ItemDefinition);
    const looter: MonsterDefinition = {
      id: 'dev_looter', name: 'Looter', hp: 10, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0,
      drops: [{ itemId: 'kept', chance: 0.5 }, { itemId: 'missing', chance: 0.5 }],
    };

    await store.upgradeSeedContent({ monsters: [looter] });

    expect(store.getMonster('dev_looter')!.drops!.map(d => d.itemId)).toEqual(['kept']);
  });
});
