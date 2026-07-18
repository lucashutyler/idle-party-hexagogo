import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { DesignNote } from '@idle-party-rpg/shared';

// ContentStore resolves its data dir from process.cwd() at module load, so the
// tmp-dir chdir must happen BEFORE the module is imported (dynamic import below).
// Mirrors SkillContentStore.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;

let ContentStore: ContentStoreCtor;
let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'design-notes-'));
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

function makeNote(id: string, overrides: Partial<DesignNote> = {}): DesignNote {
  return {
    id,
    title: `Note ${id}`,
    body: `Body for ${id}`,
    author: 'test-author',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('ContentStore design notes', () => {
  it('starts empty on a fresh install (no seed)', async () => {
    const store = await loadFreshStore();
    expect(Object.keys(store.getAllDesignNotes()).length).toBe(0);
  });

  it('round-trips a design note through addOrUpdateDesignNote/getDesignNote/deleteDesignNote', async () => {
    const store = await loadFreshStore();
    const note = makeNote('design_note_1');
    await store.addOrUpdateDesignNote(note);
    expect(store.getDesignNote('design_note_1')).toEqual(note);

    const deleted = await store.deleteDesignNote('design_note_1');
    expect(deleted.success).toBe(true);
    expect(store.getDesignNote('design_note_1')).toBeUndefined();
  });

  it('persists design notes to disk and reloads them', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateDesignNote(makeNote('persisted_note'));

    const reloaded = await loadFreshStore();
    expect(reloaded.getDesignNote('persisted_note')).toEqual(makeNote('persisted_note'));
  });

  it('keeps existing design notes when a snapshot omits designNotes entirely (old snapshot)', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateDesignNote(makeNote('keep_me'));

    const snapshot = store.toSnapshot() as Partial<ReturnType<ContentStoreInstance['toSnapshot']>> & { world: ReturnType<ContentStoreInstance['toSnapshot']>['world'] };
    delete snapshot.designNotes;

    await store.replaceAll(snapshot as Parameters<ContentStoreInstance['replaceAll']>[0]);
    expect(store.getDesignNote('keep_me')).toBeDefined();
  });

  it('clears design notes when a snapshot explicitly ships an empty designNotes array', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateDesignNote(makeNote('clear_me'));

    const snapshot = store.toSnapshot();
    snapshot.designNotes = [];

    await store.replaceAll(snapshot);
    expect(store.getDesignNote('clear_me')).toBeUndefined();
    expect(Object.keys(store.getAllDesignNotes()).length).toBe(0);
  });

  it('round-trips a real edit through toSnapshot/replaceAll', async () => {
    const store = await loadFreshStore();
    await store.addOrUpdateDesignNote(makeNote('editable_note', { title: 'Original' }));
    const snapshot = store.toSnapshot();
    expect(snapshot.designNotes.find(n => n.id === 'editable_note')?.title).toBe('Original');

    await store.addOrUpdateDesignNote(makeNote('editable_note', { title: 'Changed after snapshot' }));
    await store.replaceAll(snapshot);
    expect(store.getDesignNote('editable_note')?.title).toBe('Original');
  });

  it('deleteDesignNote on an unknown id reports failure', async () => {
    const store = await loadFreshStore();
    const result = await store.deleteDesignNote('does_not_exist');
    expect(result.success).toBe(false);
  });
});
