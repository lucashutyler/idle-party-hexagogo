import type { RoomEntryFailureKind } from './RoomRequirements.js';

/** What a lock card is asked about: a room the party might walk to, or one of the party's room's doors. */
export type LockTarget =
  | { kind: 'room'; tileId: string }
  | { kind: 'door'; fromTileId: string; tileId: string };

/** Where the quest that moves a member towards a lock comes from. */
export interface QuestGiverInfo {
  npcName: string;
  roomId: string;
  mapId: string;
  mapName?: string;
  /** Only once the member has found the room. */
  roomName?: string;
  zoneName?: string;
}

export type QuestStepState = 'active' | 'available' | 'needs_level' | 'unavailable';

/** The quest one member can work on now to get nearer a gate quest. */
export interface QuestStepInfo {
  questId: string;
  questName: string;
  state: QuestStepState;
  requiredLevel?: number;
  /** Unfinished quests between the member and the gate quest, both ends included. */
  remaining: number;
  giver?: QuestGiverInfo;
}

export interface RoomLockMember {
  username: string;
  met: boolean;
  /** Level requirements only. */
  level?: number;
  /** Quest requirements the member hasn't met only. */
  nextStep?: QuestStepInfo;
}

/** One unmet requirement of a lock, with where each party member stands on it. */
export interface RoomLockRequirement {
  kind: RoomEntryFailureKind;
  minLevel?: number;
  questId?: string;
  /** Left out for a quest far above the viewer's level. */
  questName?: string;
  questLevel?: number;
  itemName?: string;
  members: RoomLockMember[];
}

/** What stops the party, for the lock card. See docs/architecture/content.md → Lock info. */
export interface RoomLockInfo {
  /** The room whose gate fails; for a door, the room the door is in. */
  roomId: string;
  /** Only once the viewer has found the room. */
  roomName?: string;
  onRoute?: true;
  door?: true;
  /** For a door, the room it leads to. */
  doorTileId?: string;
  /** No way there through found doors, even with every gate open. */
  unreachable?: true;
  requirements: RoomLockRequirement[];
}

/** A gate quest this many levels or more above the viewer is not named. */
export const LOCK_QUEST_SPOILER_LEVELS = 10;

export function isSpoilerQuest(questLevel: number | undefined, viewerLevel: number): boolean {
  return questLevel !== undefined && questLevel >= viewerLevel + LOCK_QUEST_SPOILER_LEVELS;
}

/** Same target, compared field by field. */
export function sameLockTarget(a: LockTarget, b: LockTarget): boolean {
  if (a.kind === 'room') return b.kind === 'room' && a.tileId === b.tileId;
  return b.kind === 'door' && a.tileId === b.tileId && a.fromTileId === b.fromTileId;
}

/** A target from an untrusted message, or null. */
export function parseLockTarget(raw: unknown): LockTarget | null {
  if (!raw || typeof raw !== 'object') return null;
  const target = raw as Record<string, unknown>;
  if (typeof target.tileId !== 'string') return null;
  if (target.kind === 'room') return { kind: 'room', tileId: target.tileId };
  if (target.kind === 'door' && typeof target.fromTileId === 'string') {
    return { kind: 'door', fromTileId: target.fromTileId, tileId: target.tileId };
  }
  return null;
}
