import type { QuestDefinition } from './QuestTypes.js';
import type { QuestStepInfo, QuestStepState } from './RoomLock.js';

/** How deep a prerequisite chain is followed; authored chains are far shorter. */
export const QUEST_CHAIN_DEPTH_CAP = 200;

export interface QuestChainProgress {
  completed: ReadonlySet<string>;
  active: ReadonlySet<string>;
  level: number;
}

const STATE_RANK: Record<QuestStepState, number> = { active: 0, available: 1, needs_level: 2, unavailable: 3 };

/**
 * The quest a player can work on now that leads to `targetId`, or null once the target is done or unknown.
 * See docs/architecture/content.md → Lock info.
 */
export function nextQuestStep(
  targetId: string,
  quests: Readonly<Record<string, QuestDefinition>>,
  progress: QuestChainProgress,
  isOffered: (questId: string) => boolean,
): QuestStepInfo | null {
  const target = quests[targetId];
  if (!target || progress.completed.has(targetId)) return null;

  const unfinished = unfinishedClosure(target, quests, progress.completed);
  let best: { quest: QuestDefinition; state: QuestStepState } | null = null;
  for (const quest of unfinished) {
    if (!(quest.prerequisiteQuestIds ?? []).every(id => progress.completed.has(id))) continue;
    const state = stepState(quest, progress, isOffered);
    if (!best || isBetterStep(quest, state, best.quest, best.state)) best = { quest, state };
  }

  const step = best ?? { quest: target, state: 'unavailable' as const };
  return {
    questId: step.quest.id,
    questName: step.quest.name,
    state: step.state,
    ...(step.quest.requiredLevel !== undefined ? { requiredLevel: step.quest.requiredLevel } : {}),
    remaining: unfinished.length,
  };
}

/** The target and every unfinished quest it waits on, depth first. */
function unfinishedClosure(
  target: QuestDefinition,
  quests: Readonly<Record<string, QuestDefinition>>,
  completed: ReadonlySet<string>,
): QuestDefinition[] {
  const found: QuestDefinition[] = [];
  const visited = new Set<string>();
  const visit = (quest: QuestDefinition, depth: number): void => {
    visited.add(quest.id);
    found.push(quest);
    if (depth >= QUEST_CHAIN_DEPTH_CAP) return;
    for (const id of quest.prerequisiteQuestIds ?? []) {
      const prereq = quests[id];
      if (!prereq || visited.has(id) || completed.has(id)) continue;
      visit(prereq, depth + 1);
    }
  };
  visit(target, 0);
  return found;
}

function stepState(quest: QuestDefinition, progress: QuestChainProgress, isOffered: (questId: string) => boolean): QuestStepState {
  if (progress.active.has(quest.id)) return 'active';
  if (!isOffered(quest.id)) return 'unavailable';
  return (quest.requiredLevel ?? 0) <= progress.level ? 'available' : 'needs_level';
}

/** A better rank wins, then the lower required level; on a tie the earlier quest in depth-first order stays. */
function isBetterStep(quest: QuestDefinition, state: QuestStepState, best: QuestDefinition, bestState: QuestStepState): boolean {
  if (STATE_RANK[state] !== STATE_RANK[bestState]) return STATE_RANK[state] < STATE_RANK[bestState];
  return (quest.requiredLevel ?? 0) < (best.requiredLevel ?? 0);
}
