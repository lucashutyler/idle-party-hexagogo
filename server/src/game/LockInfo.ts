import { getZone, isSpoilerQuest, nextQuestStep, validateRoomEntryAll } from '@idle-party-rpg/shared';
import type {
  QuestGiverInfo,
  QuestStepInfo,
  RoomEntryFailure,
  RoomEntryLabels,
  RoomEntryMemberInfo,
  RoomEntryRequirements,
  RoomLockMember,
  RoomLockRequirement,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import type { ContentStore } from './ContentStore.js';
import type { PlayerSession } from './PlayerSession.js';
import { npcRoomsOf } from './NpcRooms.js';
import { questGivers } from './QuestGuide.js';

export type LockContent = Pick<
  ContentStore,
  'contentEpoch' | 'getQuestRevision' | 'getAllNpcs' | 'getNpc' | 'getWorld' | 'getQuestCatalog' | 'getQuest' | 'getAllZones'
>;

/** One party member as a lock sees them; `session` is absent for a member with none. */
export interface LockMemberFacts {
  info: RoomEntryMemberInfo;
  session?: PlayerSession;
}

/** Every unmet requirement of these gates, each once, in check order, with where each member stands on it. */
export function lockRequirements(
  gates: readonly (RoomEntryRequirements | undefined)[],
  members: readonly LockMemberFacts[],
  labels: RoomEntryLabels,
  content: LockContent,
  viewerLevel: number,
): RoomLockRequirement[] {
  const infos = members.map(m => m.info);
  const seen = new Set<string>();
  const requirements: RoomLockRequirement[] = [];
  for (const gate of gates) {
    for (const failure of validateRoomEntryAll(gate, infos, labels)) {
      const key = `${failure.kind}:${failure.itemId ?? failure.questId ?? failure.minLevel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      requirements.push(toRequirement(failure, members, content, viewerLevel));
    }
  }
  return requirements;
}

/** The quest `session`'s player can work on now towards `questId`, with who gives it when it can be taken. */
export function questNextStep(content: LockContent, session: PlayerSession, questId: string): QuestStepInfo | undefined {
  const givers = questGivers(content);
  const step = nextQuestStep(
    questId,
    content.getQuestCatalog(),
    { completed: session.quests.getCompletedQuestIds(), active: session.quests.getActiveQuestIds(), level: session.getLevel() },
    id => (givers.get(id)?.npcIds.length ?? 0) > 0,
  );
  if (!step) return undefined;
  if (step.state !== 'available' && step.state !== 'needs_level') return step;
  const giver = giverFor(content, givers.get(step.questId)?.npcIds ?? [], session);
  return giver ? { ...step, giver } : step;
}

function toRequirement(
  failure: RoomEntryFailure,
  members: readonly LockMemberFacts[],
  content: LockContent,
  viewerLevel: number,
): RoomLockRequirement {
  const missing = new Set(failure.missingPlayers);
  const requirement: RoomLockRequirement = {
    kind: failure.kind,
    members: members.map(m => toMember(m, failure, !missing.has(m.info.username), content)),
  };
  if (failure.kind === 'level') requirement.minLevel = failure.minLevel;
  if (failure.kind === 'item') requirement.itemName = failure.itemName;
  if (failure.kind === 'quest' && failure.questId) {
    requirement.questId = failure.questId;
    const questLevel = content.getQuest(failure.questId)?.requiredLevel;
    if (questLevel !== undefined) requirement.questLevel = questLevel;
    if (!isSpoilerQuest(questLevel, viewerLevel)) requirement.questName = failure.questName;
  }
  return requirement;
}

function toMember(member: LockMemberFacts, failure: RoomEntryFailure, met: boolean, content: LockContent): RoomLockMember {
  const row: RoomLockMember = { username: member.info.username, met };
  if (!member.session) return row;
  if (failure.kind === 'level') row.level = member.info.level;
  if (failure.kind === 'quest' && !met && failure.questId) {
    const nextStep = questNextStep(content, member.session, failure.questId);
    if (nextStep) row.nextStep = nextStep;
  }
  return row;
}

/** A room on the player's own map first, then one they have found, then the first in world order. */
function giverFor(content: LockContent, npcIds: readonly string[], session: PlayerSession): QuestGiverInfo | undefined {
  const rooms = npcRoomsOf(content);
  const mapId = session.getMapId();
  const score = (room: WorldTileDefinition) => (room.mapId === mapId ? 2 : 0) + (session.isTileIdUnlocked(room.id) ? 1 : 0);
  let best: { npcId: string; room: WorldTileDefinition; score: number } | null = null;
  for (const npcId of npcIds) {
    for (const room of rooms.get(npcId) ?? []) {
      const roomScore = score(room);
      if (!best || roomScore > best.score) best = { npcId, room, score: roomScore };
    }
  }
  if (!best) return undefined;
  const { npcId, room } = best;
  const giver: QuestGiverInfo = { npcName: content.getNpc(npcId)?.name ?? '', roomId: room.id, mapId: room.mapId };
  const mapName = content.getWorld().maps.find(m => m.id === room.mapId)?.name;
  if (mapName) giver.mapName = mapName;
  if (room.name && session.isTileIdUnlocked(room.id)) giver.roomName = room.name;
  const zoneName = getZone(room.zone, content.getAllZones())?.displayName;
  if (zoneName) giver.zoneName = zoneName;
  return giver;
}
