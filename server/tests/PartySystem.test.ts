import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PartyGridPosition } from '@idle-party-rpg/shared';
import { PARTY_INVITE_TTL_MS } from '@idle-party-rpg/shared';
import { PartySystem, INVITE_NO_LONGER_VALID } from '../src/game/social/PartySystem.js';
import { INVITE_REFUSED, NOT_INVITABLE_FROM_HERE } from '../src/game/PlayerManager.js';
import { fakeWs, setupRouteWorld } from './partyRouteFixture.js';

// Simple helpers to simulate player state
function createPlayerState() {
  const partyIds = new Map<string, string | null>();
  const positions = new Map<string, { col: number; row: number }>();
  const sameTile = (a: string, b: string) => {
    const pa = positions.get(a);
    const pb = positions.get(b);
    if (!pa || !pb) return false;
    return pa.col === pb.col && pa.row === pb.row;
  };

  return {
    getPartyId: (u: string) => partyIds.get(u) ?? null,
    setPartyId: (u: string, id: string | null) => { partyIds.set(u, id); },
    setPosition: (u: string, col: number, row: number) => { positions.set(u, { col, row }); },
    canInvite: (a: string, b: string): true | string => sameTile(a, b) ? true : 'Not in the same room',
    canJoin: (): true | string => true,
  };
}

describe('PartySystem', () => {
  let system: PartySystem;
  let state: ReturnType<typeof createPlayerState>;

  beforeEach(() => {
    system = new PartySystem();
    state = createPlayerState();
  });

  // ── Party Creation ──────────────────────────────────────────

  describe('createParty', () => {
    it('creates a solo party with the player as owner', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;

      expect(result.members).toHaveLength(1);
      expect(result.members[0].username).toBe('alice');
      expect(result.members[0].role).toBe('owner');
    });

    it('rejects creating a party if already in one', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      expect(result).toBe('You are already in a party');
    });
  });

  // ── Owner Always Present ──────────────────────────────────

  describe('ownership transfer on leave', () => {
    it('solo party has the player as owner', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      const party = system.getParty(result.id)!;
      expect(party.members[0].role).toBe('owner');
    });

    it('transfers ownership to first leader when owner leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      system.inviteToParty('alice', 'charlie', state.getPartyId, state.canInvite);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      // Promote bob to leader
      system.promoteLeader('alice', 'bob', state.getPartyId);

      // Alice (owner) leaves — bob (leader) should become owner
      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      const party = system.getParty(partyId)!;

      expect(party.members).toHaveLength(2);
      expect(party.members.find(m => m.username === 'bob')!.role).toBe('owner');
    });

    it('promotes first member to owner when owner leaves and no leaders', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      let party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'bob')!.role).toBe('member');

      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      party = system.getParty(partyId)!;

      expect(party.members).toHaveLength(1);
      expect(party.members[0].username).toBe('bob');
      expect(party.members[0].role).toBe('owner');
    });

    it('deletes party when last member leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      expect(system.getParty(result.id)).toBeUndefined();
    });

    it('retains ownership when a non-owner member leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      system.leaveParty('bob', state.getPartyId, state.setPartyId);
      const party = system.getParty(partyId)!;

      expect(party.members).toHaveLength(1);
      expect(party.members[0].username).toBe('alice');
      expect(party.members[0].role).toBe('owner');
    });
  });

  // ── Invite Flow ─────────────────────────────────────────────

  describe('invite flow', () => {
    it('creates a pending invite (not instant join)', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(result).toBe(true);

      const invites = system.getPendingInvites('bob');
      expect(invites).toHaveLength(1);
      expect(invites[0].inviterUsername).toBe('alice');
    });

    it('refuses an invite with the reason the invite policy gives', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 1, 1);

      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(result).toBe('Not in the same room');
      expect(system.getPendingInvites('bob')).toHaveLength(0);
    });

    it('rejects invite from a regular member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const inviteResult = system.inviteToParty('bob', 'charlie', state.getPartyId, state.canInvite);
      expect(inviteResult).toBe('Only owners and leaders can invite');
    });

    it('rejects duplicate invite to same party', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(result).toBe('Already invited');
    });

    it('allows accepting an invite', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const partyId = partyResult.id;

      system.createParty('bob', state.getPartyId, state.setPartyId);

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);

      const result = system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;

      expect(result.joined.members).toHaveLength(2);
      expect(result.joined.members.find(m => m.username === 'bob')).toBeTruthy();
      expect(system.getPendingInvites('bob')).toHaveLength(0);
    });

    it('invite survives either party moving', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const partyId = partyResult.id;
      system.createParty('bob', state.getPartyId, state.setPartyId);

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      state.setPosition('alice', 5, 5);
      state.setPosition('bob', 3, 1);
      expect(system.getPendingInvites('bob')).toHaveLength(1);
      expect(system.getOutgoingInvites('alice')).toEqual(['bob']);

      const result = system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      expect(typeof result).not.toBe('string');
      expect(state.getPartyId('bob')).toBe(partyId);
    });

    it('refuses an accept with the reason the join policy gives, leaving the old party and the invite', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const bobParty = system.createParty('bob', state.getPartyId, state.setPartyId);
      if (typeof bobParty === 'string') throw new Error(bobParty);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);

      const asked: [string, string][] = [];
      const result = system.acceptInvite('bob', partyResult.id, state.getPartyId, state.setPartyId, (u, id) => {
        asked.push([u, id]);
        return 'Too far to walk';
      });

      expect(result).toBe('Too far to walk');
      expect(asked).toEqual([['bob', partyResult.id]]);
      expect(state.getPartyId('bob')).toBe(bobParty.id);
      expect(system.getParty(bobParty.id)?.members.map(m => m.username)).toEqual(['bob']);
      expect(system.getPendingInvites('bob')).toHaveLength(1);
    });

    it('allows declining an invite', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(system.getPendingInvites('bob')).toHaveLength(1);

      system.declineInvite('bob', system.getPendingInvites('bob')[0].partyId);
      expect(system.getPendingInvites('bob')).toHaveLength(0);
    });

    it('rejects invite when party is full (5 members)', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      const players = ['alice', 'bob', 'charlie', 'dave', 'eve', 'frank'];
      for (const p of players) state.setPosition(p, 0, 0);

      for (const p of ['bob', 'charlie', 'dave', 'eve']) {
        system.inviteToParty('alice', p, state.getPartyId, state.canInvite);
        system.acceptInvite(p, partyId, state.getPartyId, state.setPartyId, state.canJoin);
      }

      expect(system.getParty(partyId)!.members).toHaveLength(5);

      const inviteResult = system.inviteToParty('alice', 'frank', state.getPartyId, state.canInvite);
      expect(inviteResult).toBe('Party is full (max 5)');
    });
  });

  // ── Kick ────────────────────────────────────────────────────

  describe('kick', () => {
    it('owner can kick a member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const kickResult = system.kickMember('alice', 'bob', state.getPartyId, state.setPartyId);
      expect(kickResult).toBe(true);

      const party = system.getParty(partyId)!;
      expect(party.members).toHaveLength(1);
    });

    it('leader can kick a member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.canInvite);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      system.promoteLeader('alice', 'bob', state.getPartyId);

      const kickResult = system.kickMember('bob', 'charlie', state.getPartyId, state.setPartyId);
      expect(kickResult).toBe(true);
    });

    it('leader cannot kick the owner', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      system.promoteLeader('alice', 'bob', state.getPartyId);

      const kickResult = system.kickMember('bob', 'alice', state.getPartyId, state.setPartyId);
      expect(kickResult).toBe('Cannot kick the party owner');
    });

    it('regular member cannot kick', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const kickResult = system.kickMember('bob', 'alice', state.getPartyId, state.setPartyId);
      expect(kickResult).toBe('Only owners and leaders can kick members');
    });
  });

  // ── Grid Positioning ───────────────────────────────────────

  describe('grid positioning', () => {
    it('assigns first available grid position on join', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      expect(result.members[0].gridPosition).toBe(4);
    });

    it('allows changing grid position', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      const moveResult = system.setGridPosition('alice', 0, state.getPartyId);
      expect(moveResult).toBe(true);

      const party = system.getParty(result.id)!;
      expect(party.members[0].gridPosition).toBe(0);
    });

    it('rejects moving to an occupied position', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const party = system.getParty(partyId)!;
      const alicePos = party.members.find(m => m.username === 'alice')!.gridPosition;

      const moveResult = system.setGridPosition('bob', alicePos, state.getPartyId);
      expect(moveResult).toBe('Position is taken');
    });

    it('rejects a square that is not a whole number', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      expect(system.setGridPosition('alice', 1.5 as PartyGridPosition, state.getPartyId)).toBe('Invalid position');
      expect(system.getParty(result.id)!.members[0].gridPosition).toBe(4);
    });
  });

  // ── Promote / Demote ────────────────────────────────────────

  describe('promote and demote', () => {
    it('owner can promote a member to leader', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const promoteResult = system.promoteLeader('alice', 'bob', state.getPartyId);
      expect(promoteResult).toBe(true);

      const party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'bob')!.role).toBe('leader');
      expect(party.members.find(m => m.username === 'alice')!.role).toBe('owner');
    });

    it('leader can promote a member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.canInvite);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      system.promoteLeader('alice', 'bob', state.getPartyId);

      const promoteResult = system.promoteLeader('bob', 'charlie', state.getPartyId);
      expect(promoteResult).toBe(true);

      const party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'charlie')!.role).toBe('leader');
    });

    it('regular member cannot promote', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.canInvite);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const promoteResult = system.promoteLeader('bob', 'charlie', state.getPartyId);
      expect(promoteResult).toBe('Only the owner or a leader can promote members');
    });

    it('owner can demote a leader to member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      system.promoteLeader('alice', 'bob', state.getPartyId);
      expect(system.getParty(partyId)!.members.find(m => m.username === 'bob')!.role).toBe('leader');

      const demoteResult = system.demoteLeader('alice', 'bob', state.getPartyId);
      expect(demoteResult).toBe(true);
      expect(system.getParty(partyId)!.members.find(m => m.username === 'bob')!.role).toBe('member');
    });

    it('non-owner cannot demote', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
      system.promoteLeader('alice', 'bob', state.getPartyId);

      const demoteResult = system.demoteLeader('bob', 'alice', state.getPartyId);
      expect(demoteResult).toBe('Only the owner can demote leaders');
    });
  });

  // ── Transfer Ownership ──────────────────────────────────────

  describe('transfer ownership', () => {
    it('owner can transfer ownership to a member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const transferResult = system.transferOwnership('alice', 'bob', state.getPartyId);
      expect(transferResult).toBe(true);

      const party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'bob')!.role).toBe('owner');
      expect(party.members.find(m => m.username === 'alice')!.role).toBe('leader');
    });

    it('non-owner cannot transfer ownership', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);

      const transferResult = system.transferOwnership('bob', 'alice', state.getPartyId);
      expect(transferResult).toBe('Only the owner can transfer ownership');
    });
  });

  // ── Invite cancellation on move ─────────────────────────────

  describe('cancelInvitesInvolving', () => {
    it('cancels invites where the target has moved', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(system.getPendingInvites('bob')).toHaveLength(1);

      const affected = system.cancelInvitesInvolving(new Set(['bob']));
      expect(affected.has('alice')).toBe(true);
      expect(affected.has('bob')).toBe(true);
      expect(system.getPendingInvites('bob')).toHaveLength(0);
      expect(system.getOutgoingInvites('alice')).toHaveLength(0);
    });

    it('cancels invites where the inviter has moved', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      expect(system.getPendingInvites('bob')).toHaveLength(1);

      const affected = system.cancelInvitesInvolving(new Set(['alice']));
      expect(affected.has('alice')).toBe(true);
      expect(affected.has('bob')).toBe(true);
      expect(system.getPendingInvites('bob')).toHaveLength(0);
      expect(system.getOutgoingInvites('alice')).toHaveLength(0);
    });

    it('leaves unrelated invites alone', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      system.createParty('dave', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('dave', 5, 5);
      state.setPosition('eve', 5, 5);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
      system.inviteToParty('dave', 'eve', state.getPartyId, state.canInvite);

      system.cancelInvitesInvolving(new Set(['alice']));
      expect(system.getPendingInvites('bob')).toHaveLength(0);
      expect(system.getPendingInvites('eve')).toHaveLength(1);
    });
  });
});

describe('PartySystem invite lifetime', () => {
  let system: PartySystem;
  let state: ReturnType<typeof createPlayerState>;

  beforeEach(() => {
    system = new PartySystem();
    state = createPlayerState();
    for (const u of ['alice', 'bob', 'carol']) state.setPosition(u, 0, 0);
  });

  it('cancels invites a member sent for a party they then leave', () => {
    // acceptInvite validates the accepter against the inviter's CURRENT room.
    const party = system.createParty('alice', state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
    system.inviteToParty('alice', 'carol', state.getPartyId, state.canInvite);
    expect(system.getPendingInvites('bob')).toHaveLength(1);

    system.leaveParty('alice', state.getPartyId, state.setPartyId);

    expect(system.getPendingInvites('bob')).toHaveLength(0);
    expect(system.getPendingInvites('carol')).toHaveLength(0);
  });

  it('cancels invites a member sent for a party they are kicked from', () => {
    const party = system.createParty('alice', state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
    system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.canJoin);

    // Only owners and leaders may invite, hence the promote.
    system.promoteLeader('alice', 'bob', state.getPartyId);
    system.inviteToParty('bob', 'carol', state.getPartyId, state.canInvite);
    expect(system.getPendingInvites('carol')).toHaveLength(1);

    system.kickMember('alice', 'bob', state.getPartyId, state.setPartyId);

    expect(system.getPendingInvites('carol')).toHaveLength(0);
  });

  it('cancels invites addressed to a player who leaves', () => {
    const party = system.createParty('alice', state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
    system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.canJoin);

    const solo = system.createParty('carol', state.getPartyId, state.setPartyId);
    if (typeof solo === 'string') throw new Error(solo);
    system.inviteToParty('carol', 'bob', state.getPartyId, state.canInvite);
    expect(system.getPendingInvites('bob')).toHaveLength(1);

    system.leaveParty('bob', state.getPartyId, state.setPartyId);

    expect(system.getPendingInvites('bob')).toHaveLength(0);
  });

  it('still lets a normal invite be accepted', () => {
    const party = system.createParty('alice', state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);

    const result = system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.canJoin);

    expect(typeof result).not.toBe('string');
    expect(party.members.map(m => m.username).sort()).toEqual(['alice', 'bob']);
  });
});

describe('PartySystem invite expiry and validity', () => {
  let system: PartySystem;
  let state: ReturnType<typeof createPlayerState>;
  const T0 = 1_000_000;

  beforeEach(() => {
    system = new PartySystem();
    state = createPlayerState();
    for (const u of ['alice', 'bob', 'carol']) state.setPosition(u, 0, 0);
  });

  function aliceParty(): string {
    const party = system.createParty('alice', state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    return party.id;
  }

  it('stamps an invite to expire after PARTY_INVITE_TTL_MS', () => {
    aliceParty();
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite, T0);

    expect(system.getPendingInvites('bob', T0)[0].expiresAt).toBe(T0 + PARTY_INVITE_TTL_MS);
  });

  it('stops offering an invite once it has expired, and can send it again', () => {
    const partyId = aliceParty();
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite, T0);
    const end = T0 + PARTY_INVITE_TTL_MS;

    expect(system.getPendingInvites('bob', end - 1)).toHaveLength(1);
    expect(system.getPendingInvites('bob', end)).toEqual([]);
    expect(system.getOutgoingInvites('alice', end)).toEqual([]);
    expect(system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin, end))
      .toBe('Invite not found or expired');
    expect(system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite, end)).toBe(true);
  });

  it('prunes expired invites and names who they concerned', () => {
    aliceParty();
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite, T0);
    system.inviteToParty('alice', 'carol', state.getPartyId, state.canInvite, T0 + 10);

    expect([...system.pruneExpired(T0 + PARTY_INVITE_TTL_MS)].sort()).toEqual(['alice', 'bob']);
    expect(system.getPendingInvites('bob', T0)).toEqual([]);
    expect(system.getPendingInvites('carol', T0)).toHaveLength(1);
    expect(system.pruneExpired(T0 + PARTY_INVITE_TTL_MS).size).toBe(0);
  });

  it('treats an invite whose inviter was demoted to member as no longer valid', () => {
    const partyId = aliceParty();
    system.inviteToParty('alice', 'bob', state.getPartyId, state.canInvite);
    system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.canJoin);
    system.promoteLeader('alice', 'bob', state.getPartyId);
    system.inviteToParty('bob', 'carol', state.getPartyId, state.canInvite);
    expect(system.getPendingInvites('carol')).toHaveLength(1);

    system.demoteLeader('alice', 'bob', state.getPartyId);

    expect(system.getPendingInvites('carol')).toEqual([]);
    expect(system.getOutgoingInvites('bob')).toEqual([]);
    expect(system.acceptInvite('carol', partyId, state.getPartyId, state.setPartyId, state.canJoin))
      .toBe(INVITE_NO_LONGER_VALID);
    expect(state.getPartyId('carol')).toBeNull();
  });

  it('puts a saved invite back only while its inviter can still invite and the party has room', () => {
    const partyId = aliceParty();
    const saved = { partyId, inviterUsername: 'alice', targetUsername: 'bob', timestamp: T0, expiresAt: T0 + 100 };

    expect(system.restoreInvite(saved, T0 + 100)).toBe(false);
    expect(system.restoreInvite({ ...saved, inviterUsername: 'carol' }, T0)).toBe(false);
    expect(system.restoreInvite(saved, T0)).toBe(true);
    expect(system.restoreInvite(saved, T0)).toBe(false);
    expect(system.getPendingInvites('bob', T0)).toHaveLength(1);
  });
});

describe('PlayerManager invite policy', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('lets a mutual friend be invited from another room, but not a stranger', async () => {
    const w = await setupRouteWorld(['alice', 'bob', 'carol']);
    w.placeParty('alice', 'camp');

    expect(w.pm.inviteToParty('alice', 'carol')).toBe(NOT_INVITABLE_FROM_HERE);
    expect(w.pm.inviteToParty('alice', 'bob')).toBe(NOT_INVITABLE_FROM_HERE);

    w.befriend('alice', 'bob');
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();
    expect(w.pm.parties.getPendingInvites('bob').map(i => i.inviterUsername)).toEqual(['alice']);
  });

  it('still lets anyone in the same room be invited', async () => {
    const w = await setupRouteWorld(['alice', 'carol']);
    expect(w.pm.inviteToParty('alice', 'carol')).toBeNull();
  });

  it('refuses a blocked pair either way, friends or not, with one message', async () => {
    const w = await setupRouteWorld(['alice', 'bob', 'carol']);
    w.befriend('alice', 'bob');
    w.sessions.bob.blockUser('alice', 'all');
    w.sessions.alice.blockUser('carol', 'dm');

    expect(w.pm.inviteToParty('alice', 'bob')).toBe(INVITE_REFUSED);
    expect(w.pm.inviteToParty('alice', 'carol')).toBe(INVITE_REFUSED);
  });

  it('refuses a target with no character yet', async () => {
    const w = await setupRouteWorld(['alice']);
    await w.pm.login(fakeWs(), 'newcomer');

    expect(w.pm.inviteToParty('alice', 'newcomer')).toBe(INVITE_REFUSED);
  });

  it('keeps an invite when either party moves', async () => {
    const w = await setupRouteWorld(['alice', 'bob']);
    w.befriend('alice', 'bob');
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();

    w.placeParty('alice', 'camp');
    w.placeParty('bob', 'lane');

    expect(w.pm.parties.getPendingInvites('bob')).toHaveLength(1);
  });

  it('tells the target where the inviting party is', async () => {
    const w = await setupRouteWorld(['alice', 'bob']);
    w.befriend('alice', 'bob');
    w.placeParty('alice', 'camp');
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();

    expect(w.pm.getSocialState('bob').pendingInvites[0]).toMatchObject({ roomName: 'Camp', zoneName: 'Test Vale', sameMap: true });

    w.placeParty('alice', 'isle');
    const elsewhere = w.pm.getSocialState('bob').pendingInvites[0];
    expect(elsewhere.sameMap).toBe(false);
    expect(elsewhere.roomName).toBeUndefined();
    expect(w.pm.parties.getPendingInvites('bob')[0].roomName).toBeUndefined();
  });

  it('carries the party id on the invite notification', async () => {
    const w = await setupRouteWorld(['alice', 'bob']);
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();

    const entry = w.pm.notifications.getInbox('bob').find(n => n.eventKey === 'party_invite_received');
    expect(entry?.payload).toEqual({ inviterUsername: 'alice', partyId: w.partyOf('alice') });
  });

  it('cancels invites on leave and kick', async () => {
    const w = await setupRouteWorld(['alice', 'bob', 'carol', 'dave']);
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();
    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    w.pm.parties.promoteLeader('alice', 'bob', u => w.pm.getSessionByUsername(u)?.getPartyId() ?? null);
    expect(w.pm.inviteToParty('bob', 'carol')).toBeNull();
    expect(w.pm.inviteToParty('alice', 'dave')).toBeNull();

    expect(w.pm.kickPartyMember('alice', 'bob')).toBeNull();
    expect(w.pm.parties.getPendingInvites('carol')).toEqual([]);

    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();
    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    expect(w.pm.leaveParty('alice')).toBeNull();
    expect(w.pm.parties.getPendingInvites('dave')).toEqual([]);
  });

  it('drops expired invites on save and tells both players', async () => {
    const w = await setupRouteWorld(['alice', 'bob']);
    expect(w.pm.inviteToParty('alice', 'bob')).toBeNull();
    const pushes = vi.spyOn(w.pm, 'sendStateToPlayer');

    vi.setSystemTime(Date.now() + PARTY_INVITE_TTL_MS);
    w.pm.pruneExpiredInvites();

    expect(w.pm.parties.getPendingInvites('bob')).toEqual([]);
    expect(pushes.mock.calls.map(c => c[0]).sort()).toEqual(['alice', 'bob']);
  });
});
