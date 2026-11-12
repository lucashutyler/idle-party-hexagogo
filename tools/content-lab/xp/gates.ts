import type { XpSnapshot, XpTable } from './types.js';

export interface ReachInfo {
  /** Tile id to the lowest member level that can stand there. Absent: nobody can. */
  tileLevel: Map<string, number>;
  perLevel: { level: number; rooms: number; quests: number }[];
}

interface MemberGate {
  minLevel?: number;
  requiredQuestIds?: string[];
}

function encounterMonsterIds(encounter: any): string[] {
  if (!encounter) return [];
  if (encounter.type === 'explicit') return (encounter.placements ?? []).map((p: any) => p.monsterId);
  return (encounter.monsterPool ?? []).map((p: any) => p.monsterId);
}

function gateOpen(gate: MemberGate | undefined, level: number, done: ReadonlySet<string>): boolean {
  if (!gate) return true;
  if (gate.minLevel !== undefined && level < gate.minLevel) return false;
  return (gate.requiredQuestIds ?? []).every(id => done.has(id));
}

function buildGrids(content: XpSnapshot, mod: any): Map<string, any> {
  const grids = new Map<string, any>();
  for (const tile of content.world.tiles as any[]) {
    let grid = grids.get(tile.mapId);
    if (!grid) {
      grid = new mod.HexGrid();
      grids.set(tile.mapId, grid);
    }
    grid.addTile(new mod.HexTile(mod.offsetToCube({ col: tile.col, row: tile.row }), tile.type, tile.zone, tile.id, tile.requiredItemId, content.tileTypes?.[tile.type], tile.entryRequirements));
  }
  return grids;
}

/**
 * What a member of each level can reach from the start tile, with every quest they could have done on the way.
 * A lower bound: fights are assumed won, collect objectives doable. Null when the snapshot has no start tile.
 */
export function computeReach(content: XpSnapshot, mod: any, maxLevel: number): ReachInfo | null {
  const start = (content.world as any).startTile;
  if (!start) return null;
  const grids = buildGrids(content, mod);
  const startHex = grids.get(content.world.defaultMapId)?.getTile(mod.offsetToCube(start));
  if (!startHex) return null;

  const tileById = new Map<string, any>((content.world.tiles as any[]).map(t => [t.id, t]));
  const quests = Object.values(content.quests ?? {}) as any[];
  const npcsOfQuest = new Map<string, string[]>();
  for (const npc of Object.values(content.npcs ?? {}) as any[]) {
    for (const id of npc.questIds ?? []) npcsOfQuest.set(id, [...(npcsOfQuest.get(id) ?? []), npc.id]);
  }
  const tilesOfNpc = new Map<string, string[]>();
  for (const tile of content.world.tiles as any[]) {
    if (tile.npcId) tilesOfNpc.set(tile.npcId, [...(tilesOfNpc.get(tile.npcId) ?? []), tile.id]);
  }
  const tileMonsters = (tile: any): string[] => {
    const entries = tile.encounterTable?.length ? tile.encounterTable : content.zones[tile.zone]?.encounterTable ?? [];
    return entries.flatMap((e: any) => encounterMonsterIds(content.encounters[e.encounterId]));
  };

  const closure = (level: number): { reach: Set<string>; done: Set<string> } => {
    const done = new Set<string>();
    for (;;) {
      const reach = new Set<string>([startHex.id]);
      const queue = [startHex];
      while (queue.length) {
        const hex = queue.pop();
        const def = tileById.get(hex.id);
        for (const next of grids.get(def.mapId).getAllNeighbors(hex.coord)) {
          if (!next.isTraversable || reach.has(next.id)) continue;
          if (!gateOpen(tileById.get(next.id).entryRequirements, level, done)) continue;
          reach.add(next.id);
          queue.push(next);
        }
        for (const link of def.transitions ?? []) {
          const target = tileById.get(link.tileId);
          if (!target || reach.has(link.tileId)) continue;
          if (!gateOpen(link.entryRequirements, level, done) || !gateOpen(target.entryRequirements, level, done)) continue;
          const hexThere = grids.get(target.mapId)?.getTileById(link.tileId);
          if (!hexThere) continue;
          reach.add(link.tileId);
          queue.push(hexThere);
        }
      }
      const killable = new Set<string>();
      for (const id of reach) for (const monster of tileMonsters(tileById.get(id))) killable.add(monster);
      for (const dungeon of Object.values(content.dungeons) as any[]) {
        const entrance = (content.world.tiles as any[]).find(t => t.dungeonId === dungeon.id);
        if (!entrance || !reach.has(entrance.id) || (dungeon.entryRequirements?.minLevel ?? 0) > level) continue;
        for (const floor of dungeon.floors ?? []) {
          for (const entry of floor.encounterTable ?? []) for (const monster of encounterMonsterIds(content.encounters[entry.encounterId])) killable.add(monster);
        }
      }
      let grew = false;
      for (const quest of quests) {
        if (done.has(quest.id) || (quest.requiredLevel ?? 0) > level) continue;
        if ((quest.prerequisiteQuestIds ?? []).some((id: string) => !done.has(id))) continue;
        const npcs = npcsOfQuest.get(quest.id) ?? [];
        if (npcs.length && !npcs.some(n => (tilesOfNpc.get(n) ?? []).some(t => reach.has(t)))) continue;
        const doable = (quest.objectives ?? []).every((o: any) => {
          if (o.kind === 'visit') return reach.has(o.tileId);
          if (o.kind === 'kill') return killable.has(o.monsterId);
          return true;
        });
        if (!doable) continue;
        done.add(quest.id);
        grew = true;
      }
      if (!grew) return { reach, done };
    }
  };

  const tileLevel = new Map<string, number>();
  const perLevel: ReachInfo['perLevel'] = [];
  for (let level = 1; level <= maxLevel; level++) {
    const { reach, done } = closure(level);
    perLevel.push({ level, rooms: reach.size, quests: done.size });
    for (const id of reach) if (!tileLevel.has(id)) tileLevel.set(id, level);
  }
  return { tileLevel, perLevel };
}

/** A table's reach level is its easiest room's. Tables stay ungated when reach can't be computed. */
export function annotateTables(tables: readonly XpTable[], tileKeys: ReadonlyMap<string, string>, content: XpSnapshot, mod: any, maxLevel: number): void {
  const reach = computeReach(content, mod, maxLevel);
  const zeroKeys = new Set(tables.filter(t => t.kind === 'room' && t.zeroXp).map(t => t.key));
  const grids = reach ? buildGrids(content, mod) : null;
  const tileById = new Map<string, any>((content.world.tiles as any[]).map(t => [t.id, t]));
  const levelByKey = new Map<string, number>();
  const borderByKey = new Map<string, number>();
  for (const [tileId, key] of tileKeys) {
    const level = reach?.tileLevel.get(tileId);
    if (level !== undefined) levelByKey.set(key, Math.min(levelByKey.get(key) ?? Infinity, level));
    if (!grids || zeroKeys.has(key)) continue;
    const grid = grids.get(tileById.get(tileId).mapId);
    const borders = grid.getAllNeighbors(grid.getTileById(tileId).coord).some((n: any) => n.isTraversable && zeroKeys.has(tileKeys.get(n.id) ?? ''));
    if (borders) borderByKey.set(key, (borderByKey.get(key) ?? 0) + 1);
  }
  for (const table of tables) {
    table.zeroNeighbourTiles = borderByKey.get(table.key) ?? 0;
    if (!reach) continue;
    if (table.kind === 'room') {
      table.reachLevel = levelByKey.get(table.key) ?? null;
    } else {
      const entrance = (content.world.tiles as any[]).find(t => t.dungeonId === table.dungeonId);
      table.reachLevel = entrance ? reach.tileLevel.get(entrance.id) ?? null : null;
    }
  }
}

/** Whether a member of this level can stand in this table's rooms. */
export function memberReaches(table: XpTable, lowestMemberLevel: number): boolean {
  if (table.reachLevel === undefined) return true;
  return table.reachLevel !== null && lowestMemberLevel >= table.reachLevel;
}
