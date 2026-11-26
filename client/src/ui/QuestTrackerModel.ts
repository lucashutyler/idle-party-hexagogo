import type {
  MainStoryStep,
  NpcDefinition,
  QuestDefinition,
  QuestObjective,
  QuestProgressEntry,
  ServerStateMessage,
  WorldMapMeta,
} from '@idle-party-rpg/shared';
import { getObjectiveTarget, questTitle } from '@idle-party-rpg/shared';
import { splitMainQuests, stepGiverLocations, turnInLocations, type NpcRoom } from './QuestLogModel';

export type TrackerAction =
  | { type: 'room'; roomId: string }
  | { type: 'npc'; npcId: string }
  | { type: 'log' };

/** The one goal shown under the Battle header. See docs/architecture/client.md → Battle tracker. */
export interface TrackerLine {
  kind: 'main' | 'here';
  title: string;
  detail: string;
  action: TrackerAction;
}

export interface TrackerLookups {
  getAllNpcs(): readonly NpcDefinition[];
  getNpc(id: string): NpcDefinition | undefined;
  getRoomsWithNpc(npcId: string): readonly NpcRoom[];
  getTileByGuid(id: string): NpcRoom | undefined;
  getMaps(): readonly WorldMapMeta[];
}

type TrackerState = Pick<
  ServerStateMessage,
  'activeQuests' | 'questDefinitions' | 'questResolutions' | 'questGuide' | 'offeredQuestIds' | 'availableQuestIds'
  | 'questGiverNpcId' | 'currentMapId' | 'unlocked'
>;

/** The player's most pressing main-story goal, else a quest someone in this room offers; null when there's neither. */
export function trackerLine(state: TrackerState | null | undefined, lookups: TrackerLookups): TrackerLine | null {
  if (!state) return null;
  const guide = state.questGuide;
  const defs = state.questDefinitions ?? {};
  const main = splitMainQuests(state.activeQuests ?? [], guide).main.filter(entry => defs[entry.questId]);

  const ready = main.find(entry => entry.status === 'ready');
  if (ready) return turnInLine(defs[ready.questId], state, lookups);

  for (const entry of main) {
    const line = objectiveLine(entry, defs[entry.questId], state, lookups);
    if (line) return line;
  }

  const available = guide?.steps.find(step => step.status === 'available');
  if (available) return talkLine(available, state, lookups);

  const levelLocked = guide?.steps.find(step => step.status === 'needs_level');
  if (levelLocked) {
    const level = levelLocked.requiredLevel ? `Reach level ${levelLocked.requiredLevel}` : 'Level up to continue';
    return { kind: 'main', title: questTitle(levelLocked), detail: level, action: { type: 'log' } };
  }

  return hereLine(state, lookups);
}

function turnInLine(def: QuestDefinition, state: TrackerState, lookups: TrackerLookups): TrackerLine {
  const title = questTitle(def);
  const giverHere = state.questGiverNpcId ? lookups.getNpc(state.questGiverNpcId) : undefined;
  if (giverHere?.questIds?.includes(def.id)) {
    return { kind: 'main', title, detail: `Turn in to ${giverHere.name}`, action: { type: 'npc', npcId: giverHere.id } };
  }
  const locations = turnInLocations(def.id, lookups.getAllNpcs(), id => lookups.getRoomsWithNpc(id), new Set(state.unlocked ?? []));
  const onThisMap = locations.find(loc => loc.roomId && loc.mapId === state.currentMapId);
  if (onThisMap?.roomId) {
    return { kind: 'main', title, detail: `Turn in to ${onThisMap.npcName}`, action: { type: 'room', roomId: onThisMap.roomId } };
  }
  const elsewhere = locations[0];
  if (!elsewhere) return { kind: 'main', title, detail: 'Ready to turn in', action: { type: 'log' } };
  return { kind: 'main', title, detail: `Turn in to ${elsewhere.npcName}${onMapText(elsewhere.mapId, lookups)}`, action: { type: 'log' } };
}

function objectiveLine(
  entry: QuestProgressEntry,
  def: QuestDefinition,
  state: TrackerState,
  lookups: TrackerLookups,
): TrackerLine | null {
  const index = def.objectives.findIndex((obj, i) => (entry.progress[i] ?? 0) < getObjectiveTarget(obj));
  if (index < 0) return null;
  const objective = def.objectives[index];
  const title = questTitle(def);
  const detail = objectiveShortText(objective, entry.progress[index] ?? 0, state);
  if (objective.kind !== 'visit') return { kind: 'main', title, detail, action: { type: 'log' } };

  const room = lookups.getTileByGuid(objective.tileId);
  if (room?.mapId !== state.currentMapId) return { kind: 'main', title, detail: `${detail}${onMapText(room?.mapId, lookups)}`, action: { type: 'log' } };
  const explored = state.unlocked?.includes(objective.tileId) ?? false;
  return { kind: 'main', title, detail, action: explored ? { type: 'room', roomId: objective.tileId } : { type: 'log' } };
}

function talkLine(step: MainStoryStep, state: TrackerState, lookups: TrackerLookups): TrackerLine {
  const title = questTitle(step);
  const giverHere = state.questGiverNpcId && step.giverNpcIds?.includes(state.questGiverNpcId)
    ? lookups.getNpc(state.questGiverNpcId)
    : undefined;
  if (giverHere) return { kind: 'main', title, detail: `Talk to ${giverHere.name}`, action: { type: 'npc', npcId: giverHere.id } };

  const npcs = lookups.getAllNpcs();
  const where = stepGiverLocations(step, npcs, id => lookups.getRoomsWithNpc(id), new Set(state.unlocked ?? []), state.currentMapId)[0];
  const npcName = where?.npcName ?? npcs.find(npc => step.giverNpcIds?.includes(npc.id))?.name;
  const talk = npcName ? `Talk to ${npcName}` : 'Find who offers it';
  if (where?.roomId && where.mapId === state.currentMapId) return { kind: 'main', title, detail: talk, action: { type: 'room', roomId: where.roomId } };
  return { kind: 'main', title, detail: `${talk}${onMapText(where?.mapId, lookups)}`, action: { type: 'log' } };
}

function hereLine(state: TrackerState, lookups: TrackerLookups): TrackerLine | null {
  const available = new Set(state.availableQuestIds ?? []);
  if (!state.questGiverNpcId || !(state.offeredQuestIds ?? []).some(id => available.has(id))) return null;
  const npc = lookups.getNpc(state.questGiverNpcId);
  if (!npc) return null;
  return { kind: 'here', title: `${npc.name} has work for you`, detail: '', action: { type: 'npc', npcId: npc.id } };
}

/** Short enough for one line: "Goblin 9/15", "Visit Old Mill", "Pelt 0/1". */
export function objectiveShortText(objective: QuestObjective, progress: number, state: Pick<TrackerState, 'questResolutions'>): string {
  const resolutions = state.questResolutions;
  const shown = `${Math.min(progress, getObjectiveTarget(objective))}/${getObjectiveTarget(objective)}`;
  if (objective.kind === 'kill') return `${resolutions?.monsters[objective.monsterId] ?? 'Monster'} ${shown}`;
  if (objective.kind === 'collect') return `${resolutions?.items[objective.itemId] ?? 'Item'} ${shown}`;
  const tile = resolutions?.tiles[objective.tileId];
  return `Visit ${tile?.name || (tile?.zoneName ? `a room in ${tile.zoneName}` : 'a room')}`;
}

function onMapText(mapId: string | undefined, lookups: TrackerLookups): string {
  const name = mapId ? lookups.getMaps().find(map => map.id === mapId)?.name : undefined;
  return name ? ` on the ${name} map` : '';
}
