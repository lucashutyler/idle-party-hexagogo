import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { suggestMonsterStats } from '@idle-party-rpg/shared';
import type { DungeonFloor, EncounterDefinition, MonsterDefinition } from '@idle-party-rpg/shared';
import {
  checkpointEncounterProblems,
  checkpointEncounterWarnings,
  floorCheckpointProblems,
  monsterScalingProblems,
} from '../src/admin/contentChecks.js';

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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-authoring-checks-'));
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

function monster(overrides: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return {
    id: 'm1',
    name: 'M1',
    hp: 40,
    damage: 2,
    damageType: 'physical',
    xp: 1,
    goldMin: 0,
    goldMax: 1,
    ...overrides,
  };
}

function floor(overrides: Partial<DungeonFloor> = {}): DungeonFloor {
  return { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'court', weight: 1 }], ...overrides };
}

async function validate(mutate: (snapshot: ContentSnapshot) => void): Promise<{ problems: string[]; info: string[] }> {
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
  const snapshot = contentStore.toSnapshot();
  mutate(snapshot);
  const version = await versionStore.createDraft('authoring draft', null, snapshot);
  const result = await validateDraft(deps, version.id);
  expect(result.error).toBeUndefined();
  return { problems: result.problems ?? [], info: result.info ?? [] };
}

describe('monsterScalingProblems', () => {
  it('accepts no level, whole levels 1-200, known tiers and in-range enrage', () => {
    expect(monsterScalingProblems(monster())).toEqual([]);
    expect(monsterScalingProblems(monster({ level: 1, tier: 'trash' }))).toEqual([]);
    expect(monsterScalingProblems(monster({
      level: 200,
      tier: 'raid',
      enrage: { afterSeconds: 3600, stepSeconds: 60, stepPercent: 0.05, maxStacks: 10 },
    }))).toEqual([]);
  });

  it.each([0, 201, 2.5, Number.NaN, '7'])('rejects level %s', level => {
    const problems = monsterScalingProblems(monster({ level: level as number }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('level must be a whole number from 1 to 200');
  });

  it('rejects an unknown tier', () => {
    const problems = monsterScalingProblems(monster({ tier: 'mythic' as MonsterDefinition['tier'] }));
    expect(problems[0]).toContain('tier must be one of trash, elite, boss, raid');
  });

  it('requires enrage.afterSeconds and range-checks the optional fields', () => {
    const missing = monsterScalingProblems(monster({ enrage: { stepPercent: 0.2 } as MonsterDefinition['enrage'] }));
    expect(missing.some(p => p.includes('enrage.afterSeconds'))).toBe(true);

    const bad = monsterScalingProblems(monster({
      enrage: { afterSeconds: -1, stepSeconds: 0, stepPercent: 10, maxStacks: 2.5 },
    }));
    expect(bad).toHaveLength(4);
    expect(monsterScalingProblems(monster({ enrage: 'soon' as unknown as MonsterDefinition['enrage'] }))[0])
      .toContain('enrage must be an object');
  });
});

describe('floorCheckpointProblems', () => {
  it('accepts descending fractions in (0,1) with in-range wipes and reward share', () => {
    expect(floorCheckpointProblems(floor({ checkpoints: [0.66, 0.33], maxWipes: 0, checkpointRewardFraction: 1 }), 'F')).toEqual([]);
  });

  it.each([
    [[0.33, 0.66]],
    [[0.5, 0.5]],
    [[1, 0.5]],
    [[0.5, 0]],
    [['0.5']],
  ])('rejects checkpoints %j', checkpoints => {
    const problems = floorCheckpointProblems(floor({ checkpoints: checkpoints as number[] }), 'F');
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('descending order');
  });

  it('rejects maxWipes and checkpointRewardFraction out of range', () => {
    const problems = floorCheckpointProblems(floor({ maxWipes: 1.5, checkpointRewardFraction: 1.2 }), 'F');
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('maxWipes');
    expect(problems[1]).toContain('checkpointRewardFraction');
  });
});

describe('checkpoint floor encounters', () => {
  const boss = monster({ id: 'boss', tier: 'boss' });
  const wall = monster({ id: 'wall', tier: 'boss', passive: true });
  const add = monster({ id: 'add' });
  const monsters = new Map([[boss.id, boss], [wall.id, wall], [add.id, add]]);
  const court: EncounterDefinition = {
    id: 'court', name: 'Court', type: 'explicit',
    placements: [{ monsterId: 'boss', gridPosition: 4 }, { monsterId: 'add', gridPosition: 1 }],
  };
  const adds: EncounterDefinition = { id: 'adds', name: 'Adds', type: 'explicit', placements: [{ monsterId: 'add', gridPosition: 4 }] };
  const table = (...ids: string[]) => ids.map(encounterId => ({ encounterId, weight: 1 }));
  const check = (f: DungeonFloor, encounters: EncounterDefinition[]) => {
    const byId = new Map(encounters.map(e => [e.id, e]));
    return { problems: checkpointEncounterProblems(f, 'F', byId, monsters), warnings: checkpointEncounterWarnings(f, 'F', byId, monsters) };
  };

  it('is silent without checkpoints and when every encounter places a boss', () => {
    expect(check(floor({ encounterTable: table('adds') }), [adds])).toEqual({ problems: [], warnings: [] });
    expect(check(floor({ checkpoints: [0.5], encounterTable: table('court') }), [court])).toEqual({ problems: [], warnings: [] });
  });

  it('accepts a random pool that always rolls its boss, as the engine does', () => {
    const random: EncounterDefinition = { id: 'court', name: 'Court', type: 'random', monsterPool: [{ monsterId: 'boss', min: 1, max: 2 }] };
    expect(check(floor({ checkpoints: [0.5], encounterTable: table('court') }), [random])).toEqual({ problems: [], warnings: [] });
  });

  it('only warns about encounters that can come without a boss when another one can field it', () => {
    const maybe: EncounterDefinition = { id: 'maybe', name: 'Maybe', type: 'random', monsterPool: [{ monsterId: 'boss', min: 0, max: 1 }] };
    const { problems, warnings } = check(floor({ checkpoints: [0.5], encounterTable: table('court', 'adds', 'maybe') }), [court, adds, maybe]);
    expect(problems).toEqual([]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("encounter 'adds' has no boss- or raid-tier monster");
    expect(warnings[1]).toContain("random encounter 'maybe' doesn't always roll a boss");
  });

  it('reports a problem when nothing on the floor can field a boss, counting passive walls out', () => {
    const walled: EncounterDefinition = { id: 'walled', name: 'Walled', type: 'explicit', placements: [{ monsterId: 'wall', gridPosition: 4 }] };
    for (const [f, encounters] of [
      [floor({ checkpoints: [0.5], encounterTable: table('adds') }), [adds]],
      [floor({ checkpoints: [0.5], encounterTable: table('walled') }), [walled]],
      [floor({ checkpoints: [0.5], encounterTable: [] }), []],
    ] as [DungeonFloor, EncounterDefinition[]][]) {
      const { problems, warnings } = check(f, encounters);
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain('no encounter on its table can field a non-passive boss- or raid-tier monster');
      expect(warnings).toEqual([]);
    }
  });
});

describe('validateDraft — levels, tiers and checkpoints', () => {
  it('passes the seed content and reports unauthored levels as info, not problems', async () => {
    const { problems, info } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'unleveled_a' }), monster({ id: 'unleveled_b' }));
    });
    expect(problems).toEqual([]);
    const line = info.find(i => i.startsWith('No level scaling for'));
    expect(line).toBeDefined();
    expect(line).toContain('unleveled_a');
    expect(line).toContain('unleveled_b');
    expect(line).not.toMatch(/~?L\d/);
  });

  it('skips passive walls in the unauthored-level info line', async () => {
    const { info } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'unleveled_wall', passive: true }));
    });
    expect(info.join('\n')).not.toContain('unleveled_wall');
  });

  it('reports an out-of-range level and a bad tier as problems', async () => {
    const { problems } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'too_high', level: 250 }), monster({ id: 'odd_tier', tier: 'legend' as MonsterDefinition['tier'] }));
    });
    expect(problems.some(p => p.includes("Monster 'too_high' level"))).toBe(true);
    expect(problems.some(p => p.includes("Monster 'odd_tier' tier"))).toBe(true);
  });

  it('suggests a tier for an untiered monster with boss-sized HP', async () => {
    const stats = suggestMonsterStats(10, 'boss');
    const { info } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'big_one', level: 10, ...stats }));
    });
    expect(info.some(i => i.includes("'big_one'") && i.includes("'boss'"))).toBe(true);
  });

  it('flags checkpoint floors that can never field a boss, and inert wipe settings', async () => {
    const { problems, info } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'plain' }));
      snapshot.encounters!.push({ id: 'plain_court', name: 'Plain Court', type: 'explicit', placements: [{ monsterId: 'plain', gridPosition: 4 }] });
      snapshot.dungeons!.push({
        id: 'test_dungeon',
        name: 'Test Dungeon',
        floors: [
          floor({ encounterTable: [{ encounterId: 'plain_court', weight: 1 }], checkpoints: [0.4, 0.6] }),
          floor({ floorNumber: 2, encounterTable: [{ encounterId: 'plain_court', weight: 1 }], maxWipes: 2 }),
        ],
      });
    });
    expect(problems.some(p => p.includes("'test_dungeon' floor 0") && p.includes('descending order'))).toBe(true);
    expect(problems.some(p => p.includes("'test_dungeon' floor 0") && p.includes('no encounter on its table can field'))).toBe(true);
    expect(info.some(i => i.includes("'test_dungeon' floor 1") && i.includes('maxWipes'))).toBe(true);
  });

  it('reports boss-optional encounters on a checkpoint floor as info, not problems', async () => {
    const { problems, info } = await validate(snapshot => {
      snapshot.monsters.push(monster({ id: 'plain' }), monster({ id: 'warden', tier: 'boss' }));
      snapshot.encounters!.push(
        { id: 'warden_pack', name: 'Warden Pack', type: 'random', monsterPool: [{ monsterId: 'warden', min: 0, max: 1 }, { monsterId: 'plain', min: 1, max: 2 }] },
        { id: 'plain_court', name: 'Plain Court', type: 'explicit', placements: [{ monsterId: 'plain', gridPosition: 4 }] },
      );
      snapshot.dungeons!.push({
        id: 'test_dungeon',
        name: 'Test Dungeon',
        floors: [floor({ encounterTable: [{ encounterId: 'warden_pack', weight: 2 }, { encounterId: 'plain_court', weight: 1 }], checkpoints: [0.5] })],
      });
    });
    expect(problems.filter(p => p.includes("'test_dungeon'"))).toEqual([]);
    expect(info.filter(i => i.includes("'test_dungeon' floor 0"))).toEqual([
      "Dungeon 'test_dungeon' floor 0 (floorNumber 1): random encounter 'warden_pack' doesn't always roll a boss; fights without one get no checkpoints.",
      "Dungeon 'test_dungeon' floor 0 (floorNumber 1): encounter 'plain_court' has no boss- or raid-tier monster, so its fights get no checkpoints (a wipe there still uses up a retry).",
    ]);
  });
});

describe('get_content_schema — authoring references', () => {
  it('explains that an unset level means no level scaling and ships worked stat templates', async () => {
    const result = await getContentSchema({ type: 'monsters' }) as {
      description: string;
      levelScaling: { levels: { unset: string }; statTemplates: { examples: { level: number; boss: unknown }[] }; mastery: unknown };
    };
    expect(result.description).toContain('NO LEVEL = NO LEVEL SCALING');
    expect(result.levelScaling.levels.unset).toContain('no level scaling');
    expect(result.levelScaling.mastery).toBeDefined();
    const l10 = result.levelScaling.statTemplates.examples.find(e => e.level === 10);
    expect(l10?.boss).toEqual(suggestMonsterStats(10, 'boss'));
  });

  it('documents checkpoint defaults for dungeons', async () => {
    const result = await getContentSchema({ type: 'dungeons' }) as {
      description: string;
      checkpointDefaults: { maxWipes: { default: number }; checkpointRewardFraction: { default: number } };
    };
    expect(result.description).toContain('BOSS CHECKPOINTS');
    expect(result.checkpointDefaults.maxWipes.default).toBe(3);
    expect(result.checkpointDefaults.checkpointRewardFraction.default).toBe(0.15);
  });
});
