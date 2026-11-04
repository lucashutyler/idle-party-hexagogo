import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { SocialScreen } from '../src/screens/SocialScreen';
import type { GameClient } from '../src/network/GameClient';
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
    sendAcceptPartyInvite,
  } as unknown as GameClient;

  const worldCache = { getSkillContent: () => ({ skills: {} }) } as unknown as WorldCache;
  const screen = new SocialScreen('social', gameClient, worldCache);

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

describe('SocialScreen sub-views', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('reaches every sub-view from its segments and saves the choice', () => {
    const t = setup();
    const tab = (id: string) => document.querySelector(`[data-seg="${id}"]`) as HTMLButtonElement;
    expect(tab('party').getAttribute('aria-selected')).toBe('true');

    tab('guild').click();
    expect(tab('guild').getAttribute('aria-selected')).toBe('true');
    expect(sessionStorage.getItem('socialSubTab')).toBe('guild');

    tab('users').click();
    expect(sessionStorage.getItem('socialSubTab')).toBe('users');
    t.screen.onDeactivate();
  });

  it('opens friends on the leaderboard view', () => {
    const t = setup();
    t.screen.setSubTab('friends');
    expect(sessionStorage.getItem('socialSubTab')).toBe('users');
  });

  it('ignores unknown sub-views', () => {
    const t = setup();
    t.screen.setSubTab('nonsense');
    expect((document.querySelector('[data-seg="party"]') as HTMLElement).getAttribute('aria-selected')).toBe('true');
  });
});

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
