import { isMainQuest, questTitle } from '@idle-party-rpg/shared';
import type { QuestDefinition, QuestGuide, QuestProgressEntry } from '@idle-party-rpg/shared';
import type { QuestMarks } from './RoomActions';

/** The quests still sending the party to one room, by title (without the main-story prefix). */
export interface VisitTarget {
  names: string[];
  /** Those among them that move the main story on; a room with any is a main target. */
  mainNames: string[];
}

/**
 * Rooms (by GUID) an active quest still needs the party to visit. A quest counts as main when it is a main-story
 * quest or among `storyIds` (see `QuestMarks.main`).
 */
export function pendingVisitTargets(
  active: readonly QuestProgressEntry[] = [],
  defs: Readonly<Record<string, QuestDefinition>> = {},
  storyIds: ReadonlySet<string> = new Set(),
): Map<string, VisitTarget> {
  const targets = new Map<string, VisitTarget>();
  for (const entry of active) {
    if (entry.status === 'ready' || entry.status === 'completed') continue;
    const def = defs[entry.questId];
    if (!def) continue;
    const main = isMainQuest(def) || storyIds.has(def.id);
    const title = questTitle(def);
    def.objectives.forEach((obj, i) => {
      if (obj.kind !== 'visit' || (entry.progress[i] ?? 0) >= 1) return;
      const target = targets.get(obj.tileId) ?? { names: [], mainNames: [] };
      if (!target.names.includes(title)) target.names.push(title);
      if (main && !target.mainNames.includes(title)) target.mainNames.push(title);
      targets.set(obj.tileId, target);
    });
  }
  return targets;
}

/**
 * Rooms the map marks in gold, even under fog: main-story visit targets, and the rooms where someone gives a step
 * the player can take now. Each maps to the titles of the quests that lead there. See docs/architecture/client.md → Quest destinations.
 */
export function mainBeaconRooms(
  targets: ReadonlyMap<string, VisitTarget>,
  guide: QuestGuide | undefined,
  roomsWithNpc: (npcId: string) => readonly { id: string }[],
): Map<string, string[]> {
  const beacons = new Map<string, string[]>();
  const add = (roomId: string, title: string) => {
    const titles = beacons.get(roomId) ?? [];
    if (!titles.includes(title)) titles.push(title);
    beacons.set(roomId, titles);
  };
  for (const [roomId, target] of targets) {
    for (const name of target.mainNames) add(roomId, name);
  }
  for (const step of guide?.steps ?? []) {
    if (step.status !== 'available') continue;
    for (const npcId of step.giverNpcIds ?? []) {
      for (const room of roomsWithNpc(npcId)) add(room.id, questTitle(step));
    }
  }
  return beacons;
}

/** Changes only when the quest pips, destinations or gold markers shown on the map would change. */
export function questMarkerKey(
  marks: QuestMarks,
  targets: ReadonlyMap<string, VisitTarget>,
  beacons: ReadonlyMap<string, readonly string[]> = new Map(),
): string {
  const sorted = (ids: Iterable<string>) => [...ids].sort().join(',');
  const targetIds = [...targets.keys()].sort().map(id => {
    const target = targets.get(id)!;
    return `${id}=${target.names.join('|')}*${target.mainNames.join('|')}`;
  }).join(',');
  const beaconIds = [...beacons.keys()].sort().map(id => `${id}=${beacons.get(id)!.join('|')}`).join(',');
  return `${sorted(marks.ready)};${sorted(marks.available)};${sorted(marks.main)};${targetIds};${beaconIds}`;
}
