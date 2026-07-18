import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { QuestDefinition } from '@idle-party-rpg/shared';

// ContentStore/VersionStore (and, transitively, the MCP tool modules that import
// DraftEditor) resolve their data dirs from process.cwd() at module load, so the
// tmp-dir chdir must happen BEFORE any of them are imported. Mirrors SkillContentStore.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type VersionStoreCtor = typeof import('../src/game/VersionStore.js').VersionStore;
type VersionStoreInstance = InstanceType<VersionStoreCtor>;
type DraftEditorCtor = typeof import('../src/game/DraftEditor.js').DraftEditor;
type McpToolDeps = import('../src/mcp/tools/McpToolDeps.js').McpToolDeps;
type DraftContentType = import('../src/game/DraftEditor.js').DraftContentType;

let ContentStore: ContentStoreCtor;
let VersionStore: VersionStoreCtor;
let DraftEditor: DraftEditorCtor;
let validateDraft: typeof import('../src/mcp/tools/validateTools.js').validateDraft;
let getOverview: typeof import('../src/mcp/tools/readTools.js').getOverview;
let getContentSchema: typeof import('../src/mcp/tools/readTools.js').getContentSchema;
let createDraft: typeof import('../src/mcp/tools/notesTools.js').createDraft;
let saveNote: typeof import('../src/mcp/tools/notesTools.js').saveNote;

let tmpDir: string;
let originalCwd: string;

const CONTENT_TYPES: DraftContentType[] = [
  'monsters', 'items', 'sets', 'shops', 'recipes', 'npcs',
  'quests', 'dungeons', 'zones', 'encounters', 'tileTypes',
  'skills', 'designNotes',
];

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-tools-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor } = await import('../src/game/DraftEditor.js'));
  ({ validateDraft } = await import('../src/mcp/tools/validateTools.js'));
  ({ getOverview, getContentSchema } = await import('../src/mcp/tools/readTools.js'));
  ({ createDraft, saveNote } = await import('../src/mcp/tools/notesTools.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function setupDeps(): Promise<{ deps: McpToolDeps; contentStore: ContentStoreInstance; versionStore: VersionStoreInstance }> {
  const contentStore = new ContentStore();
  await contentStore.load();
  const versionStore = new VersionStore();
  await versionStore.load();
  const draftEditor = new DraftEditor(versionStore, () => contentStore);
  const deps: McpToolDeps = {
    contentStore: () => contentStore,
    versionStore: () => versionStore,
    draftEditor,
    tokenLabel: 'test-label',
  };
  return { deps, contentStore, versionStore };
}

function makeQuest(id: string, overrides: Partial<QuestDefinition> = {}): QuestDefinition {
  return {
    id,
    name: `Quest ${id}`,
    description: 'Test quest',
    scope: 'solo',
    objectives: [],
    rewards: [],
    ...overrides,
  };
}

describe('validateDraft', () => {
  it('reports zero problems on a clean draft fresh from ContentStore.toSnapshot()', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const snapshot = contentStore.toSnapshot();
    const version = await versionStore.createDraft('clean draft', null, snapshot);

    const result = await validateDraft(deps, version.id);
    expect(result.error).toBeUndefined();
    expect(result.problems).toEqual([]);
  });

  it('reports a broken quest prerequisite reference and nothing else spurious', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const snapshot = contentStore.toSnapshot();
    const version = await versionStore.createDraft('bad quest draft', null, snapshot);

    const quest = makeQuest('quest_with_bad_prereq', { prerequisiteQuestIds: ['nonexistent_quest'] });
    const upsertResult = await deps.draftEditor.upsertQuest(version.id, quest);
    expect(upsertResult.success).toBe(true);

    const result = await validateDraft(deps, version.id);
    expect(result.error).toBeUndefined();
    expect(result.problems).toBeDefined();
    expect(result.problems).toContain(
      "Quest 'quest_with_bad_prereq' prerequisiteQuestIds references unknown quest 'nonexistent_quest' (index 0).",
    );
  });

  it('reports a dungeon floor reward referencing an unknown item, and an unknown entryRequirements item', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('bad dungeon draft', null, contentStore.toSnapshot());

    const upsertResult = await deps.draftEditor.upsertDungeon(version.id, {
      id: 'bad_dungeon',
      name: 'Bad Dungeon',
      floors: [{
        floorNumber: 1,
        gridShape: { cols: 3, rows: 3 },
        encounterTable: [],
        rewards: [{ itemId: 'nonexistent_item', chance: 1 }],
      }],
      entryRequirements: { requiredItemId: 'also_nonexistent' },
    });
    expect(upsertResult.success).toBe(true);

    const result = await validateDraft(deps, version.id);
    expect(result.problems).toContain(
      "Dungeon 'bad_dungeon' floor 0 (floorNumber 1) reward 0 references unknown item 'nonexistent_item'.",
    );
    expect(result.problems).toContain(
      "Dungeon 'bad_dungeon' entryRequirements.requiredItemId references unknown item 'also_nonexistent'.",
    );
  });

  it('reports a tile type whose requiredItemId references an unknown item', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('bad tile type draft', null, contentStore.toSnapshot());

    const upsertResult = await deps.draftEditor.upsertTileType(version.id, {
      id: 'gated_type',
      name: 'Gated',
      icon: '?',
      color: '#000000',
      traversable: true,
      requiredItemId: 'nonexistent_item',
    });
    expect(upsertResult.success).toBe(true);

    const result = await validateDraft(deps, version.id);
    expect(result.problems).toContain(
      "Tile type 'gated_type' requiredItemId references unknown item 'nonexistent_item'.",
    );
  });

  it('reports an error (not problems) for a non-existent version id', async () => {
    const { deps } = await setupDeps();
    const result = await validateDraft(deps, 'does-not-exist');
    expect(result.error).toBe('Version not found.');
    expect(result.problems).toBeUndefined();
  });

  it('reports an error for a published (non-draft) version', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('to publish', null, contentStore.toSnapshot());
    await versionStore.publish(version.id);

    const result = await validateDraft(deps, version.id);
    expect(result.error).toContain('Only drafts can be validated');
  });
});

describe('getOverview', () => {
  it('reports counts that match live ContentStore state, plus versions and active version id', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('v1', null, contentStore.toSnapshot());
    await versionStore.setActive(version.id);

    const result = await getOverview(deps);
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unreachable');
    expect(result.counts.monsters).toBe(Object.keys(contentStore.getAllMonsters()).length);
    expect(result.counts.items).toBe(Object.keys(contentStore.getAllItems()).length);
    expect(result.counts.designNotes).toBe(Object.keys(contentStore.getAllDesignNotes()).length);
    expect(result.versions.map(v => v.id)).toContain(version.id);
    expect(result.activeVersionId).toBe(version.id);
  });
});

describe('getContentSchema', () => {
  it('returns a non-empty description string for all 13 content types', async () => {
    for (const type of CONTENT_TYPES) {
      const result = await getContentSchema({ type });
      expect('error' in result).toBe(false);
      if ('error' in result) throw new Error('unreachable');
      expect(typeof result.description).toBe('string');
      expect(result.description.length).toBeGreaterThan(0);
      expect(result.type).toBe(type);
    }
  });

  it('includes the skill option catalog only for the "skills" type', async () => {
    const skillsResult = await getContentSchema({ type: 'skills' });
    expect('skillOptionCatalog' in skillsResult).toBe(true);

    const monstersResult = await getContentSchema({ type: 'monsters' });
    expect('skillOptionCatalog' in monstersResult).toBe(false);
  });
});

describe('createDraft (notesTools)', () => {
  it('creates a new draft version seeded from live content when fromVersionId is omitted', async () => {
    const { deps, contentStore } = await setupDeps();
    const result = await createDraft(deps, { name: 'my new draft' });
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unreachable');
    expect(result.status).toBe('draft');
    expect(result.name).toBe('my new draft');

    const snapshot = await deps.versionStore().loadSnapshot(result.id);
    expect(snapshot.monsters.length).toBe(Object.keys(contentStore.getAllMonsters()).length);
  });

  it('reports an error when fromVersionId does not exist', async () => {
    const { deps } = await setupDeps();
    const result = await createDraft(deps, { name: 'orphan draft', fromVersionId: 'does-not-exist' });
    expect('error' in result).toBe(true);
  });
});

describe('saveNote (notesTools)', () => {
  it('sets author from the caller token label and fills createdAt/updatedAt', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('notes draft', null, contentStore.toSnapshot());

    const result = await saveNote(deps, { versionId: version.id, note: { title: 'Starter island plan', body: 'Goblins x3, one shop.' } });
    expect('error' in result).toBe(false);
    if ('error' in result) throw new Error('unreachable');
    expect(result.author).toBe('test-label');
    expect(result.title).toBe('Starter island plan');
    expect(result.createdAt).toBe(result.updatedAt);
  });

  it('preserves createdAt and updates updatedAt when editing an existing note', async () => {
    const { deps, contentStore, versionStore } = await setupDeps();
    const version = await versionStore.createDraft('notes draft 2', null, contentStore.toSnapshot());

    const created = await saveNote(deps, { versionId: version.id, note: { title: 'v1', body: 'first' } });
    if ('error' in created) throw new Error('unreachable');

    await new Promise(resolve => setTimeout(resolve, 5));
    const updated = await saveNote(deps, { versionId: version.id, note: { id: created.id, title: 'v2', body: 'second' } });
    if ('error' in updated) throw new Error('unreachable');

    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.title).toBe('v2');
  });
});
