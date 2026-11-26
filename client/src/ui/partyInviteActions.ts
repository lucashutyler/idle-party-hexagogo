import type { PartyInvite, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { confirmDialog } from './ConfirmDialog';
import type { ConfirmDialogOptions } from './ConfirmDialog';

export const PARTY_RUN_ENDS_WARNING = 'Your party\'s dungeon run will end for everyone in it.';
export const OWN_RUN_ENDS_WARNING = 'Your dungeon run will end.';
const HIRES_LEAVE = 'Your hired fighters will leave.';

/** "In <room>, <zone>", "On another map", or null when the invite doesn't say. */
export function inviteWhereText(invite: PartyInvite): string | null {
  if (invite.sameMap === false) return 'On another map';
  const place = [invite.roomName, invite.zoneName].filter(Boolean).join(', ');
  return place ? `In ${place}` : null;
}

/** The dungeon-run line a party change adds while the party is in a dungeon, or null. */
export function runEndsWarning(state: ServerStateMessage | null): string | null {
  if (!state?.dungeon) return null;
  return (state.social?.party?.members.length ?? 0) > 1 ? PARTY_RUN_ENDS_WARNING : OWN_RUN_ENDS_WARNING;
}

/** What to ask before removing a member from the party. */
export function kickConfirmOptions(username: string, state: ServerStateMessage | null): ConfirmDialogOptions {
  const warning = runEndsWarning(state);
  const body = 'They will be removed from this party and carry on alone.';
  return {
    title: `Kick ${username}?`,
    body: warning ? `${body} ${warning}` : body,
    confirmLabel: 'Kick',
    danger: true,
  };
}

/** What to ask before joining `partyId`, or null when joining costs nothing. */
export function joinConfirmOptions(partyId: string, state: ServerStateMessage | null): ConfirmDialogOptions | null {
  const social = state?.social;
  const party = social?.party;
  const self = state?.username ?? '';
  const others = (party?.members ?? []).filter(m => m.username !== self);
  const hasHires = others.length === 0 && (party?.henchmen?.length ?? 0) > 0;
  const runEnds = runEndsWarning(state);
  if (others.length === 0 && !hasHires && !runEnds) return null;

  const owner = party?.members.find(m => m.role === 'owner')?.username;
  const leaveLine = others.length === 0
    ? 'You will leave your current party.'
    : owner && owner !== self ? `You will leave ${owner}'s party.` : 'You will leave your party, and another member becomes its owner.';
  const inviter = social?.pendingInvites?.find(i => i.partyId === partyId)?.inviterUsername;
  return {
    title: inviter ? `Join ${inviter}'s party?` : 'Join this party?',
    body: [leaveLine, hasHires ? HIRES_LEAVE : null, runEnds].filter(Boolean).join(' '),
    confirmLabel: 'Join Party',
    danger: true,
  };
}

/** Accept an invite, asking first when joining would cost something. Resolves whether the accept was sent. */
export async function acceptInviteWithConfirm(gameClient: GameClient, partyId: string, state: ServerStateMessage | null): Promise<boolean> {
  const confirm = joinConfirmOptions(partyId, state);
  if (!confirm) {
    gameClient.sendAcceptPartyInvite(partyId);
    return true;
  }
  if (!await confirmDialog(confirm)) return false;
  gameClient.sendAcceptPartyInvite(partyId);
  return true;
}
