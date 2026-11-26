import {
  clampMonsterLevel,
  codexTableKey,
  effectiveMonsterTier,
  encounterMonsterIds,
  isAuthoredMonsterLevel,
  isTileTraversable,
  tableMonsterIds,
  tableShares,
} from '@idle-party-rpg/shared';
import type {
  CodexDungeon,
  CodexItem,
  CodexMonster,
  CodexRef,
  CodexShop,
  CodexTable,
  EncounterTableEntry,
  ServerCodexMessage,
} from '@idle-party-rpg/shared';
import type { ContentStore } from '../ContentStore.js';
import type { CodexKnowledge } from './CodexKnowledge.js';

export type CodexContent = Pick<ContentStore,
  'contentEpoch' | 'getWorld' | 'getTileType' | 'getAllZones' | 'getAllEncounters' | 'getAllMonsters'
  | 'getAllDungeons' | 'getMonster' | 'getItem' | 'getShop' | 'getHenchman'>;

export interface CodexTableSpawns {
  readonly spawns: readonly string[];
  readonly encounters: readonly string[];
}

export interface CodexContentIndex {
  /** Walkable room id -> its table key. */
  readonly roomTable: ReadonlyMap<string, string>;
  /** Table key -> what it can spawn and which encounters it rolls. */
  readonly tables: ReadonlyMap<string, CodexTableSpawns>;
  /** Encounter id (any that a table names) -> its monster ids. */
  readonly encounterMonsters: ReadonlyMap<string, readonly string[]>;
  /** Dungeon id -> monster ids its floors can spawn. */
  readonly dungeonSpawns: ReadonlyMap<string, readonly string[]>;
}

export interface CodexBuildInput {
  knowledge: CodexKnowledge;
  unlocked: readonly string[];
  kills: Readonly<Record<string, number>>;
  version: string;
}

const indexes = new WeakMap<CodexContent, { epoch: number; index: CodexContentIndex }>();

/** Which monsters and encounters every room's table can roll, and every dungeon's floors. Rebuilt once per content epoch. */
export function codexContentIndex(content: CodexContent): CodexContentIndex {
  const known = indexes.get(content);
  if (known && known.epoch === content.contentEpoch) return known.index;
  const index = buildContentIndex(content);
  indexes.set(content, { epoch: content.contentEpoch, index });
  return index;
}

/** Everything this player has discovered and nothing else. See docs/architecture/codex.md → Secrecy. */
export function buildCodexMessage(input: CodexBuildInput, content: CodexContent): ServerCodexMessage {
  const { knowledge } = input;
  const index = codexContentIndex(content);

  const monsters: CodexMonster[] = [];
  for (const id of knowledge.monsterIds()) {
    const monster = codexMonster(id, input, content);
    if (monster) monsters.push(monster);
  }
  const met = new Set(monsters.map(m => m.id));

  const shops: CodexShop[] = [];
  for (const id of knowledge.shopIds()) {
    const shop = codexShop(id, content);
    if (shop) shops.push(shop);
  }

  const items: CodexItem[] = [];
  const listed = new Set<string>();
  for (const id of knowledge.itemIds()) {
    const def = content.getItem(id);
    if (!def || listed.has(id)) continue;
    listed.add(id);
    items.push({ def, found: true });
  }
  for (const shop of shops) {
    for (const { itemId } of shop.stock) {
      const def = content.getItem(itemId);
      if (!def || listed.has(itemId)) continue;
      listed.add(itemId);
      items.push({ def, found: false });
    }
  }

  const { tables, fights } = codexTables(input, index, met);

  const dungeons: CodexDungeon[] = [];
  for (const id of knowledge.dungeonIds()) {
    const spawns = index.dungeonSpawns.get(id);
    if (spawns) dungeons.push({ id, monsters: spawns.filter(m => met.has(m)) });
  }

  const shopIds = new Set(shops.map(s => s.id));
  const recent = knowledge.recentRefs().filter((ref: CodexRef) => {
    if (ref.kind === 'monster') return met.has(ref.id);
    if (ref.kind === 'item') return knowledge.hasItem(ref.id) && listed.has(ref.id);
    return ref.kind === 'shop' && shopIds.has(ref.id);
  });

  return { type: 'codex', version: input.version, monsters, items, shops, fights, tables, dungeons, recent };
}

function buildContentIndex(content: CodexContent): CodexContentIndex {
  const monsters = content.getAllMonsters();
  const encounters = content.getAllEncounters();
  const zones = content.getAllZones();
  const roomTable = new Map<string, string>();
  const tables = new Map<string, CodexTableSpawns>();
  const encounterMonsters = new Map<string, readonly string[]>();

  const entranceZones = new Map<string, Set<string>>();
  for (const tile of content.getWorld().tiles) {
    if (tile.dungeonId) {
      const zoneIds = entranceZones.get(tile.dungeonId) ?? new Set<string>();
      zoneIds.add(tile.zone);
      entranceZones.set(tile.dungeonId, zoneIds);
    }
    if (!isTileTraversable(tile.type, content.getTileType(tile.type))) continue;
    const key = codexTableKey(tile);
    roomTable.set(tile.id, key);
    if (tables.has(key)) continue;
    const zoneTable = hasOwn(zones, tile.zone) ? zones[tile.zone]?.encounterTable : undefined;
    const table: readonly EncounterTableEntry[] = tile.encounterTable?.length ? tile.encounterTable : zoneTable ?? [];
    const rolled = tableShares(table).map(share => share.entryId).filter(id => id !== '');
    for (const encounterId of rolled) {
      if (!encounterMonsters.has(encounterId)) encounterMonsters.set(encounterId, encounterMonsterIds(encounterId, monsters, encounters));
    }
    tables.set(key, { spawns: tableMonsterIds(table, monsters, encounters), encounters: rolled });
  }

  const dungeonSpawns = new Map<string, readonly string[]>();
  for (const [id, dungeon] of Object.entries(content.getAllDungeons())) {
    const spawns = new Set<string>();
    for (const floor of dungeon.floors ?? []) {
      const floorTables: (readonly EncounterTableEntry[])[] = floor.encounterTable?.length
        ? [floor.encounterTable]
        : entranceZoneTables(entranceZones.get(id), zones);
      for (const table of floorTables) {
        for (const monsterId of tableMonsterIds(table, monsters, encounters)) spawns.add(monsterId);
      }
    }
    dungeonSpawns.set(id, [...spawns]);
  }
  return { roomTable, tables, encounterMonsters, dungeonSpawns };
}

/** What a floor with an empty table rolls: its entrance rooms' zone tables, as `createEncounter` does. */
function entranceZoneTables(zoneIds: ReadonlySet<string> | undefined, zones: ReturnType<CodexContent['getAllZones']>): (readonly EncounterTableEntry[])[] {
  if (!zoneIds || zoneIds.size === 0) return [[]];
  return [...zoneIds].map(zoneId => (hasOwn(zones, zoneId) ? zones[zoneId]?.encounterTable : undefined) ?? []);
}

function codexMonster(id: string, input: CodexBuildInput, content: CodexContent): CodexMonster | null {
  const def = content.getMonster(id);
  if (!def) return null;
  const drops = [...input.knowledge.dropsOf(id)]
    .filter(([itemId]) => input.knowledge.hasItem(itemId) && !!content.getItem(itemId))
    .sort((a, b) => b[1] - a[1])
    .map(([itemId, seen]) => ({ itemId, seen }));
  const dropKinds = new Set((def.drops ?? [])
    .filter(drop => typeof drop.chance === 'number' && drop.chance > 0 && !!content.getItem(drop.itemId))
    .map(drop => drop.itemId)).size;
  const monster: CodexMonster = {
    id,
    name: def.name,
    tier: effectiveMonsterTier(def),
    kills: hasOwn(input.kills, id) ? input.kills[id] : 0,
    drops,
    dropKinds,
  };
  if (isAuthoredMonsterLevel(def.level)) monster.level = clampMonsterLevel(def.level);
  if (def.description) monster.description = def.description;
  if (def.passive) monster.passive = true;
  return monster;
}

function codexShop(id: string, content: CodexContent): CodexShop | null {
  const def = content.getShop(id);
  if (!def) return null;
  const stock = (def.inventory ?? [])
    .filter(line => !!content.getItem(line.itemId))
    .map(line => ({ itemId: line.itemId, price: line.price }));
  const hires = (def.henchmanIds ?? []).flatMap(henchmanId => {
    const hire = content.getHenchman(henchmanId);
    return hire ? [{ name: hire.name, emoji: hire.emoji, level: hire.level }] : [];
  });
  return { id, name: def.name, stock, hires };
}

/** One table per distinct key of the found rooms, in found order; fights are fought encounters as their met monsters. */
function codexTables(input: CodexBuildInput, index: CodexContentIndex, met: ReadonlySet<string>): { tables: CodexTable[]; fights: string[][] } {
  const tables: CodexTable[] = [];
  const fights: string[][] = [];
  const fightAt = new Map<string, number>();
  const done = new Set<string>();
  for (const roomId of input.unlocked) {
    const key = index.roomTable.get(roomId);
    if (key === undefined || done.has(key)) continue;
    done.add(key);
    const table = index.tables.get(key);
    if (!table) continue;
    const monsters = table.spawns.filter(id => met.has(id));
    const tableFights: number[] = [];
    for (const encounterId of table.encounters) {
      if (!input.knowledge.hasEncounter(encounterId)) continue;
      const fight = (index.encounterMonsters.get(encounterId) ?? []).filter(id => met.has(id));
      if (fight.length === 0) continue;
      const fightKey = JSON.stringify([...fight].sort());
      let at = fightAt.get(fightKey);
      if (at === undefined) {
        at = fights.length;
        fights.push(fight);
        fightAt.set(fightKey, at);
      }
      if (!tableFights.includes(at)) tableFights.push(at);
    }
    if (monsters.length > 0 || tableFights.length > 0) tables.push({ key, monsters, fights: tableFights });
  }
  return { tables, fights };
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
