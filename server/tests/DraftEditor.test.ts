import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { TileType, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  ItemDefinition,
  ShopDefinition,
  SetDefinition,
  SkillDefinition,
} from '@idle-party-rpg/shared';

// Both ContentStore and VersionStore resolve their data dirs from process.cwd() at
// module load, so the tmp-dir chdir must happen BEFORE either module (and DraftEditor,
// which imports their types only) is imported. Mirrors SkillContentStore.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type VersionStoreCtor = typeof import('../src/game/VersionStore.js').VersionStore;
type VersionStoreInstance = InstanceType<VersionStoreCtor>;
type DraftEditorCtor = typeof import('../src/game/DraftEditor.js').DraftEditor;
type DraftEditorInstance = InstanceType<DraftEditorCtor>;
type ToRecordFn = typeof import('../src/game/DraftEditor.js').toRecord;

let ContentStore: ContentStoreCtor;
let VersionStore: VersionStoreCtor;
let DraftEditor: DraftEditorCtor;
let toRecord: ToRecordFn;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'draft-editor-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor, toRecord } = await import('../src/game/DraftEditor.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

function makeMonster(id: string, overrides: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return {
    id,
    name: `Monster ${id}`,
    hp: 10,
    damage: 2,
    damageType: 'physical',
    xp: 5,
    goldMin: 1,
    goldMax: 2,
    ...overrides,
  };
}

function makeItem(id: string, overrides: Partial<ItemDefinition> = {}): ItemDefinition {
  return {
    id,
    name: `Item ${id}`,
    rarity: 'common',
    value: 1,
    ...overrides,
  };
}

function makeShop(id: string, overrides: Partial<ShopDefinition> = {}): ShopDefinition {
  return {
    id,
    name: `Shop ${id}`,
    inventory: [],
    ...overrides,
  };
}

function makeSet(id: string, overrides: Partial<SetDefinition> = {}): SetDefinition {
  return {
    id,
    name: `Set ${id}`,
    itemIds: [],
    breakpoints: [],
    ...overrides,
  };
}

/** Fresh ContentStore + VersionStore + DraftEditor, plus a draft version seeded from live content. */
async function setupDraft(): Promise<{
  contentStore: ContentStoreInstance;
  versionStore: VersionStoreInstance;
  draftEditor: DraftEditorInstance;
  versionId: string;
}> {
  const contentStore = new ContentStore();
  await contentStore.load();
  const versionStore = new VersionStore();
  await versionStore.load();
  const draftEditor = new DraftEditor(versionStore, () => contentStore);
  const snapshot = contentStore.toSnapshot();
  const version = await versionStore.createDraft('test draft', null, snapshot);
  return { contentStore, versionStore, draftEditor, versionId: version.id };
}

describe('DraftEditor', () => {
  it('upserts a brand-new monster into a draft and round-trips it', async () => {
    const { draftEditor, versionStore, versionId } = await setupDraft();
    const monster = makeMonster('test_goblin', { name: 'Test Goblin' });

    const result = await draftEditor.upsertMonster(versionId, monster);
    expect(result.success).toBe(true);
    if (!result.success) throw new Error('unreachable');
    expect(result.entries.find(m => m.id === 'test_goblin')).toEqual(monster);

    const reloaded = await versionStore.loadSnapshot(versionId);
    expect(reloaded.monsters.find(m => m.id === 'test_goblin')).toEqual(monster);
  });

  it('rejects any edit against a published (non-draft) version', async () => {
    const { draftEditor, versionStore, versionId } = await setupDraft();
    const published = await versionStore.publish(versionId);
    expect(published.success).toBe(true);

    const result = await draftEditor.upsertMonster(versionId, makeMonster('nope'));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.status).toBe(400);
  });

  it('rejects any edit against a version id that does not exist', async () => {
    const { draftEditor } = await setupDraft();
    const result = await draftEditor.upsertMonster(crypto.randomUUID(), makeMonster('nope'));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('unreachable');
    expect(result.status).toBe(404);
  });

  describe('shops delete-guard parity', () => {
    it('rejects deleting a shop referenced by a room (tile.shopId)', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const shop = makeShop('test_shop');
      const upsertShopResult = await draftEditor.upsertShop(versionId, shop);
      expect(upsertShopResult.success).toBe(true);

      // Blacksmith @ (1,2) on the seeded overworld — point its shopId at our new shop.
      const tileResult = await draftEditor.upsertTile(versionId, {
        mapId: DEFAULT_MAP_ID,
        col: 1,
        row: 2,
        type: TileType.Town,
        zone: 'hatchetmill',
        name: 'Blacksmith',
        shopId: 'test_shop',
      });
      expect(tileResult.success).toBe(true);
      if (!tileResult.success) throw new Error('unreachable');
      const blacksmith = tileResult.world.tiles.find(t => t.col === 1 && t.row === 2);
      expect(blacksmith?.shopId).toBe('test_shop');

      const deleteResult = await draftEditor.deleteShop(versionId, 'test_shop');
      expect(deleteResult.success).toBe(false);
      if (deleteResult.success) throw new Error('unreachable');
      expect(deleteResult.status).toBe(400);
      expect(deleteResult.error).toContain('Blacksmith');
    });

    it('allows deleting an unreferenced shop', async () => {
      const { draftEditor, versionId } = await setupDraft();
      await draftEditor.upsertShop(versionId, makeShop('lonely_shop'));
      const deleteResult = await draftEditor.deleteShop(versionId, 'lonely_shop');
      expect(deleteResult.success).toBe(true);
    });
  });

  describe('intentional asymmetry: monsters and sets have no delete guard', () => {
    it('allows deleting a monster still referenced by an encounter monsterPool', async () => {
      const { draftEditor, versionId } = await setupDraft();
      await draftEditor.upsertMonster(versionId, makeMonster('guarded_goblin'));
      const encResult = await draftEditor.upsertEncounter(versionId, {
        id: 'test_encounter',
        name: 'Test Encounter',
        type: 'random',
        monsterPool: [{ monsterId: 'guarded_goblin', min: 1, max: 1 }],
      });
      expect(encResult.success).toBe(true);

      const deleteResult = await draftEditor.deleteMonster(versionId, 'guarded_goblin');
      expect(deleteResult.success).toBe(true);
      if (!deleteResult.success) throw new Error('unreachable');
      expect(deleteResult.entries.find(m => m.id === 'guarded_goblin')).toBeUndefined();
    });

    it('allows deleting a set with no referential guard', async () => {
      const { draftEditor, versionId } = await setupDraft();
      await draftEditor.upsertSet(versionId, makeSet('test_set', { itemIds: ['some_item'] }));
      const deleteResult = await draftEditor.deleteSet(versionId, 'test_set');
      expect(deleteResult.success).toBe(true);
    });
  });

  it('rejects deleting an item referenced by a monster drop table', async () => {
    const { draftEditor, versionId } = await setupDraft();
    await draftEditor.upsertItem(versionId, makeItem('rare_bone'));
    await draftEditor.upsertMonster(versionId, makeMonster('bone_dropper', {
      drops: [{ itemId: 'rare_bone', chance: 0.5 }],
    }));

    const deleteResult = await draftEditor.deleteItem(versionId, 'rare_bone');
    expect(deleteResult.success).toBe(false);
    if (deleteResult.success) throw new Error('unreachable');
    expect(deleteResult.status).toBe(400);
    expect(deleteResult.error).toContain('Monster bone_dropper');
  });

  it('rejects two sets that share an item and a class via findSetConflicts', async () => {
    const { draftEditor, versionId } = await setupDraft();
    const setA = makeSet('set_a', { itemIds: ['shared_item'], classRestriction: ['Knight'] });
    const setB = makeSet('set_b', { itemIds: ['shared_item'], classRestriction: ['Knight'] });

    const resultA = await draftEditor.upsertSet(versionId, setA);
    expect(resultA.success).toBe(true);

    const resultB = await draftEditor.upsertSet(versionId, setB);
    expect(resultB.success).toBe(false);
    if (resultB.success) throw new Error('unreachable');
    expect(resultB.status).toBe(400);
    expect(resultB.error).toContain('Set set_a');
  });

  describe('skills upsert validation', () => {
    it('rejects a skill definition with an unknown effect kind', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const badSkill = {
        id: 'bad_skill',
        name: 'Bad Skill',
        description: 'Invalid on purpose',
        className: 'Knight',
        type: 'passive',
        unlockLevel: 5,
        sortOrder: 99,
        passiveEffects: [{ kind: 'not_a_real_kind' }],
      } as unknown as SkillDefinition;

      const result = await draftEditor.upsertSkill(versionId, badSkill);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.status).toBe(400);
    });

    it('rejects a skill definition with a missing/unknown className', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const badSkill = {
        id: 'bad_skill_2',
        name: 'Bad Skill 2',
        description: 'Invalid on purpose',
        className: 'NotAClass',
        type: 'passive',
        unlockLevel: 5,
        sortOrder: 99,
        passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 }],
      } as unknown as SkillDefinition;

      const result = await draftEditor.upsertSkill(versionId, badSkill);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.status).toBe(400);
    });

    it('accepts a valid skill definition', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const goodSkill: SkillDefinition = {
        id: 'good_skill',
        name: 'Good Skill',
        description: 'Valid',
        className: 'Knight',
        type: 'passive',
        unlockLevel: 5,
        sortOrder: 99,
        passiveEffects: [{ kind: 'physical_reduction', valuePerLevel: 1 } as never],
      };

      const result = await draftEditor.upsertSkill(versionId, goodSkill);
      expect(result.success).toBe(true);
    });
  });

  describe('world tiles', () => {
    it('assigns a new GUID for a brand-new (mapId,col,row) and preserves it on update', async () => {
      const { draftEditor, versionId } = await setupDraft();

      const created = await draftEditor.upsertTile(versionId, {
        mapId: DEFAULT_MAP_ID,
        col: 42,
        row: 42,
        type: TileType.Plains,
        zone: 'hatchetmill',
        name: 'New Room',
      });
      expect(created.success).toBe(true);
      if (!created.success) throw new Error('unreachable');
      const createdTile = created.world.tiles.find(t => t.col === 42 && t.row === 42);
      expect(createdTile).toBeDefined();
      const originalId = createdTile!.id;
      expect(originalId).toBeTruthy();

      const updated = await draftEditor.upsertTile(versionId, {
        mapId: DEFAULT_MAP_ID,
        col: 42,
        row: 42,
        type: TileType.Forest,
        zone: 'hatchetmill',
        name: 'New Room Renamed',
      });
      expect(updated.success).toBe(true);
      if (!updated.success) throw new Error('unreachable');
      const updatedTile = updated.world.tiles.find(t => t.col === 42 && t.row === 42);
      expect(updatedTile?.id).toBe(originalId);
      expect(updatedTile?.name).toBe('New Room Renamed');
      expect(updatedTile?.type).toBe(TileType.Forest);
    });

    it('refuses to delete the start tile', async () => {
      const { draftEditor, versionStore, versionId } = await setupDraft();
      const snapshot = await versionStore.loadSnapshot(versionId);
      const { startTile, defaultMapId } = snapshot.world;

      const result = await draftEditor.deleteTile(versionId, defaultMapId, startTile.col, startTile.row);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.error).toContain('start tile');
    });

    it('refuses to delete a tile another tile\'s transitions[] points at', async () => {
      const { draftEditor, versionId } = await setupDraft();

      const targetResult = await draftEditor.upsertTile(versionId, {
        mapId: DEFAULT_MAP_ID,
        col: 50,
        row: 50,
        type: TileType.Plains,
        zone: 'hatchetmill',
        name: 'Target Room',
      });
      expect(targetResult.success).toBe(true);
      if (!targetResult.success) throw new Error('unreachable');
      const targetTile = targetResult.world.tiles.find(t => t.col === 50 && t.row === 50)!;

      const sourceResult = await draftEditor.upsertTile(versionId, {
        mapId: DEFAULT_MAP_ID,
        col: 51,
        row: 51,
        type: TileType.Plains,
        zone: 'hatchetmill',
        name: 'Source Room',
        transitions: [{ mapId: DEFAULT_MAP_ID, tileId: targetTile.id }],
      });
      expect(sourceResult.success).toBe(true);

      const deleteResult = await draftEditor.deleteTile(versionId, DEFAULT_MAP_ID, 50, 50);
      expect(deleteResult.success).toBe(false);
      if (deleteResult.success) throw new Error('unreachable');
      expect(deleteResult.error).toContain('Source Room');
    });
  });

  describe('generic dispatch', () => {
    it('upsertContent/deleteContent for monsters behave identically to the specific methods', async () => {
      const specific = await setupDraft();
      const generic = await setupDraft();
      const monster = makeMonster('dispatch_test');

      const specificUpsert = await specific.draftEditor.upsertMonster(specific.versionId, monster);
      const genericUpsert = await generic.draftEditor.upsertContent('monsters', generic.versionId, monster);
      expect(specificUpsert.success).toBe(true);
      expect(genericUpsert.success).toBe(true);
      if (!specificUpsert.success || !genericUpsert.success) throw new Error('unreachable');
      expect(genericUpsert.entries.find((m: unknown) => (m as MonsterDefinition).id === 'dispatch_test'))
        .toEqual(specificUpsert.entries.find(m => m.id === 'dispatch_test'));

      const specificDelete = await specific.draftEditor.deleteMonster(specific.versionId, 'dispatch_test');
      const genericDelete = await generic.draftEditor.deleteContent('monsters', generic.versionId, 'dispatch_test');
      expect(specificDelete.success).toBe(true);
      expect(genericDelete.success).toBe(true);
      if (!specificDelete.success || !genericDelete.success) throw new Error('unreachable');
      expect(genericDelete.entries.find((m: unknown) => (m as MonsterDefinition).id === 'dispatch_test')).toBeUndefined();
      expect(specificDelete.entries.find(m => m.id === 'dispatch_test')).toBeUndefined();
    });

    it('upsertContentBulk round-trips 3 new monsters in one call', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const monsters = [makeMonster('bulk_1'), makeMonster('bulk_2'), makeMonster('bulk_3')];

      const result = await draftEditor.upsertContentBulk('monsters', versionId, monsters);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      const ids = (result.entries as MonsterDefinition[]).map(m => m.id);
      expect(ids).toEqual(expect.arrayContaining(['bulk_1', 'bulk_2', 'bulk_3']));
    });

    it('upsertContentBulk stops and reports on a bad entry in position 2 of 3', async () => {
      const { draftEditor, versionStore, versionId } = await setupDraft();
      const setA = makeSet('bulk_set_a', { itemIds: ['shared_item'], classRestriction: ['Knight'] });
      // Conflicts with setA: same item, same class.
      const setBConflict = makeSet('bulk_set_b', { itemIds: ['shared_item'], classRestriction: ['Knight'] });
      const setC = makeSet('bulk_set_c', { itemIds: ['unrelated_item'] });

      const result = await draftEditor.upsertContentBulk('sets', versionId, [setA, setBConflict, setC]);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');
      expect(result.status).toBe(400);

      // All-or-nothing: the batch loads once and persists once, so a failure on entry 2
      // discards the whole in-memory batch — setA is NOT persisted either, unlike a naive
      // per-entry-persist loop would leave behind.
      const reloaded = await versionStore.loadSnapshot(versionId);
      const ids = (reloaded.sets ?? []).map(s => s.id);
      expect(ids).not.toContain('bulk_set_a');
      expect(ids).not.toContain('bulk_set_b');
      expect(ids).not.toContain('bulk_set_c');
    });
  });

  it('toRecord builds a Record<id, entry> from an array', () => {
    const arr = [{ id: 'a', v: 1 }, { id: 'b', v: 2 }];
    expect(toRecord(arr)).toEqual({ a: { id: 'a', v: 1 }, b: { id: 'b', v: 2 } });
  });

  it('toRecord treats a "__proto__" id as an ordinary own key, not a prototype reassignment', () => {
    const malicious = { id: '__proto__', v: 'evil' };
    const record = toRecord([malicious, { id: 'safe', v: 1 }]);

    // The malicious entry must show up like any other key — not vanish into the prototype.
    expect(Object.keys(record)).toEqual(expect.arrayContaining(['__proto__', 'safe']));
    expect(Object.prototype.hasOwnProperty.call(record, '__proto__')).toBe(true);
    expect(record['__proto__']).toEqual(malicious);
    expect(JSON.parse(JSON.stringify(record))).toHaveProperty('__proto__');
    // And the record's actual prototype chain must be untouched (null-prototype object).
    expect(Object.getPrototypeOf(record)).toBeNull();
  });

  describe('bulk tiles', () => {
    it('upsertTilesBulk creates several new tiles in one load+save', async () => {
      const { draftEditor, versionStore, versionId } = await setupDraft();
      const result = await draftEditor.upsertTilesBulk(versionId, [
        { mapId: DEFAULT_MAP_ID, col: 60, row: 60, type: TileType.Plains, zone: 'hatchetmill', name: 'Bulk A' },
        { mapId: DEFAULT_MAP_ID, col: 61, row: 61, type: TileType.Plains, zone: 'hatchetmill', name: 'Bulk B' },
      ]);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(result.world.tiles.find(t => t.col === 60 && t.row === 60)?.name).toBe('Bulk A');
      expect(result.world.tiles.find(t => t.col === 61 && t.row === 61)?.name).toBe('Bulk B');

      const reloaded = await versionStore.loadSnapshot(versionId);
      expect(reloaded.world.tiles.find(t => t.col === 60 && t.row === 60)).toBeDefined();
      expect(reloaded.world.tiles.find(t => t.col === 61 && t.row === 61)).toBeDefined();
    });

    it('deleteTilesBulk is all-or-nothing: a failure on the second ref persists nothing', async () => {
      const { draftEditor, versionStore, versionId } = await setupDraft();
      const upsertResult = await draftEditor.upsertTilesBulk(versionId, [
        { mapId: DEFAULT_MAP_ID, col: 62, row: 62, type: TileType.Plains, zone: 'hatchetmill', name: 'Deletable A' },
        { mapId: DEFAULT_MAP_ID, col: 63, row: 63, type: TileType.Plains, zone: 'hatchetmill', name: 'Deletable B' },
      ]);
      expect(upsertResult.success).toBe(true);

      const result = await draftEditor.deleteTilesBulk(versionId, [
        { mapId: DEFAULT_MAP_ID, col: 62, row: 62 },
        { mapId: DEFAULT_MAP_ID, col: 999, row: 999 }, // doesn't exist — should abort the whole batch
      ]);
      expect(result.success).toBe(false);
      if (result.success) throw new Error('unreachable');

      const reloaded = await versionStore.loadSnapshot(versionId);
      // Deletable A must still be present — the batch aborted before persisting anything.
      expect(reloaded.world.tiles.find(t => t.col === 62 && t.row === 62)).toBeDefined();
      expect(reloaded.world.tiles.find(t => t.col === 63 && t.row === 63)).toBeDefined();
    });
  });

  describe('seed helpers', () => {
    it('seedTileTypes adds missing seed tile types without touching existing custom ones', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const custom = { id: 'custom_type', name: 'Custom', icon: '?', color: '#123456', traversable: true };
      const upsertResult = await draftEditor.upsertTileType(versionId, custom);
      expect(upsertResult.success).toBe(true);

      const seedResult = await draftEditor.seedTileTypes(versionId);
      expect(seedResult.success).toBe(true);
      if (!seedResult.success) throw new Error('unreachable');
      expect(seedResult.entries.find(t => t.id === 'custom_type')).toEqual(custom);
      expect(seedResult.entries.length).toBeGreaterThan(1);
    });

    it('seedSkills overwrites seed-id skills and replaces slot schedules', async () => {
      const { draftEditor, versionId } = await setupDraft();
      const result = await draftEditor.seedSkills(versionId);
      expect(result.success).toBe(true);
      if (!result.success) throw new Error('unreachable');
      expect(result.skills.length).toBeGreaterThan(0);
      expect(result.skillSlotSchedules.length).toBeGreaterThan(0);
    });
  });
});
