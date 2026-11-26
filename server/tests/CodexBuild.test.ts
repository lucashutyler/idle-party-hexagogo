import { describe, it, expect } from 'vitest';
import { deflateRawSync } from 'zlib';
import type { CodexSaveData, EncounterDefinition, MonsterDefinition, ServerCodexMessage, ShopDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';
import { CodexKnowledge } from '../src/game/codex/CodexKnowledge.js';
import { buildCodexMessage, codexContentIndex } from '../src/game/codex/CodexBuild.js';
import type { CodexContent } from '../src/game/codex/CodexBuild.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { codexContent, codexGrid, codexWorld, expectOnlyDiscovered } from './codexFixture.js';
import type { CodexTestContent, CodexWorld } from './codexFixture.js';
import { room } from './recapFixture.js';
import { wrapGrids } from './testGrids.js';

const ALL_ROOMS = ['field', 'mill', 'den', 'gate', 'pond', 'ridge'];

function build(content: CodexContent, save: CodexSaveData, unlocked: readonly string[] = ALL_ROOMS, kills: Record<string, number> = {}): { reply: ServerCodexMessage; knowledge: CodexKnowledge } {
  const knowledge = CodexKnowledge.fromSave(save);
  return { reply: buildCodexMessage({ knowledge, unlocked, kills, version: 'v1' }, content), knowledge };
}

describe('Codex reply secrecy', () => {
  const states: [string, CodexSaveData, string[]][] = [
    ['empty', {}, ['field']],
    ['a first fight', { monsters: ['goblin'], encounters: ['goblins'] }, ['field', 'mill', 'gate']],
    ['a shop visit', { monsters: ['goblin', 'wolf'], encounters: ['goblins', 'wolves'], shops: ['mill_post'], items: ['ear'] }, ['field', 'mill']],
    ['a dungeon', { monsters: ['bat', 'goblin'], dungeons: ['damp_cave'], items: ['gem'], recent: [{ kind: 'item', id: 'gem' }, { kind: 'monster', id: 'bat' }] }, ALL_ROOMS],
    ['everything', {
      monsters: ['goblin', 'wolf', 'bear', 'shaman', 'toad', 'ghost', 'bat', 'cave_boss', 'wall', 'ghoul'],
      encounters: ['goblins', 'wolves', 'bears', 'camp', 'toads', 'ghosts', 'cave_bats', 'boss_room'],
      items: ['ear', 'pelt', 'fang', 'never', 'rope', 'lamp', 'gem', 'crown', 'sword', 'charm', 'herb', 'tonic'],
      shops: ['mill_post', 'gate_stall'],
      dungeons: ['damp_cave'],
      drops: { wolf: { pelt: 9, fang: 2 }, goblin: { ear: 4 } },
      recent: [{ kind: 'monster', id: 'ghoul' }, { kind: 'shop', id: 'gate_stall' }, { kind: 'item', id: 'tonic' }],
    }, ALL_ROOMS],
    ['ids that do not hold together', {
      monsters: ['goblin', 'ghost_monster'],
      encounters: ['camp', 'ghost_encounter'],
      items: ['ghost_item'],
      shops: ['ghost_shop'],
      dungeons: ['ghost_dungeon'],
      drops: { goblin: { ear: 3, ghost_item: 1 }, shaman: { rope: 2 }, ghost_monster: { pelt: 1 } },
      recent: [{ kind: 'monster', id: 'shaman' }, { kind: 'item', id: 'pelt' }, { kind: 'shop', id: 'mill_post' }, { kind: 'monster', id: 'ghost_monster' }],
    }, ['ridge', 'pond', 'nowhere']],
  ];

  for (const [name, save, unlocked] of states) {
    it(`holds only discovered facts: ${name}`, () => {
      const content = codexContent();
      const kills = { goblin: 3, wolf: 1, ghost_monster: 2 };
      const { reply, knowledge } = build(content, save, unlocked, kills);
      expectOnlyDiscovered(reply, knowledge, content, unlocked, kills);
    });
  }

  it('never names a monster the player has not met, even in fights and tables', () => {
    const { reply } = build(codexContent(), { monsters: ['goblin'], encounters: ['camp', 'goblins'] }, ['ridge', 'field']);
    expect(reply.fights).toEqual([['goblin']]);
    expect(reply.tables).toEqual([
      { key: 'z:pines', monsters: ['goblin'], fights: [0] },
      { key: 'z:meadow', monsters: ['goblin'], fights: [0] },
    ]);
    expect(JSON.stringify(reply)).not.toContain('shaman');
  });

  it('leaves unmet monsters out of dungeons', () => {
    const { reply } = build(codexContent(), { monsters: ['bat'], dungeons: ['damp_cave'] });
    expect(reply.dungeons).toEqual([{ id: 'damp_cave', monsters: ['bat'] }]);
  });
});

describe('Codex tables', () => {
  it('shows a table only for found, walkable rooms; a room with its own table gets its own key', () => {
    const save = { monsters: ['goblin', 'bear', 'toad'], encounters: ['bears', 'toads'] };
    expect(build(codexContent(), save, ['den']).reply.tables).toEqual([{ key: 'r:den', monsters: ['bear'], fights: [0] }]);
    expect(build(codexContent(), save, ['pond']).reply.tables).toEqual([]);
    expect(build(codexContent(), save, ['unknown_room']).reply.tables).toEqual([]);
  });

  it('keeps a table that has met monsters but no fought encounter', () => {
    const { reply } = build(codexContent(), { monsters: ['wolf'] }, ['field']);
    expect(reply.tables).toEqual([{ key: 'z:meadow', monsters: ['wolf'], fights: [] }]);
    expect(reply.fights).toEqual([]);
  });

  it('shows a fought encounter on every found room whose table rolls it, and drops it once the table no longer does', () => {
    const world = codexWorld();
    world.zones.pines.encounterTable.push({ encounterId: 'wolves', weight: 1 });
    const content = codexContent(world);
    const save = { monsters: ['wolf', 'goblin'], encounters: ['wolves'] };

    expect(build(content, save, ['field', 'ridge']).reply.tables).toEqual([
      { key: 'z:meadow', monsters: ['goblin', 'wolf'], fights: [0] },
      { key: 'z:pines', monsters: ['goblin', 'wolf'], fights: [0] },
    ]);

    world.zones.pines.encounterTable = [{ encounterId: 'camp', weight: 1 }];
    content.contentEpoch++;
    expect(build(content, save, ['field', 'ridge']).reply.tables).toEqual([
      { key: 'z:meadow', monsters: ['goblin', 'wolf'], fights: [0] },
      { key: 'z:pines', monsters: ['goblin'], fights: [] },
    ]);
  });

  it('never lists an encounter that only weighs nothing', () => {
    const { reply } = build(codexContent(), { monsters: ['ghost'], encounters: ['ghosts'] }, ['field']);
    expect(reply.tables).toEqual([]);
  });

  it('merges fights with the same met monsters', () => {
    const world = codexWorld();
    world.zones.meadow.encounterTable.push({ encounterId: 'camp', weight: 1 });
    const { reply } = build(codexContent(world), { monsters: ['goblin'], encounters: ['goblins', 'camp'] }, ['field']);
    expect(reply.fights).toEqual([['goblin']]);
    expect(reply.tables).toEqual([{ key: 'z:meadow', monsters: ['goblin'], fights: [0] }]);
  });
});

describe('Codex monsters, items and shops', () => {
  it('describes a met monster from current content, with kills, drops by tally and drop kinds', () => {
    const { reply } = build(codexContent(), {
      monsters: ['wolf', 'cave_boss', 'wall'],
      items: ['pelt', 'fang'],
      drops: { wolf: { pelt: 1, fang: 3 } },
    }, ALL_ROOMS, { wolf: 12, cave_boss: 0 });

    expect(reply.monsters).toEqual([
      { id: 'wolf', name: 'Wolf', tier: 'trash', kills: 12, drops: [{ itemId: 'fang', seen: 3 }, { itemId: 'pelt', seen: 1 }], dropKinds: 2 },
      { id: 'cave_boss', name: 'Cave King', tier: 'boss', level: 200, description: 'Rules the damp dark.', kills: 0, drops: [], dropKinds: 0 },
      { id: 'wall', name: 'Old Wall', tier: 'trash', passive: true, kills: 0, drops: [], dropKinds: 0 },
    ]);
  });

  it('reads kills as own keys only', () => {
    const kills = Object.create({ wolf: 5 }) as Record<string, number>;
    expect(build(codexContent(), { monsters: ['wolf'] }, ALL_ROOMS, kills).reply.monsters[0].kills).toBe(0);
  });

  it('shows a visited shop\'s stock and hires, skipping what no longer exists', () => {
    const { reply } = build(codexContent(), { shops: ['mill_post'], items: ['ear', 'pelt'] });
    expect(reply.shops).toEqual([{
      id: 'mill_post',
      name: 'Mill Trading Post',
      stock: [{ itemId: 'pelt', price: 5 }, { itemId: 'rope', price: 2 }],
      hires: [{ name: 'Grim', emoji: '🗡️', level: 8 }],
    }]);
    expect(reply.items.map(i => [i.def.id, i.found])).toEqual([['ear', true], ['pelt', true], ['rope', false]]);
  });

  it('skips dangling monsters, items, shops, dungeons and encounters', () => {
    const { reply } = build(codexContent(), {
      monsters: ['ghost_monster'],
      items: ['ghost_item'],
      shops: ['ghost_shop'],
      dungeons: ['ghost_dungeon'],
      encounters: ['ghost_encounter'],
      recent: [{ kind: 'monster', id: 'ghost_monster' }, { kind: 'item', id: 'ghost_item' }, { kind: 'shop', id: 'ghost_shop' }],
    });
    expect(reply).toEqual({ type: 'codex', version: 'v1', monsters: [], items: [], shops: [], fights: [], tables: [], dungeons: [], recent: [] });
  });

  it('keeps recent refs whose targets are in the reply, in order', () => {
    const { reply } = build(codexContent(), {
      monsters: ['wolf'],
      items: ['pelt'],
      shops: ['gate_stall'],
      recent: [{ kind: 'shop', id: 'gate_stall' }, { kind: 'item', id: 'lamp' }, { kind: 'item', id: 'pelt' }, { kind: 'monster', id: 'bear' }, { kind: 'monster', id: 'wolf' }],
    });
    expect(reply.recent).toEqual([{ kind: 'shop', id: 'gate_stall' }, { kind: 'item', id: 'pelt' }, { kind: 'monster', id: 'wolf' }]);
  });
});

describe('Codex content index', () => {
  it('is rebuilt when the content epoch moves, and only then', () => {
    const world = codexWorld();
    const content = codexContent(world);
    const first = codexContentIndex(content);
    expect(codexContentIndex(content)).toBe(first);

    world.encounters.bears.placements = [{ monsterId: 'wolf', gridPosition: 4 }];
    expect(codexContentIndex(content).encounterMonsters.get('bears')).toEqual(['bear']);

    content.contentEpoch++;
    const second = codexContentIndex(content);
    expect(second).not.toBe(first);
    expect(second.encounterMonsters.get('bears')).toEqual(['wolf']);
  });

  it('maps walkable rooms to their table and dungeons to what their floors spawn', () => {
    const index = codexContentIndex(codexContent());
    expect([...index.roomTable]).toEqual([['field', 'z:meadow'], ['mill', 'z:meadow'], ['den', 'r:den'], ['gate', 'z:meadow'], ['ridge', 'z:pines']]);
    expect(index.tables.get('z:meadow')).toEqual({ spawns: ['goblin', 'wolf'], encounters: ['goblins', 'wolves'] });
    expect([...index.dungeonSpawns]).toEqual([['damp_cave', ['bat', 'cave_boss']]]);
  });

  it('gives a floor with an empty table what its entrance rooms\' zone tables roll, not the rooms\' own tables', () => {
    const world = codexWorld();
    world.dungeons.damp_cave.floors[0].encounterTable = [];
    const gate = world.tiles.find(t => t.id === 'gate')!;
    gate.encounterTable = [{ encounterId: 'bears', weight: 1 }];
    world.tiles.push(room('back_gate', 0, 2, { zone: 'pines', dungeonId: 'damp_cave' }));

    expect(codexContentIndex(codexContent(world)).dungeonSpawns.get('damp_cave')).toEqual(['goblin', 'wolf', 'shaman', 'cave_boss', 'bat']);
  });

  it('gives a floor with an empty table the fallback monster only when the entrance zone\'s table is empty too', () => {
    const world = codexWorld();
    world.dungeons.damp_cave.floors[0].encounterTable = [];
    world.dungeons.damp_cave.floors[1].encounterTable = [];
    world.zones.meadow.encounterTable = [];

    expect(codexContentIndex(codexContent(world)).dungeonSpawns.get('damp_cave')).toEqual(['goblin']);
  });
});

describe('Codex reply from a session', () => {
  it('carries the version the state push carries', () => {
    const content = codexContent();
    const session = new PlayerSession('alice', wrapGrids(codexGrid(content)), content);
    session.setClass('Knight');
    session.noteCodexFight([{ id: 'wolf', name: 'Wolf' }], { kind: 'room', encounterId: 'wolves' });

    const reply = session.buildCodex();

    expect(reply.version).toBe(session.getState([]).character!.codexVersion);
    expect(reply.monsters.map(m => m.id)).toEqual(['wolf']);
    expect(reply.tables).toEqual([{ key: 'z:meadow', monsters: ['wolf'], fights: [0] }]);
  });
});

/** A large invented world where the player has found everything. */
function largeWorld(): { content: CodexTestContent; save: CodexSaveData; unlocked: string[] } {
  const world: CodexWorld = codexWorld();
  const pad = (kind: string, i: number) => `${kind}-${String(i).padStart(5, '0')}`.padEnd(36, '0');
  const monsters: Record<string, MonsterDefinition> = {};
  for (let i = 0; i < 250; i++) {
    monsters[pad('m', i)] = {
      id: pad('m', i), name: `Monster ${i}`, hp: 10, damage: 1, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0, level: 1 + (i % 60),
      description: 'A creature of the invented test world, described in a sentence of ordinary length.',
      drops: Array.from({ length: 5 }, (_, d) => ({ itemId: pad('i', (i * 5 + d) % 800), chance: 0.2 })),
    };
  }
  const items = Object.fromEntries(Array.from({ length: 800 }, (_, i) => [pad('i', i), {
    id: pad('i', i), name: `Item ${i}`, rarity: 'common' as const, value: i, description: 'An invented item with a short description.',
  }]));
  const encounters: Record<string, EncounterDefinition> = {};
  for (let i = 0; i < 400; i++) {
    encounters[pad('e', i)] = { id: pad('e', i), name: `Pack ${i}`, type: 'random', monsterPool: [0, 1, 2].map(k => ({ monsterId: pad('m', (i + k * 7) % 250), min: 1, max: 2 })) };
  }
  const zoneIds = Array.from({ length: 100 }, (_, i) => pad('z', i));
  for (const [i, zoneId] of zoneIds.entries()) {
    world.zones[zoneId] = { id: zoneId, displayName: `Zone ${i}`, encounterTable: [0, 1, 2, 3].map(k => ({ encounterId: pad('e', (i * 4 + k) % 400), weight: 1 })), levelRange: [1, 2] };
  }
  const tiles: WorldTileDefinition[] = Array.from({ length: 10000 }, (_, i) => room(pad('r', i), i % 100, Math.floor(i / 100), {
    zone: zoneIds[i % 100],
    ...(i % 20 === 0 ? { encounterTable: [{ encounterId: pad('e', i % 400), weight: 1 }] } : {}),
  }));
  const shops: Record<string, ShopDefinition> = {};
  for (let i = 0; i < 40; i++) shops[pad('s', i)] = { id: pad('s', i), name: `Shop ${i}`, inventory: Array.from({ length: 12 }, (_, k) => ({ itemId: pad('i', (i * 12 + k) % 800), price: k + 1 })), henchmanIds: ['grim'] };
  Object.assign(world, { tiles, monsters: { ...world.monsters, ...monsters }, items: { ...world.items, ...items }, encounters: { ...world.encounters, ...encounters }, shops: { ...world.shops, ...shops } });
  const save: CodexSaveData = {
    monsters: Object.keys(monsters),
    encounters: Object.keys(encounters),
    items: Object.keys(items),
    shops: Object.keys(shops),
    drops: Object.fromEntries(Object.values(monsters).map(m => [m.id, Object.fromEntries(m.drops!.map(d => [d.itemId, 7]))])),
  };
  return { content: codexContent(world), save, unlocked: tiles.map(t => t.id) };
}

describe('Codex reply size', () => {
  it('stays bounded for a player who has found everything in a large world, and compresses well', () => {
    const { content, save, unlocked } = largeWorld();
    const { reply, knowledge } = build(content, save, unlocked);
    const json = JSON.stringify(reply);
    const compressed = deflateRawSync(Buffer.from(json), { level: 3, memLevel: 7 }).length;

    expectOnlyDiscovered(reply, knowledge, content, unlocked);
    expect(reply.monsters).toHaveLength(250);
    expect(json.length).toBeLessThan(512 * 1024);
    expect(compressed).toBeLessThan(json.length / 4);
  });
});
