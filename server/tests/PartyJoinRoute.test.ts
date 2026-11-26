import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PARTY_INVITE_TTL_MS } from '@idle-party-rpg/shared';
import { ROOM, SEAL_QUEST, setupRouteWorld, tileAt } from './partyRouteFixture.js';
import type { RouteWorld } from './partyRouteFixture.js';

/** Friends can invite from anywhere; these accept from wherever the joiner stands. */
async function friendsApart(opts: Parameters<typeof setupRouteWorld>[1] = {}): Promise<RouteWorld> {
  const w = await setupRouteWorld(['alice', 'bob'], opts);
  w.befriend('alice', 'bob');
  return w;
}

function invite(w: RouteWorld, inviter: string, target: string): void {
  const refused = w.pm.inviteToParty(inviter, target);
  if (refused) throw new Error(refused);
}

describe('joining a party from another room', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('brings a joiner three rooms away to the party and re-seats their fog there', async () => {
    const w = await friendsApart();
    w.placeParty('alice', 'camp');
    const camp = tileAt(w.grids, 'camp');
    expect(w.sessions.bob.isTileUnlocked(camp)).toBe(false);
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();

    expect(w.partyOf('bob')).toBe(w.partyOf('alice'));
    expect(w.sessions.bob.getPosition()).toEqual(w.sessions.alice.getPosition());
    expect(w.roomOf('bob')).toBe(ROOM.camp);
    expect(w.sessions.bob.isTileUnlocked(camp)).toBe(true);
    expect(w.sessions.bob.isTileUnlocked(tileAt(w.grids, 'ridge'))).toBe(true);
  });

  it('refuses when a room on the only way there needs a higher level', async () => {
    const w = await friendsApart({ gates: { bend: { minLevel: 5 } } });
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice')))
      .toBe('You can\'t reach alice\'s room yet: Level 5 is required to enter this room.');

    w.levelTo('bob', 5);
    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    expect(w.roomOf('bob')).toBe(ROOM.camp);
  });

  it('refuses when the party\'s own room is gated for the joiner', async () => {
    const w = await friendsApart({ gates: { camp: { minLevel: 5 } } });
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toContain('Level 5 is required');
  });

  it('refuses when a quest-gated room is on the only way there', async () => {
    const w = await friendsApart({ gates: { lane: { requiredQuestIds: [SEAL_QUEST.id] } } });
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice')))
      .toBe('You can\'t reach alice\'s room yet: "Break the Seal" must be completed to enter this room.');
  });

  it('refuses across a wall, with no way through', async () => {
    const w = await friendsApart({ walls: ['bend'] });
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBe('You can\'t walk to alice\'s room from here.');
  });

  it('refuses across maps', async () => {
    const w = await friendsApart();
    w.placeParty('alice', 'isle');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBe('alice is on another map. Travel there to join.');
  });

  it('leaves the old party and the invite untouched when it refuses', async () => {
    const w = await setupRouteWorld(['alice', 'bob', 'carol'], { gates: { bend: { minLevel: 5 } } });
    w.befriend('alice', 'bob');
    const oldParty = w.partyOf('bob');
    invite(w, 'bob', 'carol');
    expect(w.pm.acceptPartyInvite('carol', oldParty)).toBeNull();
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toContain('Level 5 is required');

    expect(w.partyOf('bob')).toBe(oldParty);
    expect(w.pm.parties.getParty(oldParty)?.members.map(m => m.username).sort()).toEqual(['bob', 'carol']);
    expect(w.roomOf('bob')).toBe(ROOM.home);
    expect(w.pm.parties.getPendingInvites('bob').map(i => i.inviterUsername)).toEqual(['alice']);
  });

  it('joins at once from the same room, whatever the rooms around it need', async () => {
    const w = await setupRouteWorld(['alice', 'bob'], { gates: { lane: { minLevel: 50 } } });
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    expect(w.partyOf('bob')).toBe(w.partyOf('alice'));
  });

  it('stops a party whose queued route holds a room the joiner can\'t enter, and says who', async () => {
    const w = await friendsApart({ gates: { ridge: { minLevel: 5 } } });
    w.levelTo('alice', 5);
    w.placeParty('alice', 'camp');
    const summit = tileAt(w.grids, 'summit');
    expect(w.pm.partyBattles.handleMove(w.partyOf('alice'), 5, 2)).toEqual({ success: true });
    expect(w.pm.partyBattles.getPath(w.partyOf('alice')).map(t => t.id)).toEqual([ROOM.ridge, summit.id]);
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();

    expect(w.pm.partyBattles.getPath(w.partyOf('alice'))).toEqual([]);
    const line = 'The party stops: bob can\'t enter a room on the way.';
    expect(w.logOf('alice')).toContain(line);
    expect(w.logOf('bob')).toContain(line);
  });

  it('keeps a queued route the joiner can walk', async () => {
    const w = await friendsApart();
    w.placeParty('alice', 'camp');
    expect(w.pm.partyBattles.handleMove(w.partyOf('alice'), 5, 2)).toEqual({ success: true });
    invite(w, 'alice', 'bob');

    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    expect(w.pm.partyBattles.getPath(w.partyOf('alice')).map(t => t.id)).toEqual([ROOM.ridge, ROOM.summit]);
  });
});

describe('party invites across a restart', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('points a saved invite at the inviter\'s new solo party', async () => {
    const w = await friendsApart();
    w.placeParty('alice', 'camp');
    invite(w, 'alice', 'bob');
    const oldParty = w.partyOf('alice');
    const saves = w.pm.getAllSaveData();
    expect(saves.find(s => s.username === 'bob')?.partyInvites).toEqual([
      expect.objectContaining({ inviterUsername: 'alice' }),
    ]);
    expect(saves.find(s => s.username === 'alice')?.partyInvites).toBeUndefined();

    const pm = w.restart();
    pm.restoreFromSaveData(saves);

    const aliceParty = pm.getSessionByUsername('alice')!.getPartyId();
    expect(aliceParty).not.toBe(oldParty);
    expect(pm.parties.getPendingInvites('bob').map(i => [i.inviterUsername, i.partyId])).toEqual([['alice', aliceParty]]);
    expect(pm.parties.getOutgoingInvites('alice')).toEqual(['bob']);
  });

  it('drops invites that expired while the server was down', async () => {
    const w = await friendsApart();
    invite(w, 'alice', 'bob');
    const saves = w.pm.getAllSaveData();

    vi.setSystemTime(Date.now() + PARTY_INVITE_TTL_MS + 1);
    const pm = w.restart();
    pm.restoreFromSaveData(saves);

    expect(pm.parties.getPendingInvites('bob')).toEqual([]);
  });

  it('drops invites from a player who can no longer invite, or between blocked players', async () => {
    const w = await setupRouteWorld(['alice', 'bob', 'carol', 'dave']);
    invite(w, 'alice', 'bob');
    expect(w.pm.acceptPartyInvite('bob', w.partyOf('alice'))).toBeNull();
    w.pm.parties.promoteLeader('alice', 'bob', u => w.pm.getSessionByUsername(u)?.getPartyId() ?? null);
    invite(w, 'bob', 'carol');
    invite(w, 'alice', 'dave');
    w.pm.parties.demoteLeader('alice', 'bob', u => w.pm.getSessionByUsername(u)?.getPartyId() ?? null);
    const saves = w.pm.getAllSaveData();
    const carol = saves.find(s => s.username === 'carol')!;
    carol.partyInvites = [{ inviterUsername: 'bob', timestamp: Date.now(), expiresAt: Date.now() + 1000 }];
    w.sessions.dave.blockUser('alice', 'all');
    const daveSave = w.pm.getAllSaveData().find(s => s.username === 'dave')!;

    const pm = w.restart();
    pm.restoreFromSaveData(saves.map(s => (s.username === 'dave' ? daveSave : s)));

    expect(pm.parties.getPendingInvites('carol')).toEqual([]);
    expect(pm.parties.getPendingInvites('dave')).toEqual([]);
  });
});
