import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { SocialScreen } from '../src/screens/SocialScreen';
import type { GameClient } from '../src/network/GameClient';
import type { ChatLocalStore } from '../src/network/ChatLocalStore';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

function makeState(inviters: string[]): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: 0, row: 0 },
    otherPlayers: [],
    character: { inventory: {} },
    itemDefinitions: {},
    social: {
      party: {
        id: 'p0',
        members: [{ username: 'alice', role: 'owner', gridPosition: 4 }],
        henchmen: [],
      },
      pendingInvites: inviters.map(name => ({ partyId: `party_${name}`, inviterUsername: name })),
      outgoingPartyInvites: [],
      onlinePlayers: ['alice'],
    },
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '<div id="social"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;
  const sendAcceptPartyInvite = vi.fn();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onResume: () => () => {},
    onServerError: () => () => {},
    onChat: () => () => {},
    onSyncChat: () => () => {},
    sendSyncChat: () => {},
    sendAcceptPartyInvite,
  } as unknown as GameClient;

  const chatStore = { getLatestId: () => null, addMessage: () => {}, mergeSyncBatch: () => {} } as unknown as ChatLocalStore;
  const worldCache = { getSkillContent: () => ({ skills: {} }) } as unknown as WorldCache;
  const screen = new SocialScreen('social', gameClient, chatStore, worldCache);

  const push = (inviters: string[]) => {
    lastState = makeState(inviters);
    for (const l of listeners) l(lastState);
  };
  const acceptBtn = (inviter: string) =>
    document.querySelector(`.social-accept-invite[data-party-id="party_${inviter}"]`) as HTMLButtonElement | null;

  return { screen, push, acceptBtn, sendAcceptPartyInvite };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('SocialScreen party panel', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sessionStorage.clear();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('holds a structural rebuild while an invite button is pressed', () => {
    const t = setup();
    t.push(['bob']);
    t.screen.onActivate();
    const btn = t.acceptBtn('bob')!;

    press(btn);
    t.push(['bob', 'carol']);
    expect(t.acceptBtn('bob')).toBe(btn);
    expect(t.acceptBtn('carol')).toBeNull();

    btn.click();
    expect(t.sendAcceptPartyInvite).toHaveBeenCalledWith('party_bob');

    vi.advanceTimersByTime(0);
    expect(t.acceptBtn('carol')).not.toBeNull();
    t.screen.onDeactivate();
  });

  it('rebuilds immediately when nothing is pressed', () => {
    const t = setup();
    t.push(['bob']);
    t.screen.onActivate();

    t.push(['bob', 'carol']);
    expect(t.acceptBtn('carol')).not.toBeNull();
    t.screen.onDeactivate();
  });
});
