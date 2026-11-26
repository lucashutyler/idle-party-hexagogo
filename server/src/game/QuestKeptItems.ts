import type { QuestDefinition } from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';

type QuestKeptContent = Pick<
  ContentStore,
  'contentEpoch' | 'getQuestCatalog' | 'getNpcQuestIds' | 'getAllMonsters' | 'getAllShops' | 'getAllRecipes' | 'getAllDungeons'
>;

const questOnlyItems = new WeakMap<QuestKeptContent, { epoch: number; items: ReadonlyMap<string, readonly string[]> }>();

/**
 * Items a one-time quest some NPC offers collects that no drop, shop, recipe, dungeon or repeatable
 * quest hands out, each with the one-time quests that collect it. Rebuilt once per content change.
 * See docs/architecture/content.md → Quest items.
 */
export function questOnlyCollectItems(content: QuestKeptContent): ReadonlyMap<string, readonly string[]> {
  const known = questOnlyItems.get(content);
  if (known && known.epoch === content.contentEpoch) return known.items;
  const items = buildQuestOnlyCollectItems(content);
  questOnlyItems.set(content, { epoch: content.contentEpoch, items });
  return items;
}

function buildQuestOnlyCollectItems(content: QuestKeptContent): Map<string, string[]> {
  const quests = Object.values(content.getQuestCatalog());
  const offered = new Set(content.getNpcQuestIds());
  const collectedBy = new Map<string, string[]>();
  for (const quest of quests) {
    if (!isOnceQuest(quest) || !offered.has(quest.id)) continue;
    for (const objective of quest.objectives) {
      if (objective.kind !== 'collect') continue;
      const questIds = collectedBy.get(objective.itemId) ?? [];
      if (!questIds.includes(quest.id)) questIds.push(quest.id);
      collectedBy.set(objective.itemId, questIds);
    }
  }
  if (collectedBy.size === 0) return collectedBy;

  for (const itemId of otherSourceItemIds(content, quests)) collectedBy.delete(itemId);
  return collectedBy;
}

function* otherSourceItemIds(content: QuestKeptContent, quests: readonly QuestDefinition[]): Iterable<string> {
  for (const monster of Object.values(content.getAllMonsters())) {
    for (const drop of monster.drops ?? []) yield drop.itemId;
  }
  for (const shop of Object.values(content.getAllShops())) {
    for (const entry of shop.inventory) yield entry.itemId;
  }
  for (const recipe of Object.values(content.getAllRecipes())) yield recipe.result.itemId;
  for (const dungeon of Object.values(content.getAllDungeons())) {
    for (const reward of dungeon.firstClearRewards ?? []) yield reward.itemId;
    for (const floor of dungeon.floors) {
      for (const reward of floor.rewards ?? []) yield reward.itemId;
    }
  }
  for (const quest of quests) {
    if (isOnceQuest(quest)) continue;
    for (const reward of quest.rewards) {
      if (reward.kind === 'item') yield reward.itemId;
    }
  }
}

function isOnceQuest(quest: QuestDefinition): boolean {
  return (quest.repeat ?? 'once') === 'once';
}
