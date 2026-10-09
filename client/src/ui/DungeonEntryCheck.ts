import type {
  ClassName,
  ClientCharacterState,
  DungeonDefinition,
  DungeonEntryMemberInfo,
  DungeonEntryRequirements,
  GamePartyMember,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { ALL_CLASS_NAMES, hasUnequipped, ownsItem, validateDungeonEntry } from '@idle-party-rpg/shared';

const UNKNOWN_ITEM_NAME = 'a key item';

type RosterEntry = Pick<GamePartyMember, 'username' | 'level' | 'className'>;

/**
 * The server's refusal reason for this party entering `dungeon` now, or null when entry looks allowed
 * or a member can't be resolved. Other members' items are invisible to the client, so they never block.
 */
export function previewDungeonEntry(dungeon: DungeonDefinition, state: ServerStateMessage): string | null {
  const members: DungeonEntryMemberInfo[] = [];
  for (const entry of partyRoster(state)) {
    const info = resolveMember(entry, dungeon.entryRequirements, state);
    if (!info) return null;
    members.push(info);
  }
  return validateDungeonEntry(dungeon, members, dungeonItemName(dungeon, state));
}

/** Display name of the dungeon's required item, or undefined when it has none. */
export function dungeonItemName(dungeon: DungeonDefinition, state: ServerStateMessage | null): string | undefined {
  const itemId = dungeon.entryRequirements?.requiredItemId;
  if (!itemId) return undefined;
  return state?.itemDefinitions?.[itemId]?.name ?? UNKNOWN_ITEM_NAME;
}

function partyRoster(state: ServerStateMessage): RosterEntry[] {
  const members = state.social?.party?.members ?? [];
  return members.length > 0 ? members : [{ username: state.username }];
}

function resolveMember(
  entry: RosterEntry,
  req: DungeonEntryRequirements | undefined,
  state: ServerStateMessage,
): DungeonEntryMemberInfo | null {
  if (entry.username === state.username) {
    const character = state.character;
    if (!character || !isClassName(character.className)) return null;
    return {
      username: entry.username,
      level: character.level,
      className: character.className,
      hasRequiredItem: holdsRequiredItem(req, character),
    };
  }
  const listed = state.social?.allPlayers.find(p => p.username === entry.username);
  const level = entry.level ?? listed?.level;
  const className = entry.className ?? listed?.className;
  if (level === undefined || !isClassName(className)) return null;
  return { username: entry.username, level, className, hasRequiredItem: true };
}

function holdsRequiredItem(req: DungeonEntryRequirements | undefined, character: ClientCharacterState): boolean {
  const itemId = req?.requiredItemId;
  if (!itemId) return true;
  return req.consumeRequiredItem
    ? hasUnequipped(itemId, character.inventory)
    : ownsItem(itemId, character.inventory, character.equipment);
}

function isClassName(value: string | undefined): value is ClassName {
  return value !== undefined && (ALL_CLASS_NAMES as string[]).includes(value);
}
