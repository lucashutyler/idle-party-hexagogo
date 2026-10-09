import type { QuestDefinition, QuestProgressEntry } from '@idle-party-rpg/shared';
import type { QuestMarks } from './RoomActions';

/** Rooms (by GUID) an active quest still needs the party to visit, with the names of the quests sending them there. */
export function pendingVisitTargets(
  active: readonly QuestProgressEntry[] = [],
  defs: Readonly<Record<string, QuestDefinition>> = {},
): Map<string, string[]> {
  const targets = new Map<string, string[]>();
  for (const entry of active) {
    if (entry.status === 'ready' || entry.status === 'completed') continue;
    const def = defs[entry.questId];
    if (!def) continue;
    def.objectives.forEach((obj, i) => {
      if (obj.kind !== 'visit' || (entry.progress[i] ?? 0) >= 1) return;
      const names = targets.get(obj.tileId) ?? [];
      if (!names.includes(def.name)) names.push(def.name);
      targets.set(obj.tileId, names);
    });
  }
  return targets;
}

/** Changes only when the quest pips or destinations shown on the map would change. */
export function questMarkerKey(marks: QuestMarks, targets: ReadonlyMap<string, readonly string[]>): string {
  const sorted = (ids: Iterable<string>) => [...ids].sort().join(',');
  const targetIds = [...targets.keys()].sort().map(id => `${id}=${targets.get(id)!.join('|')}`).join(',');
  return `${sorted(marks.ready)};${sorted(marks.available)};${targetIds}`;
}
