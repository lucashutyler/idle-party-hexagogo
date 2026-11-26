import type { GamePartyInfo, GamePartyMember, ServerMoveBlockedMessage } from '@idle-party-rpg/shared';

export interface MoveBlockText {
  text: string;
  /** Missing members the viewer may remove from the party. */
  removable: string[];
}

/** What a refusal at a locked room says, naming the members it waits on. See docs/architecture/social.md → Locked rooms. */
export function describeMoveBlock(
  msg: Pick<ServerMoveBlockedMessage, 'reason' | 'missingPlayers'>,
  selfUsername: string,
  party: Pick<GamePartyInfo, 'members'> | null | undefined,
  onlineSet: ReadonlySet<string>,
): MoveBlockText {
  const members = party?.members ?? [];
  const others = msg.missingPlayers.filter(name => name !== selfUsername);
  if (members.length <= 1 || others.length === 0) return { text: msg.reason, removable: [] };

  const named = others.map(name => `${name} (${onlineSet.has(name) ? 'online' : 'offline'})`);
  const who = msg.missingPlayers.includes(selfUsername) ? ['you', ...named] : named;
  return {
    text: `Waiting on ${joinNames(who)}: ${msg.reason}`,
    removable: removableMembers(others, selfUsername, members),
  };
}

/** Who the viewer may remove, as the server's kick allows: an owner anyone, a leader anyone but the owner. */
export function removableMembers(names: readonly string[], selfUsername: string, members: readonly GamePartyMember[]): string[] {
  const role = members.find(m => m.username === selfUsername)?.role;
  if (role !== 'owner' && role !== 'leader') return [];
  return names.filter(name => {
    if (name === selfUsername) return false;
    const member = members.find(m => m.username === name);
    return !!member && (role === 'owner' || member.role !== 'owner');
  });
}

export function joinNames(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}
