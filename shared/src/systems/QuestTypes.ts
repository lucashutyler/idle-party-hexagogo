// --- Quest types ---

export type QuestStatus = 'accepted' | 'in_progress' | 'ready' | 'completed';

/** Quest scope: solo (only own actions count) or party_shared (any member's action credits the party). */
export type QuestScope = 'solo' | 'party_shared';

export type QuestRepeat = 'once' | 'weekly';

/** Kill objective — kill `count` of `monsterId`. */
export interface KillObjective {
  kind: 'kill';
  monsterId: string;
  count: number;
}

/** Collect objective — own `count` of `itemId` (checked dynamically against inventory). */
export interface CollectObjective {
  kind: 'collect';
  itemId: string;
  count: number;
}

/** Visit objective — set foot on `tileId`. Always count: 1. */
export interface VisitObjective {
  kind: 'visit';
  tileId: string;
}

export type QuestObjective = KillObjective | CollectObjective | VisitObjective;

export interface XpReward { kind: 'xp'; amount: number; }
export interface GoldReward { kind: 'gold'; amount: number; }
export interface ItemReward { kind: 'item'; itemId: string; quantity: number; }

export type QuestReward = XpReward | GoldReward | ItemReward;

export interface QuestDefinition {
  id: string;
  name: string;
  description: string;
  scope: QuestScope;
  objectives: QuestObjective[];
  rewards: QuestReward[];
  /** Quest IDs that must be completed before this one can be accepted. */
  prerequisiteQuestIds?: string[];
  /** Minimum player level required to accept. */
  requiredLevel?: number;
  /** Repeat cadence. Defaults to 'once'. */
  repeat?: QuestRepeat;
  /** NPC speech shown to the player after they turn in this quest. */
  completionText?: string;
}

/**
 * Per-player progress for an accepted quest.
 * `progress` is a parallel array — index matches `objectives` index.
 * For kill/visit: integer count up to objective.count (visit max = 1).
 * For collect: snapshot of last computed inventory count.
 */
export interface QuestProgressEntry {
  questId: string;
  status: QuestStatus;
  progress: number[];
  acceptedAt: string;
}

/** Per-player history of completed (turned-in) quests. */
export interface CompletedQuestEntry {
  questId: string;
  completedAt: string;
}

// --- Helpers ---

/** Get the target count for an objective (1 for visit, N for kill/collect). */
export function getObjectiveTarget(obj: QuestObjective): number {
  return obj.kind === 'visit' ? 1 : obj.count;
}

/** True if every objective hits its target. */
export function objectivesComplete(quest: QuestDefinition, progress: number[]): boolean {
  if (progress.length !== quest.objectives.length) return false;
  for (let i = 0; i < quest.objectives.length; i++) {
    if (progress[i] < getObjectiveTarget(quest.objectives[i])) return false;
  }
  return true;
}

/** Compute the status from progress numbers. */
export function computeStatus(quest: QuestDefinition, progress: number[]): QuestStatus {
  if (objectivesComplete(quest, progress)) return 'ready';
  const anyProgress = progress.some(p => p > 0);
  return anyProgress ? 'in_progress' : 'accepted';
}

export const SOLO_QUEST_IN_PARTY_REASON = 'Solo quest — leave your party first.';
export const WEEKLY_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;

export interface QuestAcceptContext {
  playerLevel: number;
  activeQuestIds: ReadonlySet<string>;
  completedQuestIds: ReadonlySet<string>;
  weeklyCompletions: Readonly<Record<string, string>>;
  now?: Date;
  /** Player members only (henchmen don't count). Omit to skip the solo-scope check. */
  partySize?: number;
}

/**
 * Check whether a player can accept a quest right now.
 * Returns null if acceptable, or a string reason if blocked.
 */
export function canAcceptQuest(quest: QuestDefinition, ctx: QuestAcceptContext): string | null {
  if (ctx.activeQuestIds.has(quest.id)) return 'Already accepted.';

  if (quest.requiredLevel != null && ctx.playerLevel < quest.requiredLevel) {
    return `Requires level ${quest.requiredLevel}.`;
  }

  if (quest.prerequisiteQuestIds && quest.prerequisiteQuestIds.length > 0) {
    for (const prereqId of quest.prerequisiteQuestIds) {
      if (!ctx.completedQuestIds.has(prereqId)) return 'Prerequisite quest not completed.';
    }
  }

  const repeat = quest.repeat ?? 'once';
  if (repeat === 'once') {
    if (ctx.completedQuestIds.has(quest.id)) return 'Already completed.';
  } else if (repeat === 'weekly') {
    const lastIso = ctx.weeklyCompletions[quest.id];
    if (lastIso) {
      const lastDate = new Date(lastIso);
      const now = ctx.now ?? new Date();
      const diffMs = now.getTime() - lastDate.getTime();
      if (diffMs < WEEKLY_COOLDOWN_MS) return 'Available again next week.';
    }
  }

  if (quest.scope === 'solo' && ctx.partySize !== undefined && ctx.partySize > 1) {
    return SOLO_QUEST_IN_PARTY_REASON;
  }

  return null;
}

/**
 * The ids among `questIds` this player can accept now, deduped and sorted.
 * Unknown ids are skipped. Party size is ignored, so a solo quest still counts while partied.
 */
export function acceptableQuestIds(
  questIds: Iterable<string>,
  quests: Readonly<Record<string, QuestDefinition>>,
  ctx: Omit<QuestAcceptContext, 'partySize'>,
): string[] {
  const acceptable = new Set<string>();
  for (const id of questIds) {
    const quest = quests[id];
    if (quest && canAcceptQuest(quest, ctx) === null) acceptable.add(id);
  }
  return [...acceptable].sort();
}

/** The earliest time after `nowMs` that a weekly cooldown in `weeklyCompletions` ends, or Infinity. */
export function nextWeeklyReopening(weeklyCompletions: Readonly<Record<string, string>>, nowMs: number): number {
  let next = Infinity;
  for (const iso of Object.values(weeklyCompletions)) {
    const reopensAt = new Date(iso).getTime() + WEEKLY_COOLDOWN_MS;
    if (reopensAt > nowMs && reopensAt < next) next = reopensAt;
  }
  return next;
}

/** Initialize a fresh progress array for a quest (all zeros). */
export function initialProgress(quest: QuestDefinition): number[] {
  return quest.objectives.map(() => 0);
}
