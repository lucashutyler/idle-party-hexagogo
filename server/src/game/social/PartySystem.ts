import type { GamePartyInfo, PartyGridPosition, PartyInvite, PartyRole } from '@idle-party-rpg/shared';
import { MAX_PARTY_SIZE } from '@idle-party-rpg/shared';

let partyIdCounter = 0;

function generatePartyId(): string {
  return `party_${Date.now()}_${++partyIdCounter}`;
}

/** Check if a role can kick members. Owners and leaders can kick. */
function canKick(role: PartyRole): boolean {
  return role === 'owner' || role === 'leader';
}

/** Check if a role can move the party. Owners and leaders can move. */
export function canMove(role: PartyRole): boolean {
  return role === 'owner' || role === 'leader';
}

/** Check if a role can invite. Owners and leaders can invite. */
function canInvite(role: PartyRole): boolean {
  return role === 'owner' || role === 'leader';
}

/**
 * PartySystem manages game parties (groups of players).
 * - Every player is always in a party (solo if alone)
 * - Pending invite flow: invite → accept/decline
 * - Invites invalidated when inviter leaves the tile
 * - Three-tier roles: owner > leader > member
 * - Owner can promote/demote leaders, transfer ownership
 * - Leaders can kick (including other leaders) and move
 * - Max 5 members, 3x3 grid positioning for combat
 * - Same-tile requirement for inviting
 */
export class PartySystem {
  private parties = new Map<string, GamePartyInfo>();

  /** Pending invites keyed by target username → list of invites. */
  private pendingInvites = new Map<string, PartyInvite[]>();

  /** Create a party with the given player as owner. Returns party or error string. */
  createParty(
    username: string,
    getPlayerPartyId: (u: string) => string | null,
    setPlayerPartyId: (u: string, id: string | null) => void,
  ): GamePartyInfo | string {
    if (getPlayerPartyId(username)) {
      return 'You are already in a party';
    }

    const id = generatePartyId();
    const party: GamePartyInfo = {
      id,
      members: [{
        username,
        role: 'owner',
        gridPosition: 4 as PartyGridPosition, // Center of 3x3 grid
      }],
    };

    this.parties.set(id, party);
    setPlayerPartyId(username, id);
    return party;
  }

  /** Send an invite to a player. Creates a pending invite. Returns true or error string. */
  inviteToParty(
    inviterUsername: string,
    targetUsername: string,
    getPlayerPartyId: (u: string) => string | null,
    areSameTile: (a: string, b: string) => boolean,
  ): true | string {
    const partyId = getPlayerPartyId(inviterUsername);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const inviter = party.members.find(m => m.username === inviterUsername);
    if (!inviter || !canInvite(inviter.role)) {
      return 'Only owners and leaders can invite';
    }

    if (!areSameTile(inviterUsername, targetUsername)) {
      return 'Must be in the same room to invite';
    }

    if (party.members.length >= MAX_PARTY_SIZE) {
      return `Party is full (max ${MAX_PARTY_SIZE})`;
    }

    // Check if already a member of this party
    if (party.members.some(m => m.username === targetUsername)) {
      return 'That player is already in your party';
    }

    // Check if already invited to this party
    const existing = this.pendingInvites.get(targetUsername) ?? [];
    if (existing.some(inv => inv.partyId === partyId)) {
      return 'Already invited';
    }

    const invite: PartyInvite = {
      partyId,
      inviterUsername,
      targetUsername,
      timestamp: Date.now(),
    };

    existing.push(invite);
    this.pendingInvites.set(targetUsername, existing);
    return true;
  }

  /** Accept a pending invite. Leaves current party and joins the invited one. */
  acceptInvite(
    username: string,
    partyId: string,
    getPlayerPartyId: (u: string) => string | null,
    setPlayerPartyId: (u: string, id: string | null) => void,
    areSameTile: (a: string, b: string) => boolean,
  ): { joined: GamePartyInfo; leftPartyId: string | null } | string {
    const invites = this.pendingInvites.get(username) ?? [];
    const invite = invites.find(inv => inv.partyId === partyId);
    if (!invite) return 'Invite not found or expired';

    const party = this.parties.get(partyId);
    if (!party) return 'Party no longer exists';

    if (party.members.length >= MAX_PARTY_SIZE) return 'Party is full';

    // Verify inviter is still on the same tile
    if (!areSameTile(invite.inviterUsername, username)) {
      // Remove this invalid invite
      this.removeInvite(username, partyId);
      return 'Inviter is no longer in your room';
    }

    // Leave current party
    const oldPartyId = getPlayerPartyId(username);
    if (oldPartyId) {
      this.leaveParty(username, getPlayerPartyId, setPlayerPartyId);
    }

    // Join the new party
    const taken = new Set(party.members.map(m => m.gridPosition));
    let pos: PartyGridPosition = 0;
    for (let i = 0; i < 9; i++) {
      if (!taken.has(i as PartyGridPosition)) {
        pos = i as PartyGridPosition;
        break;
      }
    }

    party.members.push({
      username,
      role: 'member',
      gridPosition: pos,
    });
    setPlayerPartyId(username, partyId);

    // Clear all pending invites for this user
    this.pendingInvites.delete(username);

    return { joined: party, leftPartyId: oldPartyId };
  }

  /** Decline a pending invite. */
  declineInvite(username: string, partyId: string): true | string {
    const invites = this.pendingInvites.get(username) ?? [];
    const idx = invites.findIndex(inv => inv.partyId === partyId);
    if (idx === -1) return 'Invite not found';

    invites.splice(idx, 1);
    if (invites.length === 0) {
      this.pendingInvites.delete(username);
    }
    return true;
  }

  /** Get pending invites for a player (invites they have received). */
  getPendingInvites(username: string): PartyInvite[] {
    return this.pendingInvites.get(username) ?? [];
  }

  /** Get usernames this player has pending outgoing invites for. */
  getOutgoingInvites(inviterUsername: string): string[] {
    const result: string[] = [];
    for (const [targetUsername, invites] of this.pendingInvites) {
      if (invites.some(inv => inv.inviterUsername === inviterUsername)) {
        result.push(targetUsername);
      }
    }
    return result;
  }

  /** Remove a specific invite. */
  private removeInvite(username: string, partyId: string): void {
    const invites = this.pendingInvites.get(username);
    if (!invites) return;
    const filtered = invites.filter(inv => inv.partyId !== partyId);
    if (filtered.length === 0) {
      this.pendingInvites.delete(username);
    } else {
      this.pendingInvites.set(username, filtered);
    }
  }

  /** Leave a party. If last member, party is deleted. */
  leaveParty(
    username: string,
    getPlayerPartyId: (u: string) => string | null,
    setPlayerPartyId: (u: string, id: string | null) => void,
  ): true | string {
    const partyId = getPlayerPartyId(username);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const leavingMember = party.members.find(m => m.username === username);
    const wasOwner = leavingMember?.role === 'owner';

    party.members = party.members.filter(m => m.username !== username);
    setPlayerPartyId(username, null);

    if (party.members.length === 0) {
      this.parties.delete(partyId);
    } else if (wasOwner) {
      // Transfer ownership: first leader, then first member
      const firstLeader = party.members.find(m => m.role === 'leader');
      if (firstLeader) {
        firstLeader.role = 'owner';
      } else {
        party.members[0].role = 'owner';
      }
    }

    return true;
  }

  /** Kick a member from a party (owner or leader). Leaders can kick other leaders. */
  kickMember(
    kickerUsername: string,
    targetUsername: string,
    getPlayerPartyId: (u: string) => string | null,
    setPlayerPartyId: (u: string, id: string | null) => void,
  ): true | string {
    const partyId = getPlayerPartyId(kickerUsername);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const kicker = party.members.find(m => m.username === kickerUsername);
    if (!kicker || !canKick(kicker.role)) return 'Only owners and leaders can kick members';

    if (kickerUsername === targetUsername) return 'Cannot kick yourself';

    const target = party.members.find(m => m.username === targetUsername);
    if (!target) return 'Player is not in your party';

    // Leaders cannot kick the owner
    if (kicker.role === 'leader' && target.role === 'owner') {
      return 'Cannot kick the party owner';
    }

    party.members = party.members.filter(m => m.username !== targetUsername);
    setPlayerPartyId(targetUsername, null);
    return true;
  }

  /** Set a member's grid position. */
  setGridPosition(
    username: string,
    position: PartyGridPosition,
    getPlayerPartyId: (u: string) => string | null,
  ): true | string {
    if (position < 0 || position > 8) return 'Invalid position';

    const partyId = getPlayerPartyId(username);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    // Check if position is taken
    const existing = party.members.find(m => m.gridPosition === position);
    if (existing && existing.username !== username) return 'Position is taken';

    const member = party.members.find(m => m.username === username);
    if (!member) return 'You are not in this party';

    member.gridPosition = position;
    return true;
  }

  /** Promote a member to leader (owner or leader). */
  promoteLeader(
    callerUsername: string,
    targetUsername: string,
    getPlayerPartyId: (u: string) => string | null,
  ): true | string {
    const partyId = getPlayerPartyId(callerUsername);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const caller = party.members.find(m => m.username === callerUsername);
    if (!caller || (caller.role !== 'owner' && caller.role !== 'leader')) return 'Only the owner or a leader can promote members';

    const target = party.members.find(m => m.username === targetUsername);
    if (!target) return 'Player is not in your party';

    if (target.role !== 'member') return 'Player is already a leader or owner';

    target.role = 'leader';
    return true;
  }

  /** Demote a leader to member (owner only). */
  demoteLeader(
    ownerUsername: string,
    targetUsername: string,
    getPlayerPartyId: (u: string) => string | null,
  ): true | string {
    const partyId = getPlayerPartyId(ownerUsername);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const owner = party.members.find(m => m.username === ownerUsername);
    if (!owner || owner.role !== 'owner') return 'Only the owner can demote leaders';

    const target = party.members.find(m => m.username === targetUsername);
    if (!target) return 'Player is not in your party';

    if (target.role !== 'leader') return 'Player is not a leader';

    target.role = 'member';
    return true;
  }

  /** Transfer ownership to another member (owner only). Old owner becomes leader. */
  transferOwnership(
    ownerUsername: string,
    targetUsername: string,
    getPlayerPartyId: (u: string) => string | null,
  ): true | string {
    const partyId = getPlayerPartyId(ownerUsername);
    if (!partyId) return 'You are not in a party';

    const party = this.parties.get(partyId);
    if (!party) return 'Party not found';

    const owner = party.members.find(m => m.username === ownerUsername);
    if (!owner || owner.role !== 'owner') return 'Only the owner can transfer ownership';

    const target = party.members.find(m => m.username === targetUsername);
    if (!target) return 'Player is not in your party';

    if (target.username === ownerUsername) return 'You are already the owner';

    owner.role = 'leader';
    target.role = 'owner';
    return true;
  }

  /** Restore a party from saved data. Used during server restart. */
  restoreParty(
    partyId: string,
    members: { username: string; role: PartyRole; gridPosition: PartyGridPosition }[],
    setPlayerPartyId: (u: string, id: string | null) => void,
  ): GamePartyInfo {
    const party: GamePartyInfo = {
      id: partyId,
      members: members.map(m => ({
        username: m.username,
        role: m.role,
        gridPosition: m.gridPosition,
      })),
    };
    this.parties.set(partyId, party);
    for (const m of members) {
      setPlayerPartyId(m.username, partyId);
    }
    return party;
  }

  /** Get party info by ID. */
  getParty(partyId: string): GamePartyInfo | undefined {
    return this.parties.get(partyId);
  }

  /** Get party info for a player. */
  getPlayerParty(
    username: string,
    getPlayerPartyId: (u: string) => string | null,
  ): GamePartyInfo | null {
    const partyId = getPlayerPartyId(username);
    if (!partyId) return null;
    return this.parties.get(partyId) ?? null;
  }

  /** Disband all parties and clear all pending invites. */
  disbandAll(): void {
    this.parties.clear();
    this.pendingInvites.clear();
  }
}
