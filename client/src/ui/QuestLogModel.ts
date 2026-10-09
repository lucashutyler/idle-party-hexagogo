import type {
  CompletedQuestEntry,
  NpcDefinition,
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
  roomName?: string;
  zoneName?: string;
}

export type NpcRoom = Pick<WorldTileDefinition, 'id' | 'name' | 'zoneName'>;

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
      locations.push({ npcName: npc.name, npcEmoji: npc.emoji, roomName: room.name, zoneName: room.zoneName });
    }
  }
  return locations;
}

/** Every explored room where an NPC who can hand out one of `availableQuestIds` stands. */
export function giverLocations(
  availableQuestIds: Iterable<string>,
  npcs: readonly NpcDefinition[],
  roomsWithNpc: (npcId: string) => readonly NpcRoom[],
  unlockedIds: ReadonlySet<string>,
): NpcLocation[] {
  const available = new Set(availableQuestIds);
  if (available.size === 0) return [];
  const locations: NpcLocation[] = [];
  for (const npc of npcs) {
    if (!npc.questIds?.some(id => available.has(id))) continue;
    for (const room of roomsWithNpc(npc.id)) {
      if (!unlockedIds.has(room.id)) continue;
      locations.push({ npcName: npc.name, npcEmoji: npc.emoji, roomName: room.name, zoneName: room.zoneName });
    }
  }
  return locations;
}

function timeOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}
