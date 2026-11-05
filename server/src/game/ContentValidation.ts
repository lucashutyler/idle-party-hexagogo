import {
  MIN_MONSTER_ACTION_INTERVAL_MS,
  MONSTER_SKILL_CATALOG,
  findZonesSpanningMaps,
  isAuthoredMonsterLevel,
  suggestTierFromHp,
  migrateLegacySet,
  migrateLegacySkill,
  validateSkillDefinition,
} from '@idle-party-rpg/shared';
import type { RoomEntryRequirements } from '@idle-party-rpg/shared';
import {
  checkpointEncounterProblems,
  checkpointEncounterWarnings,
  floorCheckpointProblems,
  monsterScalingProblems,
} from '../admin/contentChecks.js';
import type { ContentSnapshot } from './VersionStore.js';

const PUBLISH_PROBLEMS_SHOWN = 5;

/** The admin-facing reason a draft with content problems can't be published. */
export function formatPublishRefusal(problems: readonly string[]): string {
  const shown = problems.slice(0, PUBLISH_PROBLEMS_SHOWN).join(' ');
  const hidden = problems.length - PUBLISH_PROBLEMS_SHOWN;
  const more = hidden > 0 ? ` (+${hidden} more)` : '';
  return `Can't publish: the draft has ${problems.length} problem(s). ${shown}${more}`;
}

/**
 * Run every referential-integrity check against a draft's content snapshot.
 * Collects every problem found (no early return) so an AI-authored batch of
 * content gets a complete report before a human ever reviews it.
 */
export function findContentProblems(snapshot: ContentSnapshot): string[] {
  const problems: string[] = [];

  const monsterIds = new Set(snapshot.monsters.map(m => m.id));
  const itemIds = new Set(snapshot.items.map(i => i.id));
  const zoneIds = new Set(snapshot.zones.map(z => z.id));
  const encounterIds = new Set((snapshot.encounters ?? []).map(e => e.id));
  const shopIds = new Set((snapshot.shops ?? []).map(s => s.id));
  const henchmanIds = new Set((snapshot.henchmen ?? []).map(h => h.id));
  const npcIds = new Set((snapshot.npcs ?? []).map(n => n.id));
  const questIds = new Set((snapshot.quests ?? []).map(q => q.id));
  const dungeonIds = new Set((snapshot.dungeons ?? []).map(d => d.id));
  const tileTypeIds = new Set((snapshot.tileTypes ?? []).map(t => t.id));
  const skillIds = new Set((snapshot.skills ?? []).map(s => s.id));
  const mapIds = new Set(snapshot.world.maps.map(m => m.id));
  const tileById = new Map(snapshot.world.tiles.map(t => [t.id, t]));

  /** Referential + range checks for a room/transition entry gate. */
  const checkRoomRequirements = (reqs: RoomEntryRequirements | undefined, label: string): void => {
    if (!reqs) return;
    if (reqs.requiredItemId && !itemIds.has(reqs.requiredItemId)) {
      problems.push(`${label} entryRequirements.requiredItemId references unknown item '${reqs.requiredItemId}'.`);
    }
    (reqs.requiredQuestIds ?? []).forEach((questId, index) => {
      if (!questIds.has(questId)) {
        problems.push(`${label} entryRequirements.requiredQuestIds references unknown quest '${questId}' (index ${index}).`);
      }
    });
    if (reqs.minLevel !== undefined && (!Number.isFinite(reqs.minLevel) || reqs.minLevel < 1)) {
      problems.push(`${label} entryRequirements.minLevel must be at least 1.`);
    }
  };

  // --- Zones ---
  for (const zone of snapshot.zones) {
    zone.encounterTable.forEach((entry, index) => {
      if (!encounterIds.has(entry.encounterId)) {
        problems.push(`Zone '${zone.id}' encounter table references unknown encounter '${entry.encounterId}' (index ${index}).`);
      }
    });
  }

  // --- Tiles: encounter table, zone/type/shop/npc/dungeon, entry gates, mapId ---
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
    checkRoomRequirements(tile.entryRequirements, `Room '${tile.name}' (${tile.id})`);
    (tile.transitions ?? []).forEach((transition, index) => {
      const target = tileById.get(transition.tileId);
      if (!target || target.mapId !== transition.mapId) {
        problems.push(`Room '${tile.name}' (${tile.id}) transition ${index} targets unknown room '${transition.tileId}' on map '${transition.mapId}'.`);
      }
      checkRoomRequirements(transition.entryRequirements, `Room '${tile.name}' (${tile.id}) transition ${index}`);
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
  const minAttackInterval = MIN_MONSTER_ACTION_INTERVAL_MS / 1000;
  for (const monster of snapshot.monsters) {
    (monster.drops ?? []).forEach((drop, index) => {
      if (!itemIds.has(drop.itemId)) {
        problems.push(`Monster '${monster.id}' drops reference unknown item '${drop.itemId}' (index ${index}).`);
      }
    });
    if (monster.attackInterval !== undefined && !isNumberAtLeast(monster.attackInterval, minAttackInterval)) {
      problems.push(`Monster '${monster.id}' attackInterval must be a number of seconds, at least ${minAttackInterval} (got ${String(monster.attackInterval)}).`);
    }
    (monster.skills ?? []).forEach((entry, index) => {
      const label = `Monster '${monster.id}' skill ${index}`;
      if (!MONSTER_SKILL_CATALOG[entry.skillId]) {
        problems.push(`${label} references unknown monster skill '${entry.skillId}' (known: ${Object.keys(MONSTER_SKILL_CATALOG).join(', ')}).`);
      }
      if (!isNumberAtLeast(entry.value, 0)) {
        problems.push(`${label} value must be a number, 0 or more (got ${String(entry.value)}).`);
      }
      if (!isNumberAtLeast(entry.cooldown, 0)) {
        problems.push(`${label} cooldown must be a number of seconds, 0 or more (got ${String(entry.cooldown)}).`);
      }
      if (entry.castTime !== undefined && !isNumberAtLeast(entry.castTime, 0)) {
        problems.push(`${label} castTime must be a number of seconds, 0 or more (got ${String(entry.castTime)}).`);
      }
    });
    problems.push(...monsterScalingProblems(monster));
  }

  // --- Skills ---
  for (const skill of snapshot.skills ?? []) {
    for (const error of validateSkillDefinition(migrateLegacySkill(skill))) {
      problems.push(`Skill '${skill.id}': ${error}`);
    }
  }

  // --- Dungeons ---
  const encountersById = new Map((snapshot.encounters ?? []).map(e => [e.id, e]));
  const monstersById = new Map(snapshot.monsters.map(m => [m.id, m]));
  for (const dungeon of snapshot.dungeons ?? []) {
    dungeon.floors.forEach((floor, floorIndex) => {
      const floorLabel = `Dungeon '${dungeon.id}' floor ${floorIndex} (floorNumber ${floor.floorNumber})`;
      problems.push(...floorCheckpointProblems(floor, floorLabel));
      problems.push(...checkpointEncounterProblems(floor, floorLabel, encountersById, monstersById));
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
    checkRoomRequirements(tileType.entryRequirements, `Tile type '${tileType.id}'`);
  }

  // --- Shops ---
  for (const shop of snapshot.shops ?? []) {
    shop.inventory.forEach((entry, index) => {
      if (!itemIds.has(entry.itemId)) {
        problems.push(`Shop '${shop.id}' inventory references unknown item '${entry.itemId}' (index ${index}).`);
      }
    });
    // keep-when-absent: an absent `henchmen` key means unknown, not empty.
    if (snapshot.henchmen !== undefined) {
      (shop.henchmanIds ?? []).forEach((hid, index) => {
        if (!henchmanIds.has(hid)) {
          problems.push(`Shop '${shop.id}' henchmanIds references unknown henchman '${hid}' (index ${index}).`);
        }
      });
    }
  }

  // --- Zones ---
  for (const { zone, mapIds } of findZonesSpanningMaps(snapshot.world.tiles)) {
    problems.push(`Zone '${zone}' spans ${mapIds.length} maps (${mapIds.join(', ')}). A zone must belong to exactly one map — split it so each map has its own zone.`);
  }

  // --- Henchmen ---
  if (snapshot.skills !== undefined) {
    for (const henchman of snapshot.henchmen ?? []) {
      henchman.skillIds.forEach((skillId, index) => {
        if (!skillIds.has(skillId)) {
          problems.push(`Henchman '${henchman.id}' skillIds references unknown skill '${skillId}' (index ${index}).`);
        }
      });
    }
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

const MAX_LISTED_IDS = 20;

/** Advisory findings that don't block publishing (unauthored levels, tier hints, dungeon checkpoint caveats). */
export function findContentInfo(snapshot: ContentSnapshot): string[] {
  const info: string[] = [];
  const unleveled = snapshot.monsters.filter(m => !m.passive && !isAuthoredMonsterLevel(m.level)).map(m => m.id);
  if (unleveled.length > 0) {
    const listed = unleveled.slice(0, MAX_LISTED_IDS).join(', ');
    const more = unleveled.length > MAX_LISTED_IDS ? `, … (+${unleveled.length - MAX_LISTED_IDS} more)` : '';
    info.push(`No level scaling for ${unleveled.length} monster${unleveled.length === 1 ? '' : 's'} with no level set: ${listed}${more}. Set a level (1–200) to make a monster scale against player levels.`);
  }
  for (const monster of snapshot.monsters) {
    if (monster.tier !== undefined) continue;
    const suggested = suggestTierFromHp(monster);
    if (suggested !== 'trash') {
      info.push(`Monster '${monster.id}' has no tier, but its HP is in the '${suggested}' range for its damage — consider tier '${suggested}' (tiers are never set automatically).`);
    }
  }
  const encountersById = new Map((snapshot.encounters ?? []).map(e => [e.id, e]));
  const monstersById = new Map(snapshot.monsters.map(m => [m.id, m]));
  for (const dungeon of snapshot.dungeons ?? []) {
    dungeon.floors.forEach((floor, floorIndex) => {
      const floorLabel = `Dungeon '${dungeon.id}' floor ${floorIndex} (floorNumber ${floor.floorNumber})`;
      info.push(...checkpointEncounterWarnings(floor, floorLabel, encountersById, monstersById));
      const hasCheckpoints = Array.isArray(floor.checkpoints) && floor.checkpoints.length > 0;
      if (hasCheckpoints) return;
      const inert = (['maxWipes', 'checkpointRewardFraction'] as const).filter(key => floor[key] !== undefined);
      if (inert.length > 0) {
        info.push(`${floorLabel} sets ${inert.join(' and ')} without checkpoints — they have no effect.`);
      }
    });
  }
  return info;
}

function isNumberAtLeast(value: unknown, min: number): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= min;
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
