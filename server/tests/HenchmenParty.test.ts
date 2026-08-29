import { describe, it, expect, beforeEach } from 'vitest';
import { PartySystem } from '../src/game/social/PartySystem.js';
import { MAX_PARTY_SIZE } from '@idle-party-rpg/shared';

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

  it('counts henchmen toward the party size cap', () => {
    const party = soloParty('alice');
    for (let i = 0; i < MAX_PARTY_SIZE - 1; i++) hire('alice', `hench_${i}`);

    expect(party.members.length + party.henchmen!.length).toBe(MAX_PARTY_SIZE);
    expect(system.hireHenchman('alice', 'one_too_many', 'overworld', state.getPartyId))
      .toContain('Party is full');
  });

  it('blocks inviting a real player when henchmen fill the party', () => {
    soloParty('alice');
    for (let i = 0; i < MAX_PARTY_SIZE - 1; i++) hire('alice', `hench_${i}`);

    const result = system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile);
    expect(result).toContain('Party is full');
  });

  it('lets a dismissed henchman free its slot for a real player', () => {
    const party = soloParty('alice');
    const hires = [];
    for (let i = 0; i < MAX_PARTY_SIZE - 1; i++) hires.push(hire('alice', `hench_${i}`));

    system.dismissHenchman('alice', hires[0].instanceId, state.getPartyId);
    expect(system.inviteToParty('alice', 'bob', state.getPartyId, state.areSameTile)).toBe(true);
    expect(party.henchmen).toHaveLength(MAX_PARTY_SIZE - 2);
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

  it('dismisses only the henchmen hired on a map the party has left', () => {
    const party = soloParty('alice');
    const overworld = hire('alice', 'hench_over', 'overworld');
    const cave = hire('alice', 'hench_cave', 'cave');

    const dismissed = system.dismissHenchmenOffMap(party.id, 'cave');

    expect(dismissed.map(h => h.instanceId)).toEqual([overworld.instanceId]);
    expect(system.getHenchmen(party.id).map(h => h.instanceId)).toEqual([cave.instanceId]);
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

  it('restores two henchmen onto distinct squares', () => {
    const party = soloParty('alice');
    const ownerPos = party.members[0].gridPosition;

    system.restoreHenchmen(party.id, [
      { instanceId: 'h1', henchmanId: 'hench_a', gridPosition: ownerPos, mapId: 'overworld' },
      { instanceId: 'h2', henchmanId: 'hench_b', gridPosition: ownerPos, mapId: 'overworld' },
    ]);

    const restored = system.getHenchmen(party.id);
    expect(restored).toHaveLength(2);
    expect(restored[0].gridPosition).not.toBe(restored[1].gridPosition);
    expect(restored.map(h => h.gridPosition)).not.toContain(ownerPos);
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
