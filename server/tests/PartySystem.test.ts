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
    it('creates a solo party with the player as leader', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;

      expect(result.members).toHaveLength(1);
      expect(result.members[0].username).toBe('alice');
      expect(result.members[0].role).toBe('leader');
    });

    it('rejects creating a party if already in one', () => {
      system.createParty('alice', state.getPartyId, state.setPartyId);
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      expect(result).toBe('You are already in a party');
    });
  });

  // ── Leader Always Present ──────────────────────────────────

  describe('leader always present', () => {
    it('solo party has the player as leader', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      const party = system.getParty(result.id)!;
      expect(party.members.every(m => m.role === 'leader' || party.members.some(l => l.role === 'leader'))).toBe(true);
      expect(party.members[0].role).toBe('leader');
    });

    it('transfers leadership when the only leader leaves', () => {
      // Create party with alice as leader
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      // Add bob and charlie via invite+accept
      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);
      state.setPosition('charlie', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      system.inviteToParty('alice', 'charlie', state.getPartyId, state.areSameTile);
      system.acceptInvite('charlie', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      // Verify alice is leader
      let party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'alice')!.role).toBe('leader');

      // Alice leaves — leadership should transfer
      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      party = system.getParty(partyId)!;

      expect(party.members).toHaveLength(2);
      const leaders = party.members.filter(m => m.role === 'leader');
      expect(leaders.length).toBeGreaterThanOrEqual(1);
    });

    it('promotes first remaining member when last leader leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      // Bob is a member, not a leader
      let party = system.getParty(partyId)!;
      expect(party.members.find(m => m.username === 'bob')!.role).toBe('member');

      // Alice (only leader) leaves
      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      party = system.getParty(partyId)!;

      // Bob should be promoted to leader
      expect(party.members).toHaveLength(1);
      expect(party.members[0].username).toBe('bob');
      expect(party.members[0].role).toBe('leader');
    });

    it('deletes party when last member leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      system.leaveParty('alice', state.getPartyId, state.setPartyId);
      expect(system.getParty(partyId)).toBeUndefined();
    });

    it('retains leadership when a non-leader member leaves', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      // Bob leaves (non-leader)
      system.leaveParty('bob', state.getPartyId, state.setPartyId);
      const party = system.getParty(partyId)!;

      expect(party.members).toHaveLength(1);
      expect(party.members[0].username).toBe('alice');
      expect(party.members[0].role).toBe('leader');
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

      // Bob should have a pending invite, not be in the party yet
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

      // Bob needs his own party first (always in a party)
      system.createParty('bob', state.getPartyId, state.setPartyId);

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);

      const result = system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);
      expect(typeof result).not.toBe('string');
      if (typeof result === 'string') return;

      expect(result.joined.members).toHaveLength(2);
      expect(result.joined.members.find(m => m.username === 'bob')).toBeTruthy();

      // Pending invites should be cleared
      expect(system.getPendingInvites('bob')).toHaveLength(0);
    });

    it('rejects accept if inviter moved to a different tile', () => {
      const partyResult = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof partyResult === 'string') throw new Error(partyResult);
      const partyId = partyResult.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);

      // Alice moves away before bob accepts
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
  });

  // ── Kick ────────────────────────────────────────────────────

  describe('kick', () => {
    it('leader can kick a member', () => {
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
      expect(party.members[0].username).toBe('alice');
    });

    it('non-leader cannot kick', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const kickResult = system.kickMember('bob', 'alice', state.getPartyId, state.setPartyId);
      expect(kickResult).toBe('Only leaders can kick members');
    });
  });

  // ── Grid Positioning ───────────────────────────────────────

  describe('grid positioning', () => {
    it('assigns first available grid position on join', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);

      // Alice gets position 4 (center)
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

      // Get alice's position and try to move bob there
      const party = system.getParty(partyId)!;
      const alicePos = party.members.find(m => m.username === 'alice')!.gridPosition;

      const moveResult = system.setGridPosition('bob', alicePos, state.getPartyId);
      expect(moveResult).toBe('Position is taken');
    });
  });

  // ── Promote ────────────────────────────────────────────────

  describe('promote', () => {
    it('leader can promote a member to leader', () => {
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
      // Alice is also still leader (multiple leaders allowed)
      expect(party.members.find(m => m.username === 'alice')!.role).toBe('leader');
    });

    it('non-leader cannot promote', () => {
      const result = system.createParty('alice', state.getPartyId, state.setPartyId);
      if (typeof result === 'string') throw new Error(result);
      const partyId = result.id;

      state.setPosition('alice', 0, 0);
      state.setPosition('bob', 0, 0);

      system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
      system.acceptInvite('bob', partyId, state.getPartyId, state.setPartyId, state.areSameTile);

      const promoteResult = system.promoteLeader('bob', 'alice', state.getPartyId);
      expect(promoteResult).toBe('Only leaders can promote');
    });
  });
});
