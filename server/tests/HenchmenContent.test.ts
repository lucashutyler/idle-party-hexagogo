import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { HenchmanDefinition, ShopDefinition, SkillDefinition } from '@idle-party-rpg/shared';
import { findZonesSpanningMaps } from '@idle-party-rpg/shared';

// ContentStore resolves its data dir from process.cwd() at module load, so the
// tmp-dir chdir must happen BEFORE the module is imported (dynamic import below).
// Mirrors DesignNotes.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;

let ContentStore: ContentStoreCtor;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'henchmen-content-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function loadFreshStore(): Promise<ContentStoreInstance> {
  const store = new ContentStore();
  await store.load();
  return store;
}

function makeHenchman(id: string, overrides: Partial<HenchmanDefinition> = {}): HenchmanDefinition {
  return {
    id,
    name: `Henchman ${id}`,
    className: 'Knight',
    level: 5,
    maxHp: 100,
    baseDamage: 8,
    skillIds: [],
    emoji: '🗡️',
    ...overrides,
  };
}

function makeShop(id: string, henchmanIds?: string[]): ShopDefinition {
  return { id, name: `Shop ${id}`, inventory: [], henchmanIds };
}

describe('ContentStore henchmen', () => {
  it('round-trips a henchman through addOrUpdateHenchman/getHenchman/deleteHenchman', async () => {
    const store = await loadFreshStore();
    const hench = makeHenchman('hench_a');
    await store.addOrUpdateHenchman(hench);

    expect(store.getHenchman('hench_a')).toEqual(hench);

    const result = await store.deleteHenchman('hench_a');
    expect(result.success).toBe(true);
    expect(store.getHenchman('hench_a')).toBeUndefined();
  });

  it('persists henchmen to data/henchmen.json and reloads them', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_persist', { name: 'Grim' }));

    const reloaded = await loadFreshStore();
    expect(reloaded.getHenchman('hench_persist')?.name).toBe('Grim');
  });

  it('refuses to delete a henchman while a shop offers it, naming the shop', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_offered'));
    await store.addOrUpdateShop(makeShop('shop_a', ['hench_offered']));

    const result = await store.deleteHenchman('hench_offered');
    expect(result.success).toBe(false);
    expect(result.error).toContain('Shop shop_a');
    // The henchman must still be there — a refused delete that half-applied
    // would leave shops pointing at nothing.
    expect(store.getHenchman('hench_offered')).toBeDefined();
  });

  it('allows deleting a henchman once no shop offers it', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_freed'));
    await store.addOrUpdateShop(makeShop('shop_b', ['hench_freed']));
    await store.addOrUpdateShop(makeShop('shop_b', []));

    const result = await store.deleteHenchman('hench_freed');
    expect(result.success).toBe(true);
  });

  it("refuses to delete a skill while a henchman's fixed loadout uses it", async () => {
    const store = await loadFreshStore();
    const skill: SkillDefinition = {
      id: 'skill_hench',
      name: 'Test Strike',
      description: 'A test skill.',
      className: 'Knight',
      kind: 'active',
      tier: 1,
      effects: [],
    } as unknown as SkillDefinition;
    await store.addOrUpdateSkill(skill);
    await store.addOrUpdateHenchman(makeHenchman('hench_skilled', { skillIds: ['skill_hench'] }));

    const result = await store.deleteSkill('skill_hench');
    expect(result.success).toBe(false);
    expect(result.error).toContain('henchman');
    expect(store.getSkill('skill_hench')).toBeDefined();
  });
});

describe('ContentStore henchmen snapshot semantics', () => {
  it('exports henchmen through toSnapshot', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_snap'));

    const snapshot = store.toSnapshot();
    expect(snapshot.henchmen.map(h => h.id)).toContain('hench_snap');
  });

  it('KEEPS live henchmen when a snapshot omits the key entirely (pre-henchmen snapshot)', async () => {
    // The blocker this guards: every snapshot published before henchmen existed
    // lacks the key. Clear-then-fill semantics would wipe the live catalogue on
    // the first deploy or rollback, orphaning every party that hired one.
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_live'));

    const snapshot = store.toSnapshot();
    const legacy = { ...snapshot } as Partial<typeof snapshot>;
    delete legacy.henchmen;

    await store.replaceAll(legacy as typeof snapshot);

    expect(store.getHenchman('hench_live')).toBeDefined();
  });

  it('CLEARS henchmen when a snapshot ships an explicitly empty array', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_gone'));

    const snapshot = store.toSnapshot();
    await store.replaceAll({ ...snapshot, henchmen: [] });

    expect(store.getHenchman('hench_gone')).toBeUndefined();
  });

  it('replaces henchmen when a snapshot ships a populated array', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateHenchman(makeHenchman('hench_old'));

    const snapshot = store.toSnapshot();
    await store.replaceAll({ ...snapshot, henchmen: [makeHenchman('hench_new')] });

    expect(store.getHenchman('hench_old')).toBeUndefined();
    expect(store.getHenchman('hench_new')).toBeDefined();
  });
});

describe('ContentStore zone/map constraint', () => {
  function worldTile(mapId: string, col: number, row: number, zone: string) {
    return { id: '', mapId, col, row, type: 'plains', zone, name: `${col},${row}` };
  }

  it('the seeded default world satisfies the constraint', async () => {
    // A guard on our own content: the constraint is worthless if a fresh install
    // violates it out of the box.
    const store = await loadFreshStore();
    expect(findZonesSpanningMaps(store.getWorld().tiles)).toEqual([]);
  });

  it('accepts a room whose zone is new to the world', async () => {
    const store = await loadFreshStore();
    const result = await store.addOrUpdateTile(worldTile('overworld', 40, 40, 'brand_new_zone'));
    expect(result.success).toBe(true);
  });

  it('refuses a room that would put an existing zone onto a second map', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateTile(worldTile('overworld', 41, 41, 'shared_zone'));

    const result = await store.addOrUpdateTile(worldTile('sewers', 41, 41, 'shared_zone'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot span maps');
    // And the refused room must not have been written.
    expect(store.getWorld().tiles.some(t => t.mapId === 'sewers' && t.zone === 'shared_zone')).toBe(false);
  });

  it('still allows editing a room in a zone that already spans maps', async () => {
    const store = await loadFreshStore();
    // Force a pre-constraint violation directly into the world, the way legacy
    // content would already look.
    const world = store.getWorld();
    world.tiles.push(
      { ...worldTile('overworld', 42, 42, 'legacy_zone'), id: 'legacy-a' },
      { ...worldTile('crypt', 42, 42, 'legacy_zone'), id: 'legacy-b' },
    );

    const result = await store.addOrUpdateTile({ ...worldTile('crypt', 42, 42, 'legacy_zone'), name: 'Renamed' });

    expect(result.success).toBe(true);
    expect(store.getWorld().tiles.find(t => t.id === 'legacy-b')?.name).toBe('Renamed');
  });
});
