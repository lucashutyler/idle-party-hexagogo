import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { migrateLegacySet } from '@idle-party-rpg/shared';
import type { ContentSnapshot } from '../../game/VersionStore.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/**
 * Run every referential-integrity check against a draft's content snapshot.
 * Collects every problem found (no early return) so an AI-authored batch of
 * content gets a complete report before a human ever reviews it.
 */
function collectProblems(snapshot: ContentSnapshot): string[] {
  const problems: string[] = [];

  const monsterIds = new Set(snapshot.monsters.map(m => m.id));
  const itemIds = new Set(snapshot.items.map(i => i.id));
  const zoneIds = new Set(snapshot.zones.map(z => z.id));
  const encounterIds = new Set((snapshot.encounters ?? []).map(e => e.id));
  const shopIds = new Set((snapshot.shops ?? []).map(s => s.id));
  const npcIds = new Set((snapshot.npcs ?? []).map(n => n.id));
  const questIds = new Set((snapshot.quests ?? []).map(q => q.id));
  const dungeonIds = new Set((snapshot.dungeons ?? []).map(d => d.id));
  const tileTypeIds = new Set((snapshot.tileTypes ?? []).map(t => t.id));
  const skillIds = new Set((snapshot.skills ?? []).map(s => s.id));
  const mapIds = new Set(snapshot.world.maps.map(m => m.id));
  const tileById = new Map(snapshot.world.tiles.map(t => [t.id, t]));

  // --- Zones ---
  for (const zone of snapshot.zones) {
    zone.encounterTable.forEach((entry, index) => {
      if (!encounterIds.has(entry.encounterId)) {
        problems.push(`Zone '${zone.id}' encounter table references unknown encounter '${entry.encounterId}' (index ${index}).`);
      }
    });
  }

  // --- Tiles: encounter table, zone/type/shop/npc/dungeon/requiredItemId, mapId ---
  for (const tile of snapshot.world.tiles) {
    (tile.encounterTable ?? []).forEach((entry, index) => {
      if (!encounterIds.has(entry.encounterId)) {
        problems.push(`Room '${tile.name}' (${tile.id}) encounter table references unknown encounter '${entry.encounterId}' (index ${index}).`);
      }
    });
    if (!zoneIds.has(tile.zone)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown zone '${tile.zone}'.`);
    }
    if (!tileTypeIds.has(tile.type)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown tile type '${tile.type}'.`);
    }
    if (tile.shopId && !shopIds.has(tile.shopId)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown shop '${tile.shopId}'.`);
    }
    if (tile.npcId && !npcIds.has(tile.npcId)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown NPC '${tile.npcId}'.`);
    }
    if (tile.dungeonId && !dungeonIds.has(tile.dungeonId)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown dungeon '${tile.dungeonId}'.`);
    }
    if (tile.requiredItemId && !itemIds.has(tile.requiredItemId)) {
      problems.push(`Room '${tile.name}' (${tile.id}) requiredItemId references unknown item '${tile.requiredItemId}'.`);
    }
    if (!mapIds.has(tile.mapId)) {
      problems.push(`Room '${tile.name}' (${tile.id}) references unknown map '${tile.mapId}'.`);
    }
    (tile.transitions ?? []).forEach((transition, index) => {
      const target = tileById.get(transition.tileId);
      if (!target || target.mapId !== transition.mapId) {
        problems.push(`Room '${tile.name}' (${tile.id}) transition ${index} targets unknown room '${transition.tileId}' on map '${transition.mapId}'.`);
      }
    });
  }

  // --- Encounters ---
  for (const encounter of snapshot.encounters ?? []) {
    (encounter.monsterPool ?? []).forEach((entry, index) => {
      if (!monsterIds.has(entry.monsterId)) {
        problems.push(`Encounter '${encounter.id}' monster pool references unknown monster '${entry.monsterId}' (index ${index}).`);
      }
    });
    (encounter.placements ?? []).forEach((entry, index) => {
      if (!monsterIds.has(entry.monsterId)) {
        problems.push(`Encounter '${encounter.id}' placements reference unknown monster '${entry.monsterId}' (index ${index}).`);
      }
    });
  }

  // --- Monsters ---
  for (const monster of snapshot.monsters) {
    (monster.drops ?? []).forEach((drop, index) => {
      if (!itemIds.has(drop.itemId)) {
        problems.push(`Monster '${monster.id}' drops reference unknown item '${drop.itemId}' (index ${index}).`);
      }
    });
  }

  // --- Dungeons ---
  for (const dungeon of snapshot.dungeons ?? []) {
    dungeon.floors.forEach((floor, floorIndex) => {
      floor.encounterTable.forEach((entry, entryIndex) => {
        if (!encounterIds.has(entry.encounterId)) {
          problems.push(`Dungeon '${dungeon.id}' floor ${floorIndex} (floorNumber ${floor.floorNumber}) encounter table references unknown encounter '${entry.encounterId}' (index ${entryIndex}).`);
        }
      });
      (floor.rewards ?? []).forEach((reward, rewardIndex) => {
        if (!itemIds.has(reward.itemId)) {
          problems.push(`Dungeon '${dungeon.id}' floor ${floorIndex} (floorNumber ${floor.floorNumber}) reward ${rewardIndex} references unknown item '${reward.itemId}'.`);
        }
      });
    });
    if (dungeon.entryRequirements?.requiredItemId && !itemIds.has(dungeon.entryRequirements.requiredItemId)) {
      problems.push(`Dungeon '${dungeon.id}' entryRequirements.requiredItemId references unknown item '${dungeon.entryRequirements.requiredItemId}'.`);
    }
    (dungeon.firstClearRewards ?? []).forEach((reward, index) => {
      if (!itemIds.has(reward.itemId)) {
        problems.push(`Dungeon '${dungeon.id}' firstClearRewards ${index} references unknown item '${reward.itemId}'.`);
      }
    });
  }

  // --- Tile types ---
  for (const tileType of snapshot.tileTypes ?? []) {
    if (tileType.requiredItemId && !itemIds.has(tileType.requiredItemId)) {
      problems.push(`Tile type '${tileType.id}' requiredItemId references unknown item '${tileType.requiredItemId}'.`);
    }
  }

  // --- Shops ---
  for (const shop of snapshot.shops ?? []) {
    shop.inventory.forEach((entry, index) => {
      if (!itemIds.has(entry.itemId)) {
        problems.push(`Shop '${shop.id}' inventory references unknown item '${entry.itemId}' (index ${index}).`);
      }
    });
  }

  // --- Recipes ---
  for (const recipe of snapshot.recipes ?? []) {
    recipe.ingredients.forEach((ing, index) => {
      if (!itemIds.has(ing.itemId)) {
        problems.push(`Recipe '${recipe.id}' ingredient references unknown item '${ing.itemId}' (index ${index}).`);
      }
    });
    if (!itemIds.has(recipe.result.itemId)) {
      problems.push(`Recipe '${recipe.id}' result references unknown item '${recipe.result.itemId}'.`);
    }
  }

  // --- Quests ---
  for (const quest of snapshot.quests ?? []) {
    quest.objectives.forEach((obj, index) => {
      if (obj.kind === 'collect' && !itemIds.has(obj.itemId)) {
        problems.push(`Quest '${quest.id}' objective ${index} (collect) references unknown item '${obj.itemId}'.`);
      } else if (obj.kind === 'kill' && !monsterIds.has(obj.monsterId)) {
        problems.push(`Quest '${quest.id}' objective ${index} (kill) references unknown monster '${obj.monsterId}'.`);
      } else if (obj.kind === 'visit' && !tileById.has(obj.tileId)) {
        problems.push(`Quest '${quest.id}' objective ${index} (visit) references unknown room '${obj.tileId}'.`);
      }
    });
    quest.rewards.forEach((reward, index) => {
      if (reward.kind === 'item' && !itemIds.has(reward.itemId)) {
        problems.push(`Quest '${quest.id}' reward ${index} (item) references unknown item '${reward.itemId}'.`);
      }
    });
  }

  // --- NPCs ---
  for (const npc of snapshot.npcs ?? []) {
    (npc.questIds ?? []).forEach((qid, index) => {
      if (!questIds.has(qid)) {
        problems.push(`NPC '${npc.id}' questIds references unknown quest '${qid}' (index ${index}).`);
      }
    });
  }

  // --- Quest prerequisites + cycle detection ---
  const questsById = new Map((snapshot.quests ?? []).map(q => [q.id, q]));
  for (const quest of snapshot.quests ?? []) {
    (quest.prerequisiteQuestIds ?? []).forEach((preId, index) => {
      if (!questIds.has(preId)) {
        problems.push(`Quest '${quest.id}' prerequisiteQuestIds references unknown quest '${preId}' (index ${index}).`);
      }
    });
  }
  const cycleReports = new Set<string>();
  for (const startQuest of snapshot.quests ?? []) {
    const path: string[] = [];
    const visiting = new Set<string>();
    const cycle = findQuestCycle(startQuest.id, questsById, path, visiting);
    if (cycle) {
      // Dedup by the distinct quest ids involved (order-independent), so the same
      // cycle discovered from different starting quests is only reported once.
      const key = [...new Set(cycle.slice(0, -1))].sort().join('|');
      if (!cycleReports.has(key)) {
        cycleReports.add(key);
        problems.push(`Quest '${cycle[0]}' has a circular prerequisite chain: ${cycle.join(' -> ')}.`);
      }
    }
  }

  // --- Sets ---
  for (const rawSet of snapshot.sets ?? []) {
    const set = migrateLegacySet(rawSet);
    set.itemIds.forEach((itemId, index) => {
      if (!itemIds.has(itemId)) {
        problems.push(`Set '${set.id}' itemIds references unknown item '${itemId}' (index ${index}).`);
      }
    });
    set.breakpoints.forEach((bp, bpIndex) => {
      (bp.bonuses.grantedSkillIds ?? []).forEach((skillId, skillIndex) => {
        if (!skillIds.has(skillId)) {
          problems.push(`Set '${set.id}' breakpoint ${bpIndex} (piecesRequired ${bp.piecesRequired}) grantedSkillIds references unknown skill '${skillId}' (index ${skillIndex}).`);
        }
      });
    });
  }

  // --- Items ---
  for (const item of snapshot.items) {
    (item.grantedSkillIds ?? []).forEach((skillId, index) => {
      if (!skillIds.has(skillId)) {
        problems.push(`Item '${item.id}' grantedSkillIds references unknown skill '${skillId}' (index ${index}).`);
      }
    });
  }

  // --- World start tiles ---
  const defaultMapTile = snapshot.world.tiles.find(
    t => t.mapId === snapshot.world.defaultMapId
      && t.col === snapshot.world.startTile.col
      && t.row === snapshot.world.startTile.row,
  );
  if (!defaultMapTile) {
    problems.push(
      `World start tile (${snapshot.world.startTile.col}, ${snapshot.world.startTile.row}) on default map '${snapshot.world.defaultMapId}' does not resolve to any room.`,
    );
  }
  for (const map of snapshot.world.maps) {
    const found = snapshot.world.tiles.find(
      t => t.mapId === map.id && t.col === map.startTile.col && t.row === map.startTile.row,
    );
    if (!found) {
      problems.push(`Map '${map.id}' start tile (${map.startTile.col}, ${map.startTile.row}) does not resolve to any room.`);
    }
  }

  return problems;
}

/**
 * Depth-first search for a cycle in the prerequisite graph reachable from `questId`.
 * Returns the cycle as an ordered list of quest ids (first entry repeated at the end
 * conceptually, but callers render it as `a -> b -> a`) or null if no cycle is found
 * from this starting point.
 */
function findQuestCycle(
  questId: string,
  questsById: Map<string, { id: string; prerequisiteQuestIds?: string[] }>,
  path: string[],
  visiting: Set<string>,
): string[] | null {
  if (visiting.has(questId)) {
    const cycleStart = path.indexOf(questId);
    const cycle = path.slice(cycleStart);
    cycle.push(questId);
    return cycle;
  }
  const quest = questsById.get(questId);
  if (!quest) return null;

  visiting.add(questId);
  path.push(questId);
  for (const preId of quest.prerequisiteQuestIds ?? []) {
    if (!questsById.has(preId)) continue;
    const found = findQuestCycle(preId, questsById, path, visiting);
    if (found) return found;
  }
  path.pop();
  visiting.delete(questId);
  return null;
}

export async function validateDraft(deps: McpToolDeps, versionId: string): Promise<{ error?: string; problems?: string[] }> {
  try {
    const version = deps.versionStore().get(versionId);
    if (!version) return { error: 'Version not found.' };
    if (version.status !== 'draft') return { error: 'Only drafts can be validated (this is a published/active version).' };

    const snapshot = await deps.versionStore().loadSnapshot(versionId);
    const problems = collectProblems(snapshot);
    return { problems };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerValidateTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'validate_draft',
    {
      description: 'Run referential-integrity checks against a draft content version (broken references between monsters/items/quests/zones/tiles/etc). Returns a list of human-readable problems, empty if the draft is clean.',
      inputSchema: {
        versionId: z.string(),
      },
    },
    async (args) => {
      const result = await validateDraft(deps, args.versionId);
      return toolResult(result);
    },
  );
}
