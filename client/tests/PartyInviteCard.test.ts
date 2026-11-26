import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PartyInvite, ServerStateMessage } from '@idle-party-rpg/shared';
import { PartyInviteCard } from '../src/ui/PartyInviteCard';
import { LEADER_PROMPTS_STORAGE_KEY } from '../src/ui/PartyPrompts';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;
type Patch = Record<string, unknown>;

function invite(inviter: string, timestamp: number, extra: Partial<PartyInvite> = {}): PartyInvite {
  return { partyId: `party_${inviter}`, inviterUsername: inviter, targetUsername: 'alice', timestamp, ...extra };
}

const solo = { id: 'p_alice', members: [{ username: 'alice', role: 'owner', gridPosition: 4 }], henchmen: [] };

function makeState(invites: PartyInvite[], social: Patch = {}, top: Patch = {}): ServerStateMessage {
  return {
    username: 'alice',
    social: { party: solo, pendingInvites: invites, notifications: [], ...social },
    ...top,
  } as unknown as ServerStateMessage;
}

function setup(initial?: ServerStateMessage) {
  document.body.innerHTML = '';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = initial ?? null;
  const sendAcceptPartyInvite = vi.fn();
  const sendDeclinePartyInvite = vi.fn();
  const sendPromotePartyLeader = vi.fn();
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener, opts?: { replay?: boolean }) => {
      listeners.add(l);
      if (opts?.replay && lastState) l(lastState);
      return () => { listeners.delete(l); };
    },
    sendAcceptPartyInvite,
    sendDeclinePartyInvite,
    sendPromotePartyLeader,
  } as unknown as GameClient;
  const openParty = vi.fn();
  const card = new PartyInviteCard(gameClient, openParty);
  document.body.appendChild(card.root);

  const push = (invites: PartyInvite[], social: Patch = {}, top: Patch = {}) => {
    lastState = makeState(invites, social, top);
    for (const l of listeners) l(lastState);
  };
  const cards = () => [...document.querySelectorAll<HTMLElement>('.party-invite-list .party-invite-card')];
  const inviters = () => cards().map(c => c.querySelector('strong')!.textContent);
  const button = (inviter: string, cls: string) =>
    document.querySelector<HTMLButtonElement>(`.party-invite-card[data-party-id="party_${inviter}"] .${cls}`);

  return { push, cards, inviters, button, openParty, sendAcceptPartyInvite, sendDeclinePartyInvite };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

async function answerConfirm(ok: boolean): Promise<void> {
  (document.querySelector(ok ? '.confirm-ok' : '.confirm-cancel') as HTMLButtonElement).click();
  await Promise.resolve();
  await Promise.resolve();
}

describe('PartyInviteCard', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    document.body.innerHTML = '';
  });

  it('shows one card per invite, newest first, at most two and then how many more', () => {
    const t = setup();
    t.push([invite('bob', 1)]);
    expect(t.inviters()).toEqual(['bob']);
    expect(document.querySelector('.party-invite-more')).toBeNull();

    t.push([invite('bob', 1), invite('carol', 3), invite('dave', 2), invite('erin', 0)]);
    expect(t.inviters()).toEqual(['carol', 'dave']);
    const more = document.querySelector('.party-invite-more') as HTMLButtonElement;
    expect(more.textContent).toBe('+2 more');

    more.click();
    expect(t.openParty).toHaveBeenCalledOnce();
  });

  it('paints from the last state when it mounts', () => {
    const t = setup(makeState([invite('bob', 1)]));
    expect(t.inviters()).toEqual(['bob']);
  });

  it('says where the inviting party is, when the invite says', () => {
    const t = setup();
    t.push([
      invite('bob', 3, { roomName: 'Camp', zoneName: 'Test Vale', sameMap: true }),
      invite('carol', 2, { sameMap: false }),
    ]);
    const where = () => t.cards().map(c => c.querySelector('.party-invite-where')?.textContent ?? null);
    expect(where()).toEqual(['In Camp, Test Vale', 'On another map']);
    expect(t.cards()[0].textContent).toContain('bob invited you to their party');

    t.push([invite('dave', 1)]);
    expect(where()).toEqual([null]);
  });

  it('joins at once from a solo party with no hires', () => {
    const t = setup();
    t.push([invite('bob', 1)]);

    t.button('bob', 'party-invite-join')!.click();

    expect(t.sendAcceptPartyInvite).toHaveBeenCalledWith('party_bob');
    expect(document.querySelector('.confirm-ok')).toBeNull();
  });

  it.each([
    ['in a dungeon', {}, { dungeon: { dungeonId: 'pit', name: 'Pit', floor: 1, totalFloors: 2, isBossFloor: false } }, 'Your dungeon run will end.'],
    ['with other players', {
      party: { id: 'p_carol', members: [{ username: 'carol', role: 'owner', gridPosition: 4 }, { username: 'alice', role: 'member', gridPosition: 1 }], henchmen: [] },
    }, {}, 'You will leave carol\'s party.'],
    ['with hires', { party: { ...solo, henchmen: [{ instanceId: 'h1', henchmanId: 'hm', gridPosition: 0, mapId: 'm' }] } }, {}, 'Your hired fighters will leave.'],
  ])('asks before joining %s', async (_label, social, top, line) => {
    const t = setup();
    t.push([invite('bob', 1)], social, top);

    t.button('bob', 'party-invite-join')!.click();
    expect(document.querySelector('.confirm-title')?.textContent).toBe('Join bob\'s party?');
    expect(document.querySelector('.confirm-body')?.textContent).toContain(line);
    expect(t.sendAcceptPartyInvite).not.toHaveBeenCalled();
    await answerConfirm(false);
    expect(t.sendAcceptPartyInvite).not.toHaveBeenCalled();

    t.button('bob', 'party-invite-join')!.click();
    await answerConfirm(true);
    expect(t.sendAcceptPartyInvite).toHaveBeenCalledWith('party_bob');
  });

  it('declines', () => {
    const t = setup();
    t.push([invite('bob', 1)]);

    t.button('bob', 'party-invite-decline')!.click();

    expect(t.sendDeclinePartyInvite).toHaveBeenCalledWith('party_bob');
    expect(t.sendAcceptPartyInvite).not.toHaveBeenCalled();
  });

  it('puts off only the invite Later was pressed on, until that invite ends', () => {
    const t = setup();
    t.push([invite('bob', 2), invite('carol', 1)]);

    t.button('bob', 'party-invite-later')!.click();
    expect(t.inviters()).toEqual(['carol']);
    t.push([invite('bob', 2), invite('carol', 1)]);
    expect(t.inviters()).toEqual(['carol']);

    t.push([invite('carol', 1)]);
    t.push([invite('bob', 5), invite('carol', 1)]);
    expect(t.inviters()).toEqual(['bob', 'carol']);
  });

  it('takes a card down when its invite leaves the state', () => {
    const t = setup();
    t.push([invite('bob', 1)]);
    expect(t.cards()).toHaveLength(1);

    t.push([]);
    expect(t.cards()).toHaveLength(0);
    expect(document.querySelector('.party-invite-list')!.innerHTML).toBe('');
  });

  it('holds a repaint while a card button is pressed, so the tap still lands', () => {
    vi.useFakeTimers();
    try {
      const t = setup();
      t.push([invite('bob', 1)]);
      const join = t.button('bob', 'party-invite-join')!;

      press(join);
      t.push([invite('carol', 2), invite('bob', 1)]);
      expect(t.button('bob', 'party-invite-join')).toBe(join);
      expect(t.inviters()).toEqual(['bob']);

      join.click();
      expect(t.sendAcceptPartyInvite).toHaveBeenCalledWith('party_bob');
      vi.advanceTimersByTime(0);
      expect(t.inviters()).toEqual(['carol', 'bob']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('has no leader prompt in a solo party', () => {
    setup(makeState([]));
    expect(document.querySelector('.party-prompt-card')).toBeNull();
    expect(localStorage.getItem(LEADER_PROMPTS_STORAGE_KEY)).toBeNull();
  });
});
