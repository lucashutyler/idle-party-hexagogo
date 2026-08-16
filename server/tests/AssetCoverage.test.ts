import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { MANAGED_ASSET_KINDS } from '@idle-party-rpg/shared';
import type { MonsterDefinition, ZoneDefinition, ItemDefinition, TileTypeDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';

// ContentStore and AssetStore both resolve their folders from process.cwd(), so
// the tmp-dir chdir must happen BEFORE either module is imported (dynamic
// imports below). Mirrors DesignNotes.test.ts / McpTools.test.ts.
type ContentStoreCtor = typeof import('../src/game/ContentStore.js').ContentStore;
type ContentStoreInstance = InstanceType<ContentStoreCtor>;
type AssetStoreCtor = typeof import('../src/game/AssetStore.js').AssetStore;
type AssetStoreInstance = InstanceType<AssetStoreCtor>;
type AssetKindCoverage = import('../src/game/AssetCoverage.js').AssetKindCoverage;

let ContentStore: ContentStoreCtor;
let AssetStore: AssetStoreCtor;
let computeAssetCoverage: typeof import('../src/game/AssetCoverage.js').computeAssetCoverage;

let tmpDir: string;
let originalCwd: string;

beforeAll(async () => {
  originalCwd = process.cwd();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'asset-coverage-'));
  process.chdir(tmpDir);
  ({ ContentStore } = await import('../src/game/ContentStore.js'));
  ({ AssetStore } = await import('../src/game/AssetStore.js'));
  ({ computeAssetCoverage } = await import('../src/game/AssetCoverage.js'));
});

afterAll(async () => {
  process.chdir(originalCwd);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

beforeEach(async () => {
  await fs.rm(path.join(tmpDir, 'data'), { recursive: true, force: true });
});

/** Same minimal-but-real PNG builder AssetStore.test.ts uses. */
function makePng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  ihdr.writeUInt8(8, 16);
  ihdr.writeUInt8(6, 17);
  return Buffer.concat([signature, ihdr]);
}

const SQUARE = makePng(64, 64);
const WIDE = makePng(640, 320);

async function setup(): Promise<{ content: ContentStoreInstance; assets: AssetStoreInstance }> {
  const content = new ContentStore();
  await content.load();
  return { content, assets: new AssetStore() };
}

function makeMonster(id: string, overrides: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return {
    id,
    name: `Monster ${id}`,
    hp: 10,
    damage: 2,
    damageType: 'physical',
    xp: 5,
    goldMin: 1,
    goldMax: 3,
    ...overrides,
  };
}

function makeItem(id: string, overrides: Partial<ItemDefinition> = {}): ItemDefinition {
  return { id, name: `Item ${id}`, rarity: 'common', ...overrides };
}

function makeZone(id: string, overrides: Partial<ZoneDefinition> = {}): ZoneDefinition {
  return { id, displayName: `Zone ${id}`, encounterTable: [], levelRange: [1, 3], ...overrides };
}

function makeTileType(id: string, overrides: Partial<TileTypeDefinition> = {}): TileTypeDefinition {
  return { id, name: `Type ${id}`, icon: '#', color: '#123456', traversable: true, ...overrides };
}

function makeTile(col: number, row: number, overrides: Partial<WorldTileDefinition> = {}): WorldTileDefinition {
  return {
    id: '',  // ContentStore assigns the GUID
    mapId: 'overworld',
    col,
    row,
    type: 'plains',
    zone: 'hatchetmill',
    name: `Room ${col},${row}`,
    ...overrides,
  };
}

function kindOf(report: { kinds: AssetKindCoverage[] }, kind: string): AssetKindCoverage {
  const found = report.kinds.find(k => k.kind === kind);
  if (!found) throw new Error(`Report has no coverage for kind "${kind}".`);
  return found;
}

describe('computeAssetCoverage counts', () => {
  it('reports every content id as required and only the ones with files as present', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateMonster(makeMonster('coverage_wolf'));
    await content.addOrUpdateMonster(makeMonster('coverage_bear'));
    await assets.write('monster', 'coverage_wolf', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'monster' });
    const monsters = kindOf(report, 'monster');
    const totalMonsters = Object.keys(content.getAllMonsters()).length;

    expect(monsters.required).toBe(totalMonsters);
    expect(monsters.present).toBe(1);
    expect(monsters.missing).toBe(totalMonsters - 1);
    expect(monsters.orphans).toEqual([]);
    expect(monsters.label).toBe('Monster');
    expect(monsters.mount).toBe('/monster-artwork');
  });

  it('enumerates skills so the skill kind reports real gaps rather than an empty set', async () => {
    // Skills were the last content type with no asset kind, so this pins the
    // enumeration: a required count of zero here would silently report full
    // coverage no matter how much art was missing.
    const { content, assets } = await setup();
    const skillIds = Object.keys(content.getAllSkills());
    expect(skillIds.length).toBeGreaterThan(0);
    await assets.write('skill', skillIds[0], SQUARE);

    const skills = kindOf(await computeAssetCoverage(content, assets, { kind: 'skill' }), 'skill');
    expect(skills.required).toBe(skillIds.length);
    expect(skills.present).toBe(1);
    expect(skills.missing).toBe(skillIds.length - 1);
    expect(skills.orphans).toEqual([]);
    expect(skills.mount).toBe('/skill-artwork');
  });

  it('reports zero required ids for the room-override kind, which only ever holds optional art', async () => {
    const { content, assets } = await setup();
    const report = await computeAssetCoverage(content, assets, { kind: 'tile' });
    expect(kindOf(report, 'tile').required).toBe(0);
    expect(kindOf(report, 'tile').missing).toBe(0);
  });

  it('aggregates per-kind counts into the report summary', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateItem(makeItem('coverage_potion'));
    await assets.write('item', 'coverage_potion', SQUARE);
    await assets.write('monster', Object.keys(content.getAllMonsters())[0], SQUARE);

    const report = await computeAssetCoverage(content, assets);
    expect(report.kinds.length).toBe(MANAGED_ASSET_KINDS.length);
    expect(report.summary.kinds).toBe(MANAGED_ASSET_KINDS.length);
    expect(report.summary.required).toBe(report.kinds.reduce((sum, k) => sum + k.required, 0));
    expect(report.summary.present).toBe(2);
    expect(report.summary.missing).toBe(report.summary.required - report.summary.present);
    expect(Number.isNaN(Date.parse(report.generatedAt))).toBe(false);
  });

  it('restricts the report to a single kind when the kind option is set', async () => {
    const { content, assets } = await setup();
    const report = await computeAssetCoverage(content, assets, { kind: 'tile-type' });
    expect(report.kinds.map(k => k.kind)).toEqual(['tile-type']);
    expect(report.summary.kinds).toBe(1);
    expect(kindOf(report, 'tile-type').required).toBe(Object.keys(content.getAllTileTypes()).length);
  });
});

describe('computeAssetCoverage fallback chains', () => {
  it('counts a monster whose art is filed under a slug of its name as covered by the monster fallback', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateMonster(makeMonster('boss_slime_lord', { name: 'Slime Lord' }));
    // Art dropped in under the legacy name slug, not the monster id.
    await assets.write('monster', 'slime-lord', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'monster', includeEntries: true });
    const monsters = kindOf(report, 'monster');
    const entry = monsters.entries?.find(e => e.id === 'boss_slime_lord');

    expect(entry).toBeDefined();
    expect(entry?.hasOwnAsset).toBe(false);
    expect(entry?.resolvedVia).toBe('fallback:monster');
    expect(monsters.present).toBe(0);
    expect(monsters.coveredByFallback).toBe(1);
    // The alias file is art the client really renders, so it is not an orphan.
    expect(monsters.orphans).toEqual([]);
    expect(monsters.overrides).toBe(1);
  });

  it('falls a combat backdrop back to the zone artwork, while the room backdrop stays a placeholder', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateZone(makeZone('emberfall', { displayName: 'Emberfall' }));
    await assets.write('zone', 'emberfall', SQUARE);

    const report = await computeAssetCoverage(content, assets, { includeEntries: true });

    const combatBg = kindOf(report, 'combat-bg');
    const combatEntry = combatBg.entries?.find(e => e.id === 'emberfall');
    expect(combatEntry?.hasOwnAsset).toBe(false);
    expect(combatEntry?.resolvedVia).toBe('fallback:zone');
    expect(combatBg.coveredByFallback).toBe(1);

    // room-bg declares no fallbacks, so the same zone renders a placeholder there.
    const roomEntry = kindOf(report, 'room-bg').entries?.find(e => e.id === 'emberfall');
    expect(roomEntry?.resolvedVia).toBe('placeholder');
    expect(kindOf(report, 'room-bg').coveredByFallback).toBe(0);

    // The zone itself does have its own art.
    const zoneEntry = kindOf(report, 'zone').entries?.find(e => e.id === 'emberfall');
    expect(zoneEntry?.hasOwnAsset).toBe(true);
    expect(zoneEntry?.resolvedVia).toBe('own');
  });

  it('prefers a combat backdrop of its own over the zone fallback', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateZone(makeZone('emberfall'));
    await assets.write('zone', 'emberfall', SQUARE);
    await assets.write('combat-bg', 'emberfall', WIDE);

    const report = await computeAssetCoverage(content, assets, { kind: 'combat-bg', includeEntries: true });
    const entry = kindOf(report, 'combat-bg').entries?.find(e => e.id === 'emberfall');
    expect(entry?.hasOwnAsset).toBe(true);
    expect(entry?.resolvedVia).toBe('own');
    expect(kindOf(report, 'combat-bg').coveredByFallback).toBe(0);
  });
});

describe('computeAssetCoverage orphans and overrides', () => {
  it('lists artwork left behind by a deleted entity as an orphan', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateMonster(makeMonster('doomed_wisp', { name: 'Doomed Wisp' }));
    await assets.write('monster', 'doomed_wisp', SQUARE);

    const before = await computeAssetCoverage(content, assets, { kind: 'monster' });
    expect(kindOf(before, 'monster').orphans).toEqual([]);
    expect(kindOf(before, 'monster').present).toBe(1);

    const deleted = await content.deleteMonster('doomed_wisp');
    expect(deleted.success).toBe(true);

    const after = await computeAssetCoverage(content, assets, { kind: 'monster' });
    expect(kindOf(after, 'monster').orphans).toEqual(['doomed_wisp']);
    expect(kindOf(after, 'monster').present).toBe(0);
    expect(after.summary.orphans).toBe(1);
  });

  it('counts per-room artwork keyed by the room GUID as an override, not an orphan', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateTile(makeTile(4, 9));
    const tile = content.getWorld().tiles.find(t => t.col === 4 && t.row === 9);
    expect(tile).toBeDefined();

    await assets.write('tile', tile!.id, SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'tile' });
    expect(kindOf(report, 'tile').overrides).toBe(1);
    expect(kindOf(report, 'tile').orphans).toEqual([]);
  });

  it('counts a per-room combat backdrop keyed by zone-col-row as an override, not an orphan', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateTile(makeTile(2, 5, { zone: 'hatchetmill' }));
    await assets.write('combat-bg', 'hatchetmill-2-5', WIDE);

    const report = await computeAssetCoverage(content, assets, { kind: 'combat-bg' });
    expect(kindOf(report, 'combat-bg').overrides).toBe(1);
    expect(kindOf(report, 'combat-bg').orphans).toEqual([]);

    await assets.write('combat-bg', 'hatchetmill-99-99', WIDE);
    const stale = await computeAssetCoverage(content, assets, { kind: 'combat-bg' });
    expect(kindOf(stale, 'combat-bg').orphans).toEqual(['hatchetmill-99-99']);
  });
});

describe('computeAssetCoverage entry options', () => {
  it('omits the per-id entries array unless includeEntries is set', async () => {
    const { content, assets } = await setup();
    const without = await computeAssetCoverage(content, assets, { kind: 'monster' });
    expect(kindOf(without, 'monster').entries).toBeUndefined();

    const with_ = await computeAssetCoverage(content, assets, { kind: 'monster', includeEntries: true });
    expect(kindOf(with_, 'monster').entries?.length).toBe(kindOf(with_, 'monster').required);
  });

  it('lists only ids with no artwork of their own when missingOnly is set', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateMonster(makeMonster('has_art'));
    await content.addOrUpdateMonster(makeMonster('no_art'));
    await assets.write('monster', 'has_art', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'monster', includeEntries: true, missingOnly: true });
    const entries = kindOf(report, 'monster').entries ?? [];

    expect(entries.length).toBe(kindOf(report, 'monster').missing);
    expect(entries.every(e => e.hasOwnAsset === false)).toBe(true);
    expect(entries.map(e => e.id)).not.toContain('has_art');
    expect(entries.map(e => e.id)).toContain('no_art');
  });

  it('caps the entries array at entryLimit while leaving the counts complete', async () => {
    const { content, assets } = await setup();
    const total = Object.keys(content.getAllMonsters()).length;
    expect(total).toBeGreaterThan(2);

    const report = await computeAssetCoverage(content, assets, { kind: 'monster', includeEntries: true, entryLimit: 2 });
    expect(kindOf(report, 'monster').entries?.length).toBe(2);
    expect(kindOf(report, 'monster').required).toBe(total);
    expect(kindOf(report, 'monster').missing).toBe(total);
  });

  it('carries the entity display name onto each entry', async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateZone(makeZone('emberfall', { displayName: 'Emberfall Caldera' }));

    const report = await computeAssetCoverage(content, assets, { kind: 'zone', includeEntries: true });
    const entry = kindOf(report, 'zone').entries?.find(e => e.id === 'emberfall');
    expect(entry?.label).toBe('Emberfall Caldera');
  });
});

describe('computeAssetCoverage case-insensitive kinds', () => {
  it('matches a capitalized Knight.png against the required class id', async () => {
    const { content, assets } = await setup();
    await assets.write('class', 'Knight', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'class', includeEntries: true });
    const classes = kindOf(report, 'class');
    expect(classes.present).toBe(1);
    expect(classes.orphans).toEqual([]);
    expect(classes.entries?.find(e => e.id === 'Knight')?.hasOwnAsset).toBe(true);
  });

  it('matches a lowercase knight.png against the required class id too', async () => {
    const { content, assets } = await setup();
    await assets.write('class', 'knight', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'class', includeEntries: true });
    const classes = kindOf(report, 'class');
    expect(classes.present).toBe(1);
    expect(classes.orphans).toEqual([]);
    expect(classes.entries?.find(e => e.id === 'Knight')?.hasOwnAsset).toBe(true);
  });

  it('still reports a genuinely unrelated class file as an orphan', async () => {
    const { content, assets } = await setup();
    await assets.write('class', 'necromancer', SQUARE);

    const report = await computeAssetCoverage(content, assets, { kind: 'class' });
    expect(kindOf(report, 'class').orphans).toEqual(['necromancer']);
    expect(kindOf(report, 'class').present).toBe(0);
  });
});

describe('computeAssetCoverage fixed and derived id sources', () => {
  it('requires exactly one logo, keyed by the fixed idle-party id', async () => {
    const { content, assets } = await setup();
    const before = await computeAssetCoverage(content, assets, { kind: 'logo', includeEntries: true });
    expect(kindOf(before, 'logo').required).toBe(1);
    expect(kindOf(before, 'logo').entries?.[0].id).toBe('idle-party');
    expect(kindOf(before, 'logo').missing).toBe(1);

    await assets.write('logo', 'idle-party', WIDE);
    const after = await computeAssetCoverage(content, assets, { kind: 'logo' });
    expect(kindOf(after, 'logo').present).toBe(1);
    expect(kindOf(after, 'logo').missing).toBe(0);
  });

  it('derives the map-parchment requirement from the world maps', async () => {
    const { content, assets } = await setup();
    const report = await computeAssetCoverage(content, assets, { kind: 'parchment' });
    expect(kindOf(report, 'parchment').required).toBe(content.getMaps().length);
  });

  it('adds the Unknown and Server placeholders to the class-icon requirement', async () => {
    const { content, assets } = await setup();
    const report = await computeAssetCoverage(content, assets, { kind: 'class-icon', includeEntries: true });
    const ids = kindOf(report, 'class-icon').entries?.map(e => e.id) ?? [];
    expect(ids).toContain('Knight');
    expect(ids).toContain('Unknown');
    expect(ids).toContain('Server');
  });

  it('reflects newly added tile types in the room-type requirement', async () => {
    const { content, assets } = await setup();
    const before = (await computeAssetCoverage(content, assets, { kind: 'tile-type' })).kinds[0].required;
    await content.addOrUpdateTileType(makeTileType('obsidian_flats'));
    const after = await computeAssetCoverage(content, assets, { kind: 'tile-type', includeEntries: true });

    expect(kindOf(after, 'tile-type').required).toBe(before + 1);
    expect(kindOf(after, 'tile-type').entries?.map(e => e.id)).toContain('obsidian_flats');
  });
});

describe('computeAssetCoverage and the deferred kinds', () => {
  it('omits set and shop from a full report', async () => {
    const { content, assets } = await setup();
    const report = await computeAssetCoverage(content, assets);
    const reported = report.kinds.map(k => k.kind);

    expect(reported).not.toContain('set');
    expect(reported).not.toContain('shop');
    expect(reported).toHaveLength(MANAGED_ASSET_KINDS.length);
    expect(report.summary.kinds).toBe(MANAGED_ASSET_KINDS.length);
  });

  it('ignores art sitting in a deferred kind\'s folder entirely', async () => {
    // The folders stay mounted so existing art keeps serving; the report just
    // does not speak about them either way.
    const { content, assets } = await setup();
    await content.addOrUpdateShop({ id: 'emberfall_general', name: 'General Store', inventory: [] });
    await assets.write('shop', 'emberfall_general', SQUARE);

    const report = await computeAssetCoverage(content, assets);
    expect(report.kinds.find(k => k.kind === 'shop')).toBeUndefined();
    // ...and the file is untouched, ready for whenever shop is un-deferred.
    expect(await assets.has('shop', 'emberfall_general')).toBe(true);
  });
});

describe('computeAssetCoverage counts NPC artwork URLs as coverage', () => {
  it('counts an NPC pointing at its own artwork URL as covered rather than missing', async () => {
    // NpcTalkPopup renders NpcDefinition.artworkUrl verbatim, so such an NPC
    // has a portrait whether or not the npc-artwork folder holds anything.
    const { content, assets } = await setup();
    await content.addOrUpdateNpc({
      id: 'linked_smith', name: 'Linked Smith', emoji: '🔨', greeting: 'Hail.',
      artworkUrl: 'https://cdn.example.test/smith.png',
    });
    await content.addOrUpdateNpc({ id: 'plain_herald', name: 'Plain Herald', emoji: '📯', greeting: 'Hear ye.' });

    const npc = kindOf(await computeAssetCoverage(content, assets, { kind: 'npc', includeEntries: true }), 'npc');

    expect(npc.entries?.find(e => e.id === 'linked_smith')?.resolvedVia).toBe('external');
    expect(npc.entries?.find(e => e.id === 'plain_herald')?.resolvedVia).toBe('placeholder');
    expect(npc.coveredByFallback).toBe(1);
  });

  it("prefers an NPC's own uploaded art over its artwork URL", async () => {
    const { content, assets } = await setup();
    await content.addOrUpdateNpc({
      id: 'both_smith', name: 'Both Smith', emoji: '🔨', greeting: 'Hail.',
      artworkUrl: 'https://cdn.example.test/smith.png',
    });
    await assets.write('npc', 'both_smith', SQUARE);

    const npc = kindOf(await computeAssetCoverage(content, assets, { kind: 'npc', includeEntries: true }), 'npc');
    expect(npc.entries?.find(e => e.id === 'both_smith')?.resolvedVia).toBe('own');
    expect(npc.coveredByFallback).toBe(0);
  });
});
