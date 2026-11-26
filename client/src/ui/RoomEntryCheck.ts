import type {
  ClientCharacterState,
  GamePartyMember,
  MapTransitionLink,
  RoomEntryFailure,
  RoomEntryMemberInfo,
  RoomEntryRequirements,
  ServerStateMessage,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import { getEquippedItemIds, isRoomGateEmpty, resolveTileRequirements, validateRoomEntryAll } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';

export const NO_WALKING_ROUTE_TEXT = 'No walking route from here. This area is reached through a door.';
export const UNKNOWN_QUEST_LOCK_TEXT = 'Opens later in the story';
const UNKNOWN_ITEM_NAME = 'a special item';

type TileTypeLookup = Pick<WorldCache, 'getTileTypeDef'>;

/** A room's whole gate: its tile type's, overridden field by field by its own. */
export function roomRequirements(def: WorldTileDefinition, worldCache: TileTypeLookup): RoomEntryRequirements | undefined {
  return resolveTileRequirements(def, worldCache.getTileTypeDef(def.type));
}

/**
 * What would keep this party out of a room with `reqs`, or null when nothing would or the client can't tell.
 * Other members' items and quests are invisible to the client, so only their level can block.
 */
export function previewRoomLock(reqs: RoomEntryRequirements | undefined, state: ServerStateMessage | null): RoomEntryFailure[] | null {
  if (!state || !reqs || isRoomGateEmpty(reqs)) return null;
  const members = gateMembers(reqs, state);
  if (!members) return null;
  const failures = validateRoomEntryAll(reqs, members, {
    itemName: id => state.itemDefinitions?.[id]?.name,
    questName: id => state.questDefinitions?.[id]?.name,
  });
  return failures.length > 0 ? failures : null;
}

/** The exit's own gate first, then the room it leads to, as the server checks them. */
export function previewTravelLock(
  link: MapTransitionLink,
  destDef: WorldTileDefinition | undefined,
  worldCache: TileTypeLookup,
  state: ServerStateMessage | null,
): RoomEntryFailure[] | null {
  return previewRoomLock(link.entryRequirements, state)
    ?? (destDef ? previewRoomLock(roomRequirements(destDef, worldCache), state) : null);
}

/** Changes whenever a lock preview could: the viewer's level, quests and gear, and the party's levels. */
export function lockPreviewKey(state: ServerStateMessage | null): string {
  const character = state?.character;
  if (!state || !character) return '';
  const completed = state.completedQuests ?? [];
  const equipped = [...equippedIds(character)].sort().join(',');
  const members = otherMembers(state).map(m => `${m.username}:${memberLevel(m, state) ?? '?'}`).join(',');
  return `${character.level}|${completed.length}|${completed[completed.length - 1]?.questId ?? ''}|${equipped}|${members}`;
}

/** One player-facing line per unmet requirement, naming only what this player has already seen. */
export function roomLockLines(failures: readonly RoomEntryFailure[], state: ServerStateMessage | null): string[] {
  const lines: string[] = [];
  for (const failure of failures) {
    for (const line of failureLines(failure, state)) {
      if (!lines.includes(line)) lines.push(line);
    }
  }
  return lines;
}

function failureLines(failure: RoomEntryFailure, state: ServerStateMessage | null): string[] {
  switch (failure.kind) {
    case 'item': {
      const name = (failure.itemId && state?.itemDefinitions?.[failure.itemId]?.name) || UNKNOWN_ITEM_NAME;
      return [`Needs ${name} equipped`];
    }
    case 'quest': {
      const name = failure.questId ? state?.questDefinitions?.[failure.questId]?.name : undefined;
      return [name ? `Complete the quest "${name}"` : UNKNOWN_QUEST_LOCK_TEXT];
    }
    case 'level':
      return levelLines(failure, state);
  }
}

function levelLines(failure: RoomEntryFailure, state: ServerStateMessage | null): string[] {
  const lines: string[] = [];
  const viewer = state?.username;
  if (viewer && failure.missingPlayers.includes(viewer)) {
    lines.push(`Needs level ${failure.minLevel} (you're level ${state?.character?.level})`);
  }
  const others = failure.missingPlayers.filter(name => name !== viewer);
  if (others.length > 0) {
    lines.push(`${joinNames(others)} ${others.length === 1 ? 'needs' : 'need'} level ${failure.minLevel}`);
  }
  return lines;
}

function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function gateMembers(reqs: RoomEntryRequirements, state: ServerStateMessage): RoomEntryMemberInfo[] | null {
  const character = state.character;
  if (!character) return null;
  const members: RoomEntryMemberInfo[] = [{
    username: state.username,
    level: character.level,
    equippedItemIds: equippedIds(character),
    completedQuestIds: new Set((state.completedQuests ?? []).map(q => q.questId)),
  }];
  const assumedItems = new Set(reqs.requiredItemId ? [reqs.requiredItemId] : []);
  const assumedQuests = new Set(reqs.requiredQuestIds ?? []);
  for (const member of otherMembers(state)) {
    const level = memberLevel(member, state);
    if (level === undefined && reqs.minLevel !== undefined) return null;
    members.push({
      username: member.username,
      level: level ?? 0,
      equippedItemIds: assumedItems,
      completedQuestIds: assumedQuests,
    });
  }
  return members;
}

/** The map reads this on every push, so a character without its gear yet must not throw. */
function equippedIds(character: Pick<ClientCharacterState, 'equipment'>): Set<string> {
  return getEquippedItemIds(character.equipment ?? {});
}

function otherMembers(state: ServerStateMessage): GamePartyMember[] {
  return (state.social?.party?.members ?? []).filter(m => m.username !== state.username);
}

function memberLevel(member: GamePartyMember, state: ServerStateMessage): number | undefined {
  return member.level ?? state.social?.allPlayers?.find(p => p.username === member.username)?.level;
}
