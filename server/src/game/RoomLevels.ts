import { effectiveMonsterLevel } from '@idle-party-rpg/shared';
import type { EncounterDefinition, EncounterTableEntry, MonsterDefinition } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

type LevelContent = Pick<ContentStore, 'contentEpoch' | 'getWorld' | 'getAllZones' | 'getAllEncounters' | 'getAllMonsters'>;

export type LevelBand = [number, number];

export interface RoomLevelBands {
  /** Zones whose encounter table holds at least one monster with an authored level. */
  zones: Readonly<Record<string, LevelBand>>;
  /** Rooms with their own encounter table holding at least one monster with an authored level. */
  rooms: ReadonlyMap<string, LevelBand>;
}

const cache = new WeakMap<LevelContent, { epoch: number; bands: RoomLevelBands }>();

/** The [min, max] authored monster level of each zone's table and each room's own table. Rebuilt once per content change. */
export function roomLevelBands(content: LevelContent): RoomLevelBands {
  const known = cache.get(content);
  if (known && known.epoch === content.contentEpoch) return known.bands;
  const bands = buildBands(content);
  cache.set(content, { epoch: content.contentEpoch, bands });
  return bands;
}

function buildBands(content: LevelContent): RoomLevelBands {
  const encounters = content.getAllEncounters();
  const monsters = content.getAllMonsters();
  const zones: Record<string, LevelBand> = {};
  for (const [zoneId, zone] of Object.entries(content.getAllZones())) {
    const band = tableLevelBand(zone.encounterTable ?? [], encounters, monsters);
    if (band) zones[zoneId] = band;
  }
  const rooms = new Map<string, LevelBand>();
  for (const tile of content.getWorld().tiles) {
    if (!tile.encounterTable?.length) continue;
    const band = tableLevelBand(tile.encounterTable, encounters, monsters);
    if (band) rooms.set(tile.id, band);
  }
  return { zones, rooms };
}

function tableLevelBand(
  table: readonly EncounterTableEntry[],
  encounters: Readonly<Record<string, EncounterDefinition>>,
  monsters: Readonly<Record<string, MonsterDefinition>>,
): LevelBand | null {
  let min = Infinity;
  let max = -Infinity;
  for (const entry of table) {
    if (!(entry.weight > 0) || !hasOwn(encounters, entry.encounterId)) continue;
    for (const monsterId of encounterMonsterIds(encounters[entry.encounterId])) {
      const def = hasOwn(monsters, monsterId) ? monsters[monsterId] : undefined;
      if (!def || def.passive) continue;
      const { level, source } = effectiveMonsterLevel(def);
      if (source !== 'authored') continue;
      min = Math.min(min, level);
      max = Math.max(max, level);
    }
  }
  return min <= max ? [min, max] : null;
}

function encounterMonsterIds(encounter: EncounterDefinition): string[] {
  if (encounter.type === 'explicit') return (encounter.placements ?? []).map(p => p.monsterId);
  return (encounter.monsterPool ?? []).filter(p => p.max > 0).map(p => p.monsterId);
}

function hasOwn(obj: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(obj, key);
}
