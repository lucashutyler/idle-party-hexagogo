import { describe, expect, it } from 'vitest';
import type { GamePartyMember } from '@idle-party-rpg/shared';
import { describeMoveBlock, removableMembers } from '../src/ui/moveBlockText';

const member = (username: string, role: GamePartyMember['role']): GamePartyMember => ({ username, role, gridPosition: 0 } as GamePartyMember);
const REASON = 'Level 6 is required to enter this room.';
const party = (...members: GamePartyMember[]) => ({ members });

describe('describeMoveBlock', () => {
  it('gives the reason alone to a lone player, never naming them', () => {
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['ana'] }, 'ana', party(member('ana', 'owner')), new Set(['ana'])))
      .toEqual({ text: REASON, removable: [] });
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['ana'] }, 'ana', null, new Set()).text).toBe(REASON);
  });

  it('gives the reason alone in a party when only the viewer is missing it', () => {
    const duo = party(member('ana', 'owner'), member('bo', 'member'));
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['ana'] }, 'ana', duo, new Set(['ana', 'bo'])).text).toBe(REASON);
  });

  it('names the others it waits on, online or offline, and the viewer too', () => {
    const trio = party(member('ana', 'owner'), member('bo', 'member'), member('cy', 'leader'));
    const online = new Set(['ana', 'cy']);
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['bo'] }, 'ana', trio, online).text)
      .toBe(`Waiting on bo (offline): ${REASON}`);
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['bo', 'cy'] }, 'ana', trio, online).text)
      .toBe(`Waiting on bo (offline) and cy (online): ${REASON}`);
    expect(describeMoveBlock({ reason: REASON, missingPlayers: ['ana', 'bo'] }, 'ana', trio, online).text)
      .toBe(`Waiting on you and bo (offline): ${REASON}`);
  });

  it('lets an owner remove anyone missing, a leader anyone but the owner, a member nobody', () => {
    const trio = party(member('ana', 'owner'), member('bo', 'member'), member('cy', 'leader'));
    const missing = { reason: REASON, missingPlayers: ['ana', 'bo', 'cy'] };
    expect(describeMoveBlock(missing, 'ana', trio, new Set()).removable).toEqual(['bo', 'cy']);
    expect(describeMoveBlock(missing, 'cy', trio, new Set()).removable).toEqual(['bo']);
    expect(describeMoveBlock(missing, 'bo', trio, new Set()).removable).toEqual([]);
  });
});

describe('removableMembers', () => {
  it('never offers the viewer or someone no longer in the party', () => {
    const duo = [member('ana', 'owner'), member('bo', 'member')];
    expect(removableMembers(['ana', 'bo', 'gone'], 'ana', duo)).toEqual(['bo']);
  });
});
