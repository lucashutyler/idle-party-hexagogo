import { describe, it, expect, beforeEach } from 'vitest';
import { PartySystem } from '../src/game/social/PartySystem.js';
import { MAX_PARTY_SIZE, MAX_HENCHMEN_PER_PARTY } from '@idle-party-rpg/shared';

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

describe('PartySystem henchmen', () => {
  let system: PartySystem;
  let state: ReturnType<typeof createPlayerState>;

  beforeEach(() => {
    system = new PartySystem();
    state = createPlayerState();
    state.setPosition('alice', 0, 0);
    state.setPosition('bob', 0, 0);
    state.setPosition('carol', 0, 0);
  });

  function soloParty(username: string) {
    const party = system.createParty(username, state.getPartyId, state.setPartyId);
    if (typeof party === 'string') throw new Error(party);
    return party;
  }

  function hire(username: string, henchmanId: string, mapId = 'overworld') {
    const result = system.hireHenchman(username, henchmanId, mapId, state.getPartyId);
    if (typeof result === 'string') throw new Error(result);
    return result;
  }

  it('keeps henchmen out of party.members entirely', () => {
    // Server call sites resolve every party.members entry to a real account.
    const party = soloParty('alice');
    hire('alice', 'hench_a');

    expect(party.members).toHaveLength(1);
    expect(party.members[0].username).toBe('alice');
    expect(party.henchmen).toHaveLength(1);
  });

  it('places a henchman on a free square, never on an occupied one', () => {
    const party = soloParty('alice');
    const owner = party.members[0];
    const hired = hire('alice', 'hench_a');

    expect(hired.gridPosition).not.toBe(owner.gridPosition);
  });

  it('never lets a joining player land on a square a henchman holds', () => {
    const party = soloParty('alice');
    const hired = hire('alice', 'hench_a');

    system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
    system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.areSameTile);

    const bob = party.members.find(m => m.username === 'bob');
    expect(bob).toBeDefined();
    expect(bob!.gridPosition).not.toBe(hired.gridPosition);
  });

  it('refuses to move a member onto a square a henchman holds', () => {
    const party = soloParty('alice');
    const hired = hire('alice', 'hench_a');

    const result = system.setGridPosition('alice', hired.gridPosition, state.getPartyId);
    expect(result).toBe('Position is taken');
  });

  it('refuses to move a henchman onto a square a member holds', () => {
    const party = soloParty('alice');
    const hired = hire('alice', 'hench_a');
    const ownerPos = party.members[0].gridPosition;

    const result = system.setHenchmanGridPosition('alice', hired.instanceId, ownerPos, state.getPartyId);
    expect(result).toBe('Position is taken');
  });

  it('rearranges a henchman onto a free square', () => {
    soloParty('alice');
    const hired = hire('alice', 'hench_a');
    const target = hired.gridPosition === 0 ? 8 : 0;

    expect(system.setHenchmanGridPosition('alice', hired.instanceId, target, state.getPartyId)).toBe(true);
    expect(system.getHenchmen(system.getPlayerParty('alice', state.getPartyId)!.id)[0].gridPosition).toBe(target);
  });

  function fillWithPlayers(party: ReturnType<typeof soloParty>, names: string[]) {
    for (const n of names) {
      state.setPosition(n, 0, 0);
      system.inviteToParty('alice', n, state.getPartyId, state.areSameTile);
      system.acceptInvite(n, party.id, state.getPartyId, state.setPartyId, state.areSameTile);
    }
  }

  it('refuses a second hire of the SAME henchman', () => {
    const party = soloParty('alice');
    hire('alice', 'hench_a');

    expect(system.hireHenchman('alice', 'hench_a', 'overworld', state.getPartyId))
      .toContain('at a time');
    expect(party.henchmen).toHaveLength(1);
  });

  it('refuses a second hire of a DIFFERENT henchman', () => {
    const party = soloParty('alice');
    hire('alice', 'hench_a');

    expect(system.hireHenchman('alice', 'hench_b', 'overworld', state.getPartyId))
      .toContain('at a time');
    expect(party.henchmen).toHaveLength(1);
  });

  it('allows hiring again once the first is dismissed', () => {
    const party = soloParty('alice');
    const first = hire('alice', 'hench_a');

    system.dismissHenchman('alice', first.instanceId, state.getPartyId);

    expect(typeof system.hireHenchman('alice', 'hench_a', 'overworld', state.getPartyId)).not.toBe('string');
    expect(party.henchmen).toHaveLength(1);
  });

  it('never lets a party hold more than the cap', () => {
    const party = soloParty('alice');
    for (let i = 0; i < 5; i++) system.hireHenchman('alice', `hench_${i}`, 'overworld', state.getPartyId);

    expect(party.henchmen!.length).toBe(MAX_HENCHMEN_PER_PARTY);
  });

  it('counts a henchman toward the party size cap', () => {
    const party = soloParty('alice');
    fillWithPlayers(party, ['bob', 'carol', 'dave']);
    hire('alice', 'hench_a');
    state.setPosition('erin', 0, 0);

    expect(party.members.length + party.henchmen!.length).toBe(MAX_PARTY_SIZE);
    expect(system.inviteToParty('alice', 'erin', state.getPartyId, state.areSameTile))
      .toContain('Party is full');
  });

  it('lets a dismissed henchman free its slot for a real player', () => {
    const party = soloParty('alice');
    fillWithPlayers(party, ['bob', 'carol', 'dave']);
    const hired = hire('alice', 'hench_a');
    state.setPosition('erin', 0, 0);
    expect(system.inviteToParty('alice', 'erin', state.getPartyId, state.areSameTile)).toContain('Party is full');

    system.dismissHenchman('alice', hired.instanceId, state.getPartyId);

    expect(system.inviteToParty('alice', 'erin', state.getPartyId, state.areSameTile)).toBe(true);
    expect(party.henchmen).toHaveLength(0);
  });

  it('refuses a hire when the party is already full of players', () => {
    const party = soloParty('alice');
    fillWithPlayers(party, ['bob', 'carol', 'dave', 'erin']);

    expect(system.hireHenchman('alice', 'hench_a', 'overworld', state.getPartyId))
      .toContain('Party is full');
  });

  it('only lets owners and leaders hire and dismiss', () => {
    const party = soloParty('alice');
    system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
    system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.areSameTile);
    const hired = hire('alice', 'hench_a');

    expect(system.hireHenchman('bob', 'hench_b', 'overworld', state.getPartyId))
      .toBe('Only owners and leaders can hire henchmen');
    expect(system.dismissHenchman('bob', hired.instanceId, state.getPartyId))
      .toBe('Only owners and leaders can dismiss henchmen');
  });

  it('dismisses a henchman when the party leaves the map it was hired on', () => {
    const party = soloParty('alice');
    const hired = hire('alice', 'hench_over', 'overworld');

    const dismissed = system.dismissHenchmenOffMap(party.id, 'cave');

    expect(dismissed.map(h => h.instanceId)).toEqual([hired.instanceId]);
    expect(system.getHenchmen(party.id)).toHaveLength(0);
  });

  it('dismisses only the off-map henchmen, if a roster ever holds several', () => {
    // Seeded directly: the hire cap allows one, but dismissHenchmenOffMap must
    // stay selective for a legacy roster or a raised cap.
    const party = soloParty('alice');
    party.henchmen = [
      { instanceId: 'h-over', henchmanId: 'a', gridPosition: 0, mapId: 'overworld' },
      { instanceId: 'h-cave', henchmanId: 'b', gridPosition: 1, mapId: 'cave' },
    ];

    const dismissed = system.dismissHenchmenOffMap(party.id, 'cave');

    expect(dismissed.map(h => h.instanceId)).toEqual(['h-over']);
    expect(system.getHenchmen(party.id).map(h => h.instanceId)).toEqual(['h-cave']);
  });

  it('dismisses nothing when the party has not changed map', () => {
    const party = soloParty('alice');
    hire('alice', 'hench_a', 'overworld');

    expect(system.dismissHenchmenOffMap(party.id, 'overworld')).toEqual([]);
    expect(system.getHenchmen(party.id)).toHaveLength(1);
  });

  it('restores henchmen, relocating any whose square a member now holds', () => {
    const party = soloParty('alice');
    const ownerPos = party.members[0].gridPosition;

    system.restoreHenchmen(party.id, [
      { instanceId: 'h1', henchmanId: 'hench_a', gridPosition: ownerPos, mapId: 'overworld' },
    ]);

    const restored = system.getHenchmen(party.id);
    expect(restored).toHaveLength(1);
    expect(restored[0].gridPosition).not.toBe(ownerPos);
  });

  it('caps a restore from a save written before the limit existed', () => {
    const party = soloParty('alice');

    system.restoreHenchmen(party.id, [
      { instanceId: 'h1', henchmanId: 'hench_a', gridPosition: 0, mapId: 'overworld' },
      { instanceId: 'h2', henchmanId: 'hench_b', gridPosition: 1, mapId: 'overworld' },
      { instanceId: 'h3', henchmanId: 'hench_c', gridPosition: 2, mapId: 'overworld' },
    ]);

    const restored = system.getHenchmen(party.id);
    expect(restored).toHaveLength(MAX_HENCHMEN_PER_PARTY);
    expect(restored[0].instanceId).toBe('h1');
  });

  it('leaves ownership with a real player when a member departs a party holding henchmen', () => {
    const party = soloParty('alice');
    system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
    system.acceptInvite('bob', party.id, state.getPartyId, state.setPartyId, state.areSameTile);
    hire('alice', 'hench_a');

    system.leaveParty('alice', state.getPartyId, state.setPartyId);

    expect(party.members).toHaveLength(1);
    expect(party.members[0].username).toBe('bob');
    expect(party.members[0].role).toBe('owner');
  });
});
