import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GamePartyMember, ServerStateMessage } from '@idle-party-rpg/shared';
import { PartyPrompts } from '../src/ui/PartyPrompts';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;

function member(username: string, role: GamePartyMember['role'], gridPosition: number): GamePartyMember {
  return { username, role, gridPosition } as GamePartyMember;
}

function makeState(viewer: string, members: GamePartyMember[], partyId = 'p1'): ServerStateMessage {
  return {
    username: viewer,
    social: { party: { id: partyId, members, henchmen: [] }, pendingInvites: [] },
  } as unknown as ServerStateMessage;
}

function setup() {
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;
  const sendPromotePartyLeader = vi.fn();
  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener, opts?: { replay?: boolean }) => {
      listeners.add(l);
      if (opts?.replay && lastState) l(lastState);
      return () => { listeners.delete(l); };
    },
    sendPromotePartyLeader,
  } as unknown as GameClient;

  const mount = () => {
    const prompts = new PartyPrompts(gameClient);
    document.body.appendChild(prompts.root);
    return prompts;
  };
  let prompts = mount();
  const push = (state: ServerStateMessage) => {
    lastState = state;
    for (const l of listeners) l(lastState);
  };
  /** A page reload: a fresh component reading what the last one stored. */
  const reload = () => {
    listeners.clear();
    prompts.root.remove();
    prompts = mount();
  };
  const card = () => document.querySelector<HTMLElement>('.party-prompt-card');
  const named = () => card()?.querySelector('strong')?.textContent ?? null;
  const promote = () => document.querySelector<HTMLButtonElement>('.party-prompt-promote')!;
  const dismiss = () => document.querySelector<HTMLButtonElement>('.party-prompt-dismiss')!;
  return { push, reload, card, named, promote, dismiss, sendPromotePartyLeader };
}

const ownerWithBob = makeState('alice', [member('alice', 'owner', 4), member('bob', 'member', 1)]);

describe('PartyPrompts', () => {
  beforeEach(() => { localStorage.clear(); });
  afterEach(() => { document.body.innerHTML = ''; });

  it('asks the owner about a plain member, and says what leaders can do', () => {
    const t = setup();
    t.push(ownerWithBob);

    expect(t.named()).toBe('bob');
    expect(t.card()!.textContent).toContain('bob joined. Let them move the party too?');
    expect(t.card()!.textContent).toContain('Leaders can move the party, invite and remove members.');
  });

  it('asks a leader too, but never a plain member', () => {
    const t = setup();
    t.push(makeState('carol', [member('alice', 'owner', 4), member('carol', 'leader', 2), member('bob', 'member', 1)]));
    expect(t.named()).toBe('bob');

    t.push(makeState('bob', [member('alice', 'owner', 4), member('bob', 'member', 1)]));
    expect(t.card()).toBeNull();
  });

  it('asks about one member at a time', () => {
    const t = setup();
    t.push(makeState('alice', [member('alice', 'owner', 4), member('bob', 'member', 1), member('dave', 'member', 2)]));
    expect(document.querySelectorAll('.party-prompt-card')).toHaveLength(1);
    expect(t.named()).toBe('bob');

    t.dismiss().click();
    expect(t.named()).toBe('dave');
  });

  it('sends the promotion from Make leader and stops asking', () => {
    const t = setup();
    t.push(ownerWithBob);

    t.promote().click();

    expect(t.sendPromotePartyLeader).toHaveBeenCalledWith('bob');
    expect(t.card()).toBeNull();
  });

  it('remembers Not now across repaints and a reload', () => {
    const t = setup();
    t.push(ownerWithBob);

    t.dismiss().click();
    expect(t.card()).toBeNull();
    expect(t.sendPromotePartyLeader).not.toHaveBeenCalled();
    t.push(ownerWithBob);
    expect(t.card()).toBeNull();

    t.reload();
    t.push(ownerWithBob);
    expect(t.card()).toBeNull();
  });

  it('asks again about the same player in a different party', () => {
    const t = setup();
    t.push(ownerWithBob);
    t.dismiss().click();

    t.push(makeState('alice', [member('alice', 'owner', 4), member('bob', 'member', 1)], 'p2'));
    expect(t.named()).toBe('bob');
  });

  it('goes away once the member is promoted or leaves', () => {
    const t = setup();
    t.push(ownerWithBob);
    expect(t.card()).not.toBeNull();

    t.push(makeState('alice', [member('alice', 'owner', 4), member('bob', 'leader', 1)]));
    expect(t.card()).toBeNull();

    t.push(makeState('alice', [member('alice', 'owner', 4)]));
    expect(t.card()).toBeNull();
  });

  it('does not ask again about a leader the owner later demotes', () => {
    const t = setup();
    t.push(makeState('alice', [member('alice', 'owner', 4), member('bob', 'leader', 1)]));

    t.push(ownerWithBob);
    expect(t.card()).toBeNull();
  });
});
