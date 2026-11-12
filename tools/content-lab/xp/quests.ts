import type { Region } from '../policy.js';
import type { XpSnapshot } from './types.js';

export interface QuestLump {
  id: string;
  name: string;
  xp: number;
  /** The lowest region among the NPCs listing this quest, else of a room it sends the player to. */
  regionIndex: number | null;
  /** Every region its NPCs and objectives need; a kill objective counts only when its monster lives nowhere else. */
  needsRegions: number[];
  requiredLevel: number;
  /** Earliest level a player who journeys can have this: own level, its prerequisites, its region's entry level. */
  availableAt: number;
  prerequisites: string[];
  repeat: string;
}

export interface QuestLedger {
  once: QuestLump[];
  repeatable: QuestLump[];
  /** Quests left out of both lists: no XP reward. */
  noXp: number;
  /** Prerequisite ids that name no quest. */
  danglingPrerequisites: string[];
  cycles: string[];
}

export function regionEntryLevel(content: XpSnapshot, region: Region): number {
  const lows = region.zoneIds.map(id => content.zones[id].levelRange[0]);
  return lows.length ? Math.min(...lows) : 1;
}

function questXp(quest: any): number {
  return (quest.rewards ?? []).reduce((sum: number, r: any) => sum + (r.kind === 'xp' ? r.amount ?? 0 : 0), 0);
}

function monsterRegions(content: XpSnapshot, regions: readonly Region[]): Map<string, Set<number>> {
  const zoneRegion = new Map<string, number>();
  for (const region of regions) for (const zoneId of region.zoneIds) zoneRegion.set(zoneId, region.index);
  const found = new Map<string, Set<number>>();
  const addTable = (table: readonly { encounterId: string }[] | undefined, regionIndex: number | undefined): void => {
    if (regionIndex === undefined) return;
    for (const { encounterId } of table ?? []) {
      const encounter = content.encounters[encounterId];
      for (const m of [...(encounter?.placements ?? []), ...(encounter?.monsterPool ?? [])]) {
        const set = found.get(m.monsterId) ?? new Set<number>();
        set.add(regionIndex);
        found.set(m.monsterId, set);
      }
    }
  };
  for (const tile of content.world.tiles) {
    const regionIndex = zoneRegion.get(tile.zone);
    addTable(tile.encounterTable?.length ? tile.encounterTable : content.zones[tile.zone]?.encounterTable, regionIndex);
    if (tile.dungeonId) for (const floor of content.dungeons[tile.dungeonId]?.floors ?? []) addTable(floor.encounterTable, regionIndex);
  }
  return found;
}

/** Quests belong to the regions of the NPCs listing them; a quest can name an NPC far from its level. */
export function buildQuestLedger(content: XpSnapshot, regions: readonly Region[]): QuestLedger {
  const quests = (content.quests ?? {}) as Record<string, any>;
  const regionByMap = new Map(regions.map(r => [r.id, r]));
  const npcRegion = new Map<string, Region>();
  for (const tile of content.world.tiles as any[]) {
    const region = regionByMap.get(tile.mapId);
    if (tile.npcId && region && !npcRegion.has(tile.npcId)) npcRegion.set(tile.npcId, region);
  }
  const giverRegions = new Map<string, Region[]>();
  for (const npc of Object.values(content.npcs ?? {}) as any[]) {
    const region = npcRegion.get(npc.id);
    if (!region) continue;
    for (const questId of npc.questIds ?? []) giverRegions.set(questId, [...(giverRegions.get(questId) ?? []), region]);
  }
  const tileRegion = new Map<string, number>();
  for (const tile of content.world.tiles) {
    const region = regionByMap.get(tile.mapId);
    if (region) tileRegion.set(tile.id, region.index);
  }
  const monsterHome = monsterRegions(content, regions);
  const neededRegions = (quest: any): number[] => {
    const needed = new Set((giverRegions.get(quest.id) ?? []).map(r => r.index));
    for (const objective of quest.objectives ?? []) {
      if (objective.kind === 'visit' && tileRegion.has(objective.tileId)) needed.add(tileRegion.get(objective.tileId)!);
      if (objective.kind === 'kill') {
        const homes = monsterHome.get(objective.monsterId);
        if (homes?.size === 1) needed.add([...homes][0]);
      }
    }
    return [...needed].sort((a, b) => a - b);
  };
  const regionOf = (quest: any): Region | undefined => {
    const givers = giverRegions.get(quest.id);
    if (givers?.length) return givers.reduce((low, r) => (r.index < low.index ? r : low));
    const needed = neededRegions(quest);
    return needed.length ? regions[needed[0]] : undefined;
  };

  const dangling = new Set<string>();
  const cycles = new Set<string>();
  const memo = new Map<string, number>();
  const availableAt = (id: string, seen: ReadonlySet<string>): number => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const quest = quests[id];
    if (!quest) {
      dangling.add(id);
      return 1;
    }
    if (seen.has(id)) {
      cycles.add(id);
      return 1;
    }
    const nextSeen = new Set(seen).add(id);
    const region = regionOf(quest);
    let level = Math.max(quest.requiredLevel ?? 1, region ? regionEntryLevel(content, region) : 1);
    for (const prerequisite of quest.prerequisiteQuestIds ?? []) level = Math.max(level, availableAt(prerequisite, nextSeen));
    memo.set(id, level);
    return level;
  };

  const once: QuestLump[] = [];
  const repeatable: QuestLump[] = [];
  let noXp = 0;
  for (const quest of Object.values(quests)) {
    const xp = questXp(quest);
    if (!(xp > 0)) {
      noXp++;
      continue;
    }
    const lump: QuestLump = {
      id: quest.id,
      name: quest.name,
      xp,
      regionIndex: regionOf(quest)?.index ?? null,
      needsRegions: neededRegions(quest),
      requiredLevel: quest.requiredLevel ?? 1,
      availableAt: availableAt(quest.id, new Set()),
      prerequisites: quest.prerequisiteQuestIds ?? [],
      repeat: quest.repeat ?? 'once',
    };
    (lump.repeat === 'once' ? once : repeatable).push(lump);
  }
  return { once, repeatable, noXp, danglingPrerequisites: [...dangling], cycles: [...cycles] };
}

/** Days between pay-outs of a repeatable quest. */
const REPEAT_PERIOD_DAYS: Readonly<Record<string, number>> = { weekly: 7 };

/** XP/hr equivalent of doing every repeatable quest of this list available at this level, on time. */
export function repeatableXpPerHour(quests: readonly QuestLump[], level: number): number {
  let total = 0;
  for (const quest of quests) {
    const period = REPEAT_PERIOD_DAYS[quest.repeat];
    if (period && quest.availableAt <= level) total += quest.xp / (period * 24);
  }
  return total;
}

/** Only quests whose NPCs, objectives and whole prerequisite chain stay inside `regionIndex`: what someone who never leaves can finish. */
export function questsWithinRegion(ledger: QuestLedger, regionIndex: number): QuestLump[] {
  return withinRegion(ledger, regionIndex).filter(q => q.repeat === 'once');
}

export function repeatablesWithinRegion(ledger: QuestLedger, regionIndex: number): QuestLump[] {
  return withinRegion(ledger, regionIndex).filter(q => q.repeat !== 'once');
}

function withinRegion(ledger: QuestLedger, regionIndex: number): QuestLump[] {
  const all = new Map([...ledger.once, ...ledger.repeatable].map(q => [q.id, q]));
  const memo = new Map<string, boolean>();
  const reachable = (id: string, seen: ReadonlySet<string>): boolean => {
    const known = memo.get(id);
    if (known !== undefined) return known;
    const quest = all.get(id);
    if (seen.has(id)) return false;
    if (!quest) return true;
    const nextSeen = new Set(seen).add(id);
    const ok = quest.regionIndex === regionIndex && quest.needsRegions.every(r => r === regionIndex) && quest.prerequisites.every(p => reachable(p, nextSeen));
    memo.set(id, ok);
    return ok;
  };
  return [...all.values()].filter(q => reachable(q.id, new Set()));
}
