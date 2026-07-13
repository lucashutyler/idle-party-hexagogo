import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES } from '@idle-party-rpg/shared';
import type { SetDefinition } from '@idle-party-rpg/shared';

// ContentStore resolves its data dir from process.cwd() at module load, so the
// tmp-dir chdir must happen BEFORE the module is imported (dynamic import below).
// Vitest's forks pool gives each test file its own process, so chdir is safe.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;

let ContentStore: ContentStoreCtor;
let tmpDir: string;
let originalCwd: string;

const SEED_SKILL_COUNT = Object.keys(SEED_SKILLS).length;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-content-store-'));
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

/** Write the four required data files so tryLoadAll() succeeds (existing-install path). */
async function writeCoreDataFiles(): Promise<void> {
  const dataDir = path.join(tmpDir, 'data');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(path.join(dataDir, 'monsters.json'), '[]');
  await fs.writeFile(path.join(dataDir, 'items.json'), '[]');
  await fs.writeFile(path.join(dataDir, 'zones.json'), '[]');
  await fs.writeFile(path.join(dataDir, 'world.json'), JSON.stringify({ startTile: { col: 0, row: 0 }, tiles: [] }));
}

async function loadFreshStore(): Promise<ContentStoreInstance> {
  const store = new ContentStore();
  await store.load();
  return store;
}

describe('ContentStore skills content', () => {
  it('seeds skills + slot schedules when data files exist but skills.json is missing', async () => {
    await writeCoreDataFiles();
    const store = await loadFreshStore();

    const skills = store.getAllSkills();
    expect(Object.keys(skills).length).toBe(SEED_SKILL_COUNT);
    expect(skills['knight_guard']).toBeDefined();
    expect(store.getSkillSlotSchedule('Knight')).toEqual(SEED_SKILL_SLOT_SCHEDULES['Knight']);

    // Seed-when-missing persists both files
    const skillsRaw = JSON.parse(await fs.readFile(path.join(tmpDir, 'data', 'skills.json'), 'utf-8'));
    expect(skillsRaw.length).toBe(SEED_SKILL_COUNT);
    const slotsRaw = JSON.parse(await fs.readFile(path.join(tmpDir, 'data', 'skill-slots.json'), 'utf-8'));
    expect(slotsRaw.length).toBe(Object.keys(SEED_SKILL_SLOT_SCHEDULES).length);
  });

  it('seeds skills + slot schedules on a fresh install (no data files at all)', async () => {
    const store = await loadFreshStore();
    expect(Object.keys(store.getAllSkills()).length).toBe(SEED_SKILL_COUNT);
    expect(Object.keys(store.getAllSkillSlotSchedules()).length).toBe(Object.keys(SEED_SKILL_SLOT_SCHEDULES).length);
  });

  it('round-trips skills and slot schedules through toSnapshot/replaceAll', async () => {
    const store = await loadFreshStore();

    // Edit a skill, snapshot, edit again, then restore the snapshot
    const edited = { ...store.getSkill('knight_guard')!, unlockLevel: 42 };
    await store.addOrUpdateSkill(edited);
    const snapshot = store.toSnapshot();
    expect(snapshot.skills.find(s => s.id === 'knight_guard')?.unlockLevel).toBe(42);
    expect(snapshot.skillSlotSchedules.length).toBe(Object.keys(SEED_SKILL_SLOT_SCHEDULES).length);

    await store.addOrUpdateSkill({ ...edited, unlockLevel: 7 });
    await store.replaceAll(snapshot);
    expect(store.getSkill('knight_guard')?.unlockLevel).toBe(42);
    expect(store.getSkillSlotSchedule('Bard')).toEqual(SEED_SKILL_SLOT_SCHEDULES['Bard']);
  });

  it('keeps existing skills and schedules when a snapshot lacks them (old snapshot)', async () => {
    const store = await loadFreshStore();
    const snapshot = store.toSnapshot() as Partial<ReturnType<ContentStoreInstance['toSnapshot']>> & { world: ReturnType<ContentStoreInstance['toSnapshot']>['world'] };
    delete snapshot.skills;
    delete snapshot.skillSlotSchedules;

    await store.replaceAll(snapshot as Parameters<ContentStoreInstance['replaceAll']>[0]);
    expect(Object.keys(store.getAllSkills()).length).toBe(SEED_SKILL_COUNT);
    expect(store.getSkillSlotSchedule('Knight')).toEqual(SEED_SKILL_SLOT_SCHEDULES['Knight']);
  });

  it('migrates legacy-shaped skills coming in through replaceAll', async () => {
    const store = await loadFreshStore();
    const snapshot = store.toSnapshot();
    snapshot.skills = [
      {
        id: 'legacy_skill', name: 'Legacy', description: 'Old shape', className: 'Knight', type: 'passive',
        treeOrder: 2, passiveEffect: { kind: 'physical_reduction', valuePerLevel: 2 },
      } as unknown as (typeof snapshot.skills)[0],
    ];

    await store.replaceAll(snapshot);
    const migrated = store.getSkill('legacy_skill');
    expect(migrated).toBeDefined();
    expect(migrated!.unlockLevel).toBe(10); // treeOrder 2 → level 10
    expect(migrated!.sortOrder).toBe(2);
    expect(migrated!.passiveEffects).toEqual([{ kind: 'physical_reduction', valuePerLevel: 2 }]);
  });

  it('blocks deleteSkill while an item grants the skill', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateItem({ id: 'magic_ring', name: 'Magic Ring', rarity: 'rare', equipSlot: 'ring', value: 1, grantedSkillIds: ['mage_zap'] });

    const blocked = await store.deleteSkill('mage_zap');
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('Magic Ring');

    await store.deleteItem('magic_ring');
    const allowed = await store.deleteSkill('mage_zap');
    expect(allowed.success).toBe(true);
    expect(store.getSkill('mage_zap')).toBeUndefined();
  });

  it('blocks deleteSkill while a set breakpoint grants the skill', async () => {
    const store = await loadFreshStore();
    const set: SetDefinition = {
      id: 'test_set', name: 'Test Set', itemIds: ['some_item'],
      breakpoints: [{ piecesRequired: 1, bonuses: { grantedSkillIds: ['knight_bash'] } }],
    };
    const added = await store.addOrUpdateSet(set);
    expect(added.success).toBe(true);

    const blocked = await store.deleteSkill('knight_bash');
    expect(blocked.success).toBe(false);
    expect(blocked.error).toContain('Test Set');

    await store.deleteSet('test_set');
    const allowed = await store.deleteSkill('knight_bash');
    expect(allowed.success).toBe(true);
  });
});
