import type { Region } from '../policy.js';
import type { EncounterEntry } from '../types.js';
import { MIN_FIGHTS_PER_STRATUM } from './types.js';
import type { Stratum, XpSnapshot, XpTable } from './types.js';

function midLevel(range: readonly [number, number]): number {
  return Math.round((range[0] + range[1]) / 2);
}

function encounterMonsters(encounter: any): { monsterId: string; count: number }[] {
  if (!encounter) return [];
  if (encounter.type === 'explicit') return (encounter.placements ?? []).map((p: any) => ({ monsterId: p.monsterId, count: 1 }));
  return (encounter.monsterPool ?? []).map((p: any) => ({ monsterId: p.monsterId, count: (p.min + p.max) / 2 }));
}

function fallbackMonster(content: XpSnapshot): any {
  return content.monsters.goblin ?? Object.values(content.monsters)[0];
}

function strataOf(content: XpSnapshot, mod: any, entries: readonly EncounterEntry[]): Stratum[] {
  const weights = new Map<string, number>();
  for (const e of entries) {
    if (e.weight > 0) weights.set(e.encounterId, (weights.get(e.encounterId) ?? 0) + e.weight);
  }
  if (weights.size === 0) {
    if (entries.length === 0) return [{ encounterId: null, share: 1, boss: false }];
    weights.set(entries[0].encounterId, 1);
  }
  const total = [...weights.values()].reduce((a, b) => a + b, 0);
  return [...weights].sort((a, b) => a[0].localeCompare(b[0])).map(([encounterId, weight]) => ({
    encounterId,
    share: weight / total,
    boss: encounterMonsters(content.encounters[encounterId]).some(({ monsterId }) => {
      const def = content.monsters[monsterId];
      return !!def && !def.passive && ['boss', 'raid'].includes(mod.effectiveMonsterTier(def));
    }),
  }));
}

function weightedLowerMedian(items: { value: number; weight: number }[]): number | null {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (!(total > 0)) return null;
  const sorted = [...items].sort((a, b) => a.value - b.value);
  let cum = 0;
  for (const item of sorted) {
    cum += item.weight;
    if (cum >= total / 2 - 1e-12) return item.value;
  }
  return sorted[sorted.length - 1].value;
}

function roomLevelOf(content: XpSnapshot, mod: any, strata: readonly Stratum[]): number | null {
  const items: { value: number; weight: number }[] = [];
  for (const stratum of strata) {
    if (!stratum.encounterId) continue;
    for (const { monsterId, count } of encounterMonsters(content.encounters[stratum.encounterId])) {
      const def = content.monsters[monsterId];
      if (!def || def.passive) continue;
      const { level, source } = mod.effectiveMonsterLevel(def);
      if (source === 'authored') items.push({ value: level, weight: stratum.share * count });
    }
  }
  return weightedLowerMedian(items);
}

function strataPayNothing(content: XpSnapshot, strata: readonly Stratum[]): boolean {
  return strata.every(stratum => {
    if (!stratum.encounterId) return !fallbackMonster(content)?.xp;
    const encounter = content.encounters[stratum.encounterId];
    const monsters = encounterMonsters(encounter);
    if (monsters.length === 0) return !fallbackMonster(content)?.xp;
    return monsters.every(({ monsterId }) => !content.monsters[monsterId]?.xp);
  });
}

interface TileGroup {
  zoneId: string;
  entries: EncounterEntry[];
  override: boolean;
  tiles: XpSnapshot['world']['tiles'];
}

function strataKey(strata: readonly Stratum[]): string {
  return strata.map(s => `${s.encounterId ?? '*'}:${s.share.toFixed(4)}`).join(',');
}

function isTraversable(content: XpSnapshot, tile: any): boolean {
  const types = content.tileTypes;
  if (!types) return true;
  return !!types[tile.type]?.traversable;
}

export interface BuiltTables {
  tables: XpTable[];
  log: string[];
  /** Traversable tile id to its table key. */
  tileKeys: Map<string, string>;
}

export function buildTables(content: XpSnapshot, mod: any, zoneRegion: Map<string, Region>, regions: readonly Region[]): BuiltTables {
  const log: string[] = [];
  const groups = new Map<string, TileGroup>();
  const tileKeys = new Map<string, string>();
  let unzoned = 0;
  for (const tile of content.world.tiles) {
    if (!isTraversable(content, tile)) continue;
    const zone = content.zones[tile.zone];
    if (!zone || !zoneRegion.has(tile.zone)) {
      unzoned++;
      continue;
    }
    const override = !!tile.encounterTable?.length;
    const entries = override ? tile.encounterTable! : zone.encounterTable ?? [];
    const key = `room|${tile.zone}|${strataKey(strataOf(content, mod, entries))}`;
    const group = groups.get(key) ?? { zoneId: tile.zone, entries, override, tiles: [] };
    group.override &&= override;
    group.tiles.push(tile);
    groups.set(key, group);
    tileKeys.set(tile.id, key);
  }
  if (unzoned) log.push(`${unzoned} traversable rooms have no zone or region and were left out`);

  const tables: XpTable[] = [];
  const base = (zoneId: string): Pick<XpTable, 'zoneId' | 'zoneName' | 'regionId' | 'regionName' | 'regionIndex' | 'zoneLevelRange'> => {
    const zone = content.zones[zoneId];
    const region = zoneRegion.get(zoneId)!;
    return { zoneId, zoneName: zone.displayName, regionId: region.id, regionName: region.name, regionIndex: region.index, zoneLevelRange: zone.levelRange };
  };
  const levelAndFlags = (strata: Stratum[], zoneId: string): Pick<XpTable, 'roomLevel' | 'roomLevelSource' | 'strata' | 'zeroXp' | 'boss' | 'bossShare' | 'fallback'> => {
    const authored = roomLevelOf(content, mod, strata);
    return {
      roomLevel: authored ?? midLevel(content.zones[zoneId].levelRange),
      roomLevelSource: authored === null ? 'zone' : 'authored',
      strata,
      zeroXp: strataPayNothing(content, strata),
      boss: strata.some(s => s.boss),
      bossShare: strata.reduce((sum, s) => sum + (s.boss ? s.share : 0), 0),
      fallback: strata.some(s => !s.encounterId),
    };
  };

  for (const [key, group] of groups) {
    const typeCounts: Record<string, number> = {};
    for (const t of group.tiles) typeCounts[(t as any).type] = (typeCounts[(t as any).type] ?? 0) + 1;
    const names = [...new Set(group.tiles.map(t => t.name).filter(Boolean))];
    const strata = strataOf(content, mod, group.entries);
    const zoneName = content.zones[group.zoneId].displayName;
    tables.push({
      index: tables.length,
      key,
      kind: 'room',
      label: names.length === 1 ? `${zoneName}: ${names[0]}` : `${zoneName}${group.override ? ` (${names[0] ?? 'room'} +${names.length - 1})` : ''}`,
      ...base(group.zoneId),
      ...levelAndFlags(strata, group.zoneId),
      entries: group.entries,
      tileCount: group.tiles.length,
      npcTiles: group.tiles.filter(t => (t as any).npcId).length,
      shopTiles: group.tiles.filter(t => t.shopId).length,
      dungeonTiles: group.tiles.filter(t => t.dungeonId).length,
      tileTypes: typeCounts,
      override: group.override,
      starterZone: (content.zones[group.zoneId] as { starterZone?: boolean }).starterZone === true,
    });
  }

  for (const dungeon of Object.values(content.dungeons) as any[]) {
    const entrance = content.world.tiles.find(t => t.dungeonId === dungeon.id);
    if (!entrance || !zoneRegion.has(entrance.zone)) {
      log.push(`dungeon ${dungeon.id}: no placed entrance, left out`);
      continue;
    }
    (dungeon.floors ?? []).forEach((floor: any, floorIndex: number) => {
      const entries: EncounterEntry[] = floor.encounterTable ?? [];
      tables.push({
        index: tables.length,
        key: `floor|${dungeon.id}|${floorIndex}`,
        kind: 'floor',
        label: `${dungeon.name} floor ${floorIndex + 1}`,
        ...base(entrance.zone),
        ...levelAndFlags(strataOf(content, mod, entries), entrance.zone),
        entries,
        tileCount: 0,
        npcTiles: 0,
        shopTiles: 0,
        dungeonTiles: 0,
        tileTypes: {},
        override: false,
        starterZone: false,
        dungeonId: dungeon.id,
        dungeonName: dungeon.name,
        floorIndex,
        floorCount: dungeon.floors.length,
        ...(floor.xpFactor === undefined ? {} : { floorXpFactor: floor.xpFactor }),
        ...(floor.coinFactor === undefined ? {} : { floorCoinFactor: floor.coinFactor }),
        entryRequirements: dungeon.entryRequirements,
      });
    });
  }
  if (regions.length === 0) log.push('no regions: the snapshot has no world maps');
  return { tables, log, tileKeys };
}

export function fightsPerStratum(share: number, fightsPerCell: number): number {
  return Math.max(MIN_FIGHTS_PER_STRATUM, Math.round(fightsPerCell * share));
}

export function evenlySpaced<T>(items: readonly T[], count: number): T[] {
  if (count >= items.length) return [...items];
  const picked: T[] = [];
  for (let i = 0; i < count; i++) picked.push(items[Math.floor((i * items.length) / count)]);
  return picked;
}
