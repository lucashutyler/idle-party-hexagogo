import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import {
  MONSTER_SKILL_CATALOG,
  SKILL_CARD_TYPE_INFO,
  SKILL_TRIGGER_INFO,
} from '@idle-party-rpg/shared';
import type { MonsterDefinition, SkillDefinition } from '@idle-party-rpg/shared';

// ContentStore/VersionStore resolve their data dirs from process.cwd() at module load,
// so the tmp-dir chdir must happen before they are imported (mirrors McpTools.test.ts).
type ContentStoreInstance = InstanceType<typeof import('../src/game/ContentStore.js').ContentStore>;
type VersionStoreInstance = InstanceType<typeof import('../src/game/VersionStore.js').VersionStore>;
type ContentSnapshot = import('../src/game/VersionStore.js').ContentSnapshot;
type McpToolDeps = import('../src/mcp/tools/McpToolDeps.js').McpToolDeps;

let ContentStore: typeof import('../src/game/ContentStore.js').ContentStore;
let VersionStore: typeof import('../src/game/VersionStore.js').VersionStore;
let DraftEditor: typeof import('../src/game/DraftEditor.js').DraftEditor;
let AssetStore: typeof import('../src/game/AssetStore.js').AssetStore;
let validateDraft: typeof import('../src/mcp/tools/validateTools.js').validateDraft;
let getContentSchema: typeof import('../src/mcp/tools/readTools.js').getContentSchema;

let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-monster-validation-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ VersionStore } = await import('../src/game/VersionStore.js'));
  ({ DraftEditor } = await import('../src/game/DraftEditor.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  ({ validateDraft } = await import('../src/mcp/tools/validateTools.js'));
  ({ getContentSchema } = await import('../src/mcp/tools/readTools.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

async function setup(): Promise<{ deps: McpToolDeps; contentStore: ContentStoreInstance; versionStore: VersionStoreInstance }> {
  const contentStore = new ContentStore();
  await contentStore.load();
  const versionStore = new VersionStore();
  await versionStore.load();
  const deps: McpToolDeps = {
    contentStore: () => contentStore,
    versionStore: () => versionStore,
    draftEditor: new DraftEditor(versionStore, () => contentStore),
    assetStore: new AssetStore(),
    callerLabel: 'test-label',
  };
  return { deps, contentStore, versionStore };
}

function makeMonster(overrides: Partial<MonsterDefinition>): MonsterDefinition {
  return {
    id: 'test_caster',
    name: 'Test Caster',
    hp: 10,
    damage: 2,
    damageType: 'magical',
    xp: 1,
    goldMin: 0,
    goldMax: 1,
    ...overrides,
  };
}

async function problemsFor(mutate: (snapshot: ContentSnapshot) => void): Promise<string[]> {
  const { deps, contentStore, versionStore } = await setup();
  const snapshot = contentStore.toSnapshot();
  mutate(snapshot);
  const version = await versionStore.createDraft('validation draft', null, snapshot);
  const result = await validateDraft(deps, version.id);
  expect(result.error).toBeUndefined();
  return result.problems ?? [];
}

describe('validateDraft — monster timing and skills', () => {
  it('accepts a monster with a valid attackInterval, known skills, cooldown 0 and a castTime override', async () => {
    const problems = await problemsFor(snapshot => {
      snapshot.monsters.push(makeMonster({
        attackInterval: 0.3,
        skills: [
          { skillId: 'fireball', value: 4, cooldown: 0, castTime: 2 },
          { skillId: 'heal', value: 6, cooldown: 4.5 },
        ],
      }));
    });
    expect(problems).toEqual([]);
  });

  it('reports an attackInterval below the 0.3 s minimum', async () => {
    const problems = await problemsFor(snapshot => {
      snapshot.monsters.push(makeMonster({ attackInterval: 0.2 }));
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Monster 'test_caster' attackInterval");
    expect(problems[0]).toContain('0.3');
  });

  it('reports a non-numeric attackInterval', async () => {
    const problems = await problemsFor(snapshot => {
      snapshot.monsters.push(makeMonster({ attackInterval: 'fast' as unknown as number }));
    });
    expect(problems.some(p => p.includes('attackInterval'))).toBe(true);
  });

  it('reports a monster skill id missing from the catalog', async () => {
    const problems = await problemsFor(snapshot => {
      snapshot.monsters.push(makeMonster({ skills: [{ skillId: 'meteor', value: 5, cooldown: 3 }] }));
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("Monster 'test_caster' skill 0 references unknown monster skill 'meteor'");
    for (const id of Object.keys(MONSTER_SKILL_CATALOG)) expect(problems[0]).toContain(id);
  });

  it('reports negative monster skill cooldown and castTime', async () => {
    const problems = await problemsFor(snapshot => {
      snapshot.monsters.push(makeMonster({ skills: [{ skillId: 'rot', value: 2, cooldown: -1, castTime: -0.5 }] }));
    });
    expect(problems).toHaveLength(2);
    expect(problems.some(p => p.includes('skill 0 cooldown'))).toBe(true);
    expect(problems.some(p => p.includes('skill 0 castTime'))).toBe(true);
  });
});

describe('validateDraft — skill definitions', () => {
  it('reports a skill that breaks the skill rules (e.g. authored before a rule change)', async () => {
    const badSkill: SkillDefinition = {
      id: 'test_bad_active',
      name: 'Bad Active',
      description: 'No cooldown, and a cast time on a triggered skill.',
      className: 'Knight',
      type: 'active',
      unlockLevel: 5,
      sortOrder: 50,
      trigger: 'self_hit',
      castTime: 1,
      activeEffects: [{ kind: 'high_damage_single', damagePercent: 2 }],
    };
    const problems = await problemsFor(snapshot => {
      snapshot.skills = [...(snapshot.skills ?? []), badSkill];
    });
    expect(problems).toEqual([
      "Skill 'test_bad_active': Active skills require a cooldown of at least 1 second.",
      "Skill 'test_bad_active': Triggered skills cannot have a cast time.",
    ]);
  });
});

describe('getContentSchema — catalogs', () => {
  it('attaches the monster skill catalog for monsters', async () => {
    const result = await getContentSchema({ type: 'monsters' });
    expect('monsterSkillCatalog' in result && result.monsterSkillCatalog).toEqual(MONSTER_SKILL_CATALOG);
    expect('description' in result && result.description).toContain('attackInterval');
  });

  it('attaches the trigger and card-type tables for skills', async () => {
    const result = await getContentSchema({ type: 'skills' });
    expect('skillTriggerInfo' in result && result.skillTriggerInfo).toEqual(SKILL_TRIGGER_INFO);
    expect('skillCardTypeInfo' in result && result.skillCardTypeInfo).toEqual(SKILL_CARD_TYPE_INFO);
    expect('description' in result && result.description).toContain('castTime');
  });
});
