import { describe, it, expect, beforeEach } from 'vitest';
import { PartySystem } from '../src/game/social/PartySystem.js';

// Simple helpers to simulate player state
function createPlayerState() {
  const partyIds = new Map<string, string | null>();
  const positions = new Map<string, { col: number; row: number }>();

  return {
    getPartyId: (u: string) => partyIds.get(u) ?? null,
    setPartyId: (u: string, id: string | null) => { partyIds.set(u, id); },
    setPosition: (u: string, col: number, row: number) => { positions.set(u, { col, row }); },
    areSameTile: (a: string, b: string) => {
      const pa = positions.get(a);
      const pb = positions.get(b);
      if (!pa || !pb) return false;
      return pa.col === pb.col && pa.row === pb.row;
    },
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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      system.inviteToParty('alice', 'charlie', state.getPartyId, state.areSameTile);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      expect(result).toBe(true);

      const invites = system.getPendingInvites('bob');
      expect(invites).toHaveLength(1);
      expect(invites[0].inviterUsername).toBe('alice');
    });

    it('rejects invite if not on the same tile', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 1, 1);

      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      expect(result).toBe('Must be in the same room to invite');
    });

    it('rejects invite from a regular member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const inviteResult = system.inviteToParty('bob', 'charlie', state.getPartyId, state.areSameTile);
      expect(inviteResult).toBe('Only owners and leaders can invite');
    });

    it('rejects duplicate invite to same party', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      expect(result).toBe('Already invited');
    });

    it('allows accepting an invite', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const partyId = partyResult.id;

      system.createParty('bob', state.getPartyId, state.setPartyId);

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);

      const result = system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;

      expect(result.joined.members).toHaveLength(2);
      expect(result.joined.members.find(m => m.username === 'bob')).toBeTruthy();
      expect(system.getPendingInvites('bob')).toHaveLength(0);
    });

    it('rejects accept if inviter moved to a different tile', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const partyId = partyResult.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      state.setPosition('alice', 5, 5);

      const result = system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      expect(result).toBe('Inviter is no longer in your room');
    });

    it('allows declining an invite', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
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
        system.inviteToParty('alice', p, state.getPartyId, state.areSameTile);
        system.acceptInvite(p, partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      }

      expect(system.getParty(partyId)!.members).toHaveLength(5);

      const inviteResult = system.inviteToParty('alice', 'frank', state.getPartyId, state.areSameTile);
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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.areSameTile);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const party = system.getParty(partyId)!;
      const alicePos = party.members.find(m => m.username === 'alice')!.gridPosition;

      const moveResult = system.setGridPosition('bob', alicePos, state.getPartyId);
      expect(moveResult).toBe('Position is taken');
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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.areSameTile);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      system.inviteToParty('alice', 'charlie', state.getPartyId, state.areSameTile);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const promoteResult = system.promoteLeader('bob', 'charlie', state.getPartyId);
      expect(promoteResult).toBe('Only the owner or a leader can promote members');
    });

    it('owner can demote a leader to member', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

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

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const transferResult = system.transferOwnership('bob', 'alice', state.getPartyId);
      expect(transferResult).toBe('Only the owner can transfer ownership');
    });
  });
});
