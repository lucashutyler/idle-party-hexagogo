import type {
  CompletedQuestEntry,
  MainStoryStep,
  NpcDefinition,
  QuestGuide,
  QuestProgressEntry,
  QuestStatus,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';

export interface CompletedQuestSummary {
  questId: string;
  lastCompletedAt: string;
  timesCompleted: number;
}

export interface NpcLocation {
  npcName: string;
  npcEmoji: string;
  roomId?: string;
  mapId?: string;
  roomName?: string;
  zoneName?: string;
  /** Set on quest-giver rows: this NPC hands out a main-story quest the player can take now. */
  main?: boolean;
}

export interface SplitQuests {
  main: QuestProgressEntry[];
  other: QuestProgressEntry[];
}

export type NpcRoom = Pick<WorldTileDefinition, 'id' | 'mapId' | 'name' | 'zoneName'>;

// must match the weekly cooldown in canAcceptQuest (shared QuestTypes.ts)
export const WEEKLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

const STATUS_RANK: Record<QuestStatus, number> = {
  ready: 0,
  in_progress: 1,
  accepted: 2,
  completed: 3,
};

/** Ready-to-turn-in first, then in progress, then untouched; oldest accepted first within each. */
export function sortActiveQuests(entries: readonly QuestProgressEntry[]): QuestProgressEntry[] {
  return [...entries].sort((a, b) =>
    STATUS_RANK[a.status] - STATUS_RANK[b.status] || timeOf(a.acceptedAt) - timeOf(b.acceptedAt));
}

/** One row per quest (weekly quests repeat in the history), most recently completed first. */
export function summarizeCompletedQuests(completed: readonly CompletedQuestEntry[]): CompletedQuestSummary[] {
  const byQuest = new Map<string, CompletedQuestSummary>();
  for (const { questId, completedAt } of completed) {
    const row = byQuest.get(questId);
    if (!row) {
      byQuest.set(questId, { questId, lastCompletedAt: completedAt, timesCompleted: 1 });
      continue;
    }
    row.timesCompleted++;
    if (timeOf(completedAt) > timeOf(row.lastCompletedAt)) row.lastCompletedAt = completedAt;
  }
  return [...byQuest.values()].sort((a, b) => timeOf(b.lastCompletedAt) - timeOf(a.lastCompletedAt));
}

/** When a weekly quest completed at `lastCompletedAt` can be taken again, or null if it already can. */
export function weeklyAvailableAgainAt(lastCompletedAt: string, now: Date = new Date()): Date | null {
  const availableAt = timeOf(lastCompletedAt) + WEEKLY_COOLDOWN_MS;
  return availableAt > now.getTime() ? new Date(availableAt) : null;
}

/**
 * Every NPC that accepts the quest, with one entry per explored room it stands in.
 * An NPC whose rooms are all unexplored is still named, without a room; one placed nowhere is skipped.
 */
export function turnInLocations(
  questId: string,
  npcs: readonly NpcDefinition[],
  roomsWithNpc: (npcId: string) => readonly NpcRoom[],
  unlockedIds: ReadonlySet<string>,
): NpcLocation[] {
  const locations: NpcLocation[] = [];
  for (const npc of npcs) {
    if (!npc.questIds?.includes(questId)) continue;
    const rooms = roomsWithNpc(npc.id);
    if (rooms.length === 0) continue;
    const explored = rooms.filter(room => unlockedIds.has(room.id));
    if (explored.length === 0) {
      locations.push({ npcName: npc.name, npcEmoji: npc.emoji });
      continue;
    }
    for (const room of explored) {
      locations.push(locationIn(npc, room));
    }
  }
  return locations;
}

/**
 * Every explored room where an NPC who can hand out one of `availableQuestIds` stands: those with a
 * main-story quest first, then those on `currentMapId`.
 */
export function giverLocations(
  availableQuestIds: Iterable<string>,
  npcs: readonly NpcDefinition[],
  roomsWithNpc: (npcId: string) => readonly NpcRoom[],
  unlockedIds: ReadonlySet<string>,
  mainQuestIds: Iterable<string> = [],
  currentMapId?: string,
): NpcLocation[] {
  const available = new Set(availableQuestIds);
  if (available.size === 0) return [];
  const main = new Set([...mainQuestIds].filter(id => available.has(id)));
  const locations: NpcLocation[] = [];
  for (const npc of npcs) {
    if (!npc.questIds?.some(id => available.has(id))) continue;
    const offersMain = npc.questIds.some(id => main.has(id));
    for (const room of roomsWithNpc(npc.id)) {
      if (!unlockedIds.has(room.id)) continue;
      locations.push({ ...locationIn(npc, room), main: offersMain });
    }
  }
  return locations.sort((a, b) =>
    Number(b.main) - Number(a.main) || onMap(b, currentMapId) - onMap(a, currentMapId));
}

/** Active quests split into the main story, in the guide's order, and the rest. Without a guide everything is "other". */
export function splitMainQuests(entries: readonly QuestProgressEntry[], guide: QuestGuide | undefined): SplitQuests {
  const sorted = sortActiveQuests(entries);
  if (!guide) return { main: [], other: sorted };
  const mainIds = new Set(guide.mainQuestIds);
  const stepOrder = new Map<string, number>();
  guide.steps.forEach((step, i) => {
    if (step.status === 'active') stepOrder.set(step.questId, i);
  });
  const rank = (entry: QuestProgressEntry) => stepOrder.get(entry.questId) ?? guide.steps.length;
  const main = sorted.filter(entry => mainIds.has(entry.questId) || stepOrder.has(entry.questId));
  const other = sorted.filter(entry => !mainIds.has(entry.questId) && !stepOrder.has(entry.questId));
  return { main: main.sort((a, b) => rank(a) - rank(b)), other };
}

/** Every room a step's givers stand in, unexplored ones too: explored first, then those on `currentMapId`. */
export function stepGiverLocations(
  step: Pick<MainStoryStep, 'giverNpcIds'>,
  npcs: readonly NpcDefinition[],
  roomsWithNpc: (npcId: string) => readonly NpcRoom[],
  unlockedIds: ReadonlySet<string>,
  currentMapId?: string,
): NpcLocation[] {
  const giverIds = new Set(step.giverNpcIds ?? []);
  const explored = (loc: NpcLocation) => Number(!!loc.roomId && unlockedIds.has(loc.roomId));
  const locations: NpcLocation[] = [];
  for (const npc of npcs) {
    if (!giverIds.has(npc.id)) continue;
    for (const room of roomsWithNpc(npc.id)) locations.push(locationIn(npc, room));
  }
  return locations.sort((a, b) => explored(b) - explored(a) || onMap(b, currentMapId) - onMap(a, currentMapId));
}

/** The one upcoming step worth showing: the first whose giver stands on `currentMapId`, else the first anywhere. */
export function nextStoryStep(
  guide: QuestGuide | undefined,
  roomsWithNpc: (npcId: string) => readonly NpcRoom[],
  currentMapId?: string,
): MainStoryStep | undefined {
  const upcoming = (guide?.steps ?? []).filter(step => step.status !== 'active');
  const onThisMap = upcoming.find(step =>
    (step.giverNpcIds ?? []).some(npcId => roomsWithNpc(npcId).some(room => room.mapId === currentMapId)));
  return onThisMap ?? upcoming[0];
}

/** Someone in this room has a quest the player can take now. */
export function questOfferedHere(
  state: { offeredQuestIds?: readonly string[]; availableQuestIds?: readonly string[] } | null | undefined,
): boolean {
  const available = new Set(state?.availableQuestIds ?? []);
  return (state?.offeredQuestIds ?? []).some(id => available.has(id));
}

function locationIn(npc: NpcDefinition, room: NpcRoom): NpcLocation {
  return {
    npcName: npc.name,
    npcEmoji: npc.emoji,
    roomId: room.id,
    mapId: room.mapId,
    roomName: room.name,
    zoneName: room.zoneName,
  };
}

function onMap(loc: NpcLocation, mapId: string | undefined): number {
  return Number(mapId !== undefined && loc.mapId === mapId);
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
