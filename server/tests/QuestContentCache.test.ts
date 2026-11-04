import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { NpcDefinition, QuestDefinition } from '@idle-party-rpg/shared';

// ContentStore resolves its data dir from process.cwd() at module load, so chdir before the dynamic import.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;

let ContentStore: ContentStoreCtor;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'quest-content-cache-'));
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

function npc(id: string, questIds: string[]): NpcDefinition {
  return { id, name: id, emoji: '🙂', greeting: '', questIds };
}

function quest(id: string): QuestDefinition {
  return { id, name: id, description: '', scope: 'party_shared', objectives: [], rewards: [] };
}

describe('ContentStore quest caches', () => {
  it('lists every offered quest id once and reuses the list until something changes', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateNpc(npc('a', ['q1', 'q2']));
    await store.addOrUpdateNpc(npc('b', ['q2', 'q3']));

    const ids = store.getNpcQuestIds();
    expect([...ids].sort()).toEqual(expect.arrayContaining(['q1', 'q2', 'q3']));
    expect(ids.filter(id => id === 'q2')).toHaveLength(1);
    expect(store.getNpcQuestIds()).toBe(ids);
  });

  it('bumps the revision and rebuilds on every NPC and quest change', async () => {
    const store = await loadFreshStore();
    const revisions = [store.getQuestRevision()];
    const snapshot = () => {
      revisions.push(store.getQuestRevision());
      return { ids: store.getNpcQuestIds(), catalog: store.getQuestCatalog() };
    };

    await store.addOrUpdateQuest(quest('q1'));
    const afterQuest = snapshot();
    expect(afterQuest.catalog.q1).toBeDefined();
    expect(store.getQuestCatalog()).toBe(afterQuest.catalog);

    await store.addOrUpdateNpc(npc('a', ['q1']));
    expect(snapshot().ids).toContain('q1');

    expect((await store.deleteNpc('a')).success).toBe(true);
    expect(snapshot().ids).not.toContain('q1');

    expect((await store.deleteQuest('q1')).success).toBe(true);
    expect(snapshot().catalog.q1).toBeUndefined();

    await store.replaceAll({ ...store.toSnapshot(), npcs: [npc('z', ['q9'])], quests: [quest('q9')] });
    const afterDeploy = snapshot();
    expect(afterDeploy.ids).toEqual(['q9']);
    expect(Object.keys(afterDeploy.catalog)).toEqual(['q9']);

    for (let i = 1; i < revisions.length; i++) expect(revisions[i]).toBeGreaterThan(revisions[i - 1]);
  });

  it('keeps the revision when a refused delete changes nothing', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateQuest(quest('q1'));
    await store.addOrUpdateNpc(npc('a', ['q1']));
    const revision = store.getQuestRevision();

    expect((await store.deleteQuest('q1')).success).toBe(false);
    expect((await store.deleteNpc('missing')).success).toBe(false);
    expect(store.getQuestRevision()).toBe(revision);
  });
});
