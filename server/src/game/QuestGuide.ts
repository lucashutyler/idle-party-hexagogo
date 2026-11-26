import { canAcceptQuest, isMainQuest } from '@idle-party-rpg/shared';
import type {
  MainStoryStep,
  MainStoryStepStatus,
  NpcDefinition,
  QuestAcceptContext,
  QuestDefinition,
  QuestGuide,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

/** Steps kept after every active one. */
export const MAIN_STORY_UPCOMING_STEPS = 3;

export interface QuestGivers {
  /** NPCs who offer the quest and stand in at least one room. */
  npcIds: readonly string[];
  mapIds: ReadonlySet<string>;
}

export interface MainStoryInput {
  catalog: Readonly<Record<string, QuestDefinition>>;
  completedIds: ReadonlySet<string>;
  activeIds: ReadonlySet<string>;
  level: number;
  weeklyCompletions: Readonly<Record<string, string>>;
  now: Date;
  givers: ReadonlyMap<string, QuestGivers>;
  currentMapId: string;
}

type GiverContent = Pick<ContentStore, 'contentEpoch' | 'getQuestRevision' | 'getAllNpcs' | 'getWorld'>;

const STATUS_RANK: Record<MainStoryStepStatus, number> = { active: 0, available: 1, needs_level: 2 };

const giverIndexes = new WeakMap<GiverContent, { epoch: number; revision: number; givers: ReadonlyMap<string, QuestGivers> }>();

/** The guide for the state push. See docs/architecture/content.md → Main story. */
export function buildQuestGuide(input: MainStoryInput, availableIds: Iterable<string>): QuestGuide {
  const mainQuestIds = new Set<string>();
  for (const id of [...input.activeIds, ...availableIds]) {
    const quest = input.catalog[id];
    if (quest && isMainQuest(quest)) mainQuestIds.add(id);
  }
  return { steps: mainStorySteps(input), mainQuestIds: [...mainQuestIds].sort() };
}

/** What the player can work on next to move the main story along, best first. */
export function mainStorySteps(input: MainStoryInput): MainStoryStep[] {
  const ranked: { step: MainStoryStep; onThisMap: boolean; level: number }[] = [];
  for (const [questId, leadsTo] of unfinishedStoryQuests(input.catalog, input.completedIds)) {
    const quest = input.catalog[questId];
    const status = stepStatus(quest, input);
    if (!status) continue;
    const givers = input.givers.get(questId);
    if (status !== 'active' && !givers?.npcIds.length) continue;

    const step: MainStoryStep = { questId, name: quest.name, status };
    if (quest.requiredLevel != null) step.requiredLevel = quest.requiredLevel;
    if (leadsTo !== undefined) step.leadsTo = leadsTo;
    if (givers?.npcIds.length) step.giverNpcIds = [...givers.npcIds];
    ranked.push({ step, onThisMap: givers?.mapIds.has(input.currentMapId) ?? false, level: quest.requiredLevel ?? 0 });
  }

  ranked.sort((a, b) =>
    STATUS_RANK[a.step.status] - STATUS_RANK[b.step.status]
    || Number(b.onThisMap) - Number(a.onThisMap)
    || a.level - b.level
    || (a.step.questId < b.step.questId ? -1 : 1));

  let upcoming = 0;
  return ranked
    .filter(({ step }) => step.status === 'active' || upcoming++ < MAIN_STORY_UPCOMING_STEPS)
    .map(({ step }) => step);
}

/** Who offers each quest from a room, and on which maps; rebuilt once per content change. */
export function questGivers(content: GiverContent): ReadonlyMap<string, QuestGivers> {
  const known = giverIndexes.get(content);
  if (known && known.epoch === content.contentEpoch && known.revision === content.getQuestRevision()) return known.givers;
  const givers = buildQuestGivers(Object.values(content.getAllNpcs()), content.getWorld().tiles);
  giverIndexes.set(content, { epoch: content.contentEpoch, revision: content.getQuestRevision(), givers });
  return givers;
}

export function buildQuestGivers(
  npcs: readonly NpcDefinition[],
  tiles: readonly Pick<WorldTileDefinition, 'npcId' | 'mapId'>[],
): Map<string, QuestGivers> {
  const npcMaps = new Map<string, Set<string>>();
  for (const tile of tiles) {
    if (!tile.npcId) continue;
    const maps = npcMaps.get(tile.npcId) ?? new Set<string>();
    maps.add(tile.mapId);
    npcMaps.set(tile.npcId, maps);
  }

  const givers = new Map<string, { npcIds: string[]; mapIds: Set<string> }>();
  for (const npc of npcs) {
    const maps = npcMaps.get(npc.id);
    if (!maps) continue;
    for (const questId of new Set(npc.questIds ?? [])) {
      const entry = givers.get(questId) ?? { npcIds: [], mapIds: new Set<string>() };
      entry.npcIds.push(npc.id);
      for (const mapId of maps) entry.mapIds.add(mapId);
      givers.set(questId, entry);
    }
  }
  for (const entry of givers.values()) entry.npcIds.sort();
  return givers;
}

/**
 * Every unfinished one-time main quest and every unfinished quest it waits on. A quest that isn't main
 * maps to the name of the nearest main quest it unblocks; a main one to undefined.
 */
function unfinishedStoryQuests(
  catalog: Readonly<Record<string, QuestDefinition>>,
  completedIds: ReadonlySet<string>,
): Map<string, string | undefined> {
  const found = new Map<string, string | undefined>();
  const queue: QuestDefinition[] = [];
  for (const quest of Object.values(catalog)) {
    if (!isMainQuest(quest) || (quest.repeat ?? 'once') !== 'once' || completedIds.has(quest.id)) continue;
    found.set(quest.id, undefined);
    queue.push(quest);
  }
  for (let i = 0; i < queue.length; i++) {
    const quest = queue[i];
    const unblocks = isMainQuest(quest) ? quest.name : found.get(quest.id);
    for (const prereqId of quest.prerequisiteQuestIds ?? []) {
      const prereq = catalog[prereqId];
      if (!prereq || completedIds.has(prereqId) || found.has(prereqId)) continue;
      found.set(prereqId, isMainQuest(prereq) ? undefined : unblocks);
      queue.push(prereq);
    }
  }
  return found;
}

/** Null when the player can't take the quest now and levelling up wouldn't change that. */
function stepStatus(quest: QuestDefinition, input: MainStoryInput): MainStoryStepStatus | null {
  if (input.activeIds.has(quest.id)) return 'active';
  const ctx: QuestAcceptContext = {
    playerLevel: input.level,
    activeQuestIds: input.activeIds,
    completedQuestIds: input.completedIds,
    weeklyCompletions: input.weeklyCompletions,
    now: input.now,
  };
  if (canAcceptQuest(quest, ctx) === null) return 'available';
  if (canAcceptQuest(quest, { ...ctx, playerLevel: Infinity }) === null) return 'needs_level';
  return null;
}
