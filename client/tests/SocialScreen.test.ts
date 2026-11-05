import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { SocialScreen } from '../src/screens/SocialScreen';
import { dismissTop } from '../src/ui/ModalStack';
import { dismissMapToast } from '../src/ui/MapToast';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type SocialPatch = Record<string, unknown>;

function makeState(inviters: string[], social: SocialPatch = {}, top: SocialPatch = {}): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: 0, row: 0 },
    otherPlayers: [],
    character: { inventory: {}, level: 30 },
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
      ...social,
    },
    ...top,
  } as unknown as ServerStateMessage;
}

const partyOfThree = {
  party: {
    id: 'p0',
    members: [
      { username: 'alice', role: 'owner', gridPosition: 4 },
      { username: 'bob', role: 'member', gridPosition: 2 },
      { username: 'carol', role: 'leader', gridPosition: 6 },
    ],
    henchmen: [],
  },
};

function setup() {
  document.body.innerHTML = '<div id="social"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = null;
  const sends: Record<string, ReturnType<typeof vi.fn>> = {};
  let serverError: (message: string, code?: string) => void = () => {};

  const gameClient = new Proxy({
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    onResume: () => () => {},
    onServerError: (l: typeof serverError) => { serverError = l; return () => {}; },
    onPlayerProfile: () => () => {},
  }, {
    get(target, prop: string) {
      if (prop in target) return target[prop as keyof typeof target];
      if (prop.startsWith('send')) return (sends[prop] ??= vi.fn());
      return undefined;
    },
  }) as unknown as GameClient;

  const worldCache = {
    getSkillContent: () => ({ skills: {} }),
    getTileOn: () => ({ zone: 'zone_key' }),
    getSlotSchedule: () => [],
  } as unknown as WorldCache;
  const screen = new SocialScreen('social', gameClient, worldCache);

  const pushState = (state: ServerStateMessage) => {
    lastState = state;
    for (const l of listeners) l(lastState);
  };
  const push = (inviters: string[], social: SocialPatch = {}, top: SocialPatch = {}) =>
    pushState(makeState(inviters, social, top));
  const acceptBtn = (inviter: string) =>
    document.querySelector(`.social-accept-invite[data-party-id="party_${inviter}"]`) as HTMLButtonElement | null;
  const send = (name: string) => (sends[name] ??= vi.fn());
  const tab = (id: string) => document.querySelector(`[data-seg="${id}"]`) as HTMLButtonElement;
  const badge = (id: string) => tab(id).querySelector('.ui-segment-badge')?.textContent ?? null;
  const panel = () => document.querySelector('.social-panel') as HTMLElement;

  return { screen, push, acceptBtn, send, tab, badge, panel, listeners, serverError: (message: string, code?: string) => serverError(message, code) };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('SocialScreen gift refusals', () => {
  afterEach(() => {
    dismissMapToast();
    document.body.innerHTML = '';
  });

  it('shows the reason a gift was refused', () => {
    const t = setup();

    t.serverError('That player can\'t receive gifts', 'gift_refused');

    expect(document.querySelector('.map-toast')?.textContent).toBe('That player can\'t receive gifts');
  });

  it('leaves other server errors alone', () => {
    const t = setup();

    t.serverError('Invalid message format');

    expect(document.querySelector('.map-toast')).toBeNull();
  });
});

function stubSheetViewport(matches: boolean): void {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches, media: query, addEventListener() {}, removeEventListener() {} }));
}

async function answerConfirm(ok: boolean): Promise<void> {
  const button = document.querySelector(ok ? '.confirm-ok' : '.confirm-cancel') as HTMLButtonElement;
  button.click();
  await Promise.resolve();
  await Promise.resolve();
}

describe('SocialScreen segments', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('reaches every sub-view from its segments and saves the choice', () => {
    const t = setup();
    expect(t.tab('party').getAttribute('aria-selected')).toBe('true');

    for (const id of ['guild', 'friends', 'ranks']) {
      t.tab(id).click();
      expect(t.tab(id).getAttribute('aria-selected')).toBe('true');
      expect(sessionStorage.getItem('socialSubTab')).toBe(id);
    }
    t.screen.onDeactivate();
  });

  it('opens friends directly, including from the old saved view and notification target', () => {
    const t = setup();
    t.screen.setSubTab('friends');
    expect(sessionStorage.getItem('socialSubTab')).toBe('friends');

    t.screen.setSubTab('party');
    t.screen.setSubTab('friend_requests');
    expect(sessionStorage.getItem('socialSubTab')).toBe('friends');

    sessionStorage.setItem('socialSubTab', 'users');
    const reloaded = setup();
    expect(reloaded.tab('friends').getAttribute('aria-selected')).toBe('true');
  });

  it('ignores unknown sub-views', () => {
    const t = setup();
    t.screen.setSubTab('nonsense');
    expect(t.tab('party').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps badge counts live on the matching segments', () => {
    const t = setup();
    t.push(['bob']);
    t.screen.onActivate();
    expect(t.badge('party')).toBe('1');
    expect(t.badge('friends')).toBeNull();

    t.push(['bob', 'carol'], { incomingFriendRequests: [{ fromUsername: 'dave' }] });
    expect(t.badge('party')).toBe('2');
    expect(t.badge('friends')).toBe('1');

    t.push([]);
    expect(t.badge('party')).toBeNull();
    expect(t.badge('friends')).toBeNull();
    t.screen.onDeactivate();
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
    expect(t.send('sendAcceptPartyInvite')).toHaveBeenCalledWith('party_bob');

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

  it('shows empty grid spots without any text', () => {
    const t = setup();
    t.push([]);
    t.screen.onActivate();
    const cells = [...document.querySelectorAll('.social-party-cell')];
    expect(cells).toHaveLength(9);
    expect(cells.filter(c => !c.classList.contains('occupied')).every(c => c.textContent === '')).toBe(true);
    expect(t.panel().textContent).not.toContain('Empty');
    t.screen.onDeactivate();
  });

  it('listens for document touchmove only during a drag', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const t = setup();
    t.push([]);
    t.screen.onActivate();
    const touchmoveAdds = () => add.mock.calls.filter(c => c[0] === 'touchmove').length;
    const touchmoveRemoves = () => remove.mock.calls.filter(c => c[0] === 'touchmove').length;
    expect(touchmoveAdds()).toBe(0);

    const selfCell = document.querySelector('.social-party-cell[data-pos="4"]') as HTMLElement;
    selfCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(touchmoveAdds()).toBe(1);
    expect(document.querySelector('.party-drag-ghost')).not.toBeNull();

    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(touchmoveRemoves()).toBe(1);
    expect(document.querySelector('.party-drag-ghost')).toBeNull();
    t.screen.onDeactivate();
    add.mockRestore();
    remove.mockRestore();
  });

  it('does not start a drag from another player\'s cell', () => {
    const t = setup();
    t.push([], partyOfThree);
    t.screen.onActivate();
    const bobCell = document.querySelector('.social-party-cell[data-pos="2"]') as HTMLElement;
    bobCell.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
    expect(document.querySelector('.party-drag-ghost')).toBeNull();
    t.screen.onDeactivate();
  });

  it('moves to a tapped empty spot, and a refused move puts the grid back', () => {
    const t = setup();
    t.push([]);
    t.screen.onActivate();
    const empty = document.querySelector('.social-party-cell[data-pos="0"]') as HTMLElement;
    empty.click();
    expect(t.send('sendSetPartyGridPosition')).toHaveBeenCalledWith(0, undefined);

    vi.advanceTimersByTime(400);
    expect(document.querySelector('.social-party-cell[data-pos="0"]')!.classList.contains('occupied')).toBe(true);

    vi.advanceTimersByTime(2000);
    expect(document.querySelector('.social-party-cell[data-pos="0"]')!.classList.contains('occupied')).toBe(false);
    expect(document.querySelector('.social-party-cell[data-pos="4"]')!.classList.contains('occupied')).toBe(true);
    t.screen.onDeactivate();
  });

  it('keeps the panel live when a move never reports its animation ending', () => {
    const t = setup();
    t.push([]);
    t.screen.onActivate();
    (document.querySelector('.social-party-cell[data-pos="0"]') as HTMLElement).click();
    vi.advanceTimersByTime(400);

    t.push(['bob']);
    expect(t.acceptBtn('bob')).not.toBeNull();
    t.screen.onDeactivate();
  });
});

describe('SocialScreen confirmations', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it.each([
    ['.social-kick-btn[data-username="bob"]', 'sendKickPartyMember', ['bob']],
    ['.social-transfer-btn[data-username="bob"]', 'sendTransferPartyOwnership', ['bob']],
    ['.social-party-leave-btn', 'sendLeaveParty', []],
  ])('%s asks first and only then sends', async (selector, sendName, args) => {
    const t = setup();
    t.push([], partyOfThree);
    t.screen.onActivate();

    (document.querySelector(selector) as HTMLButtonElement).click();
    expect(t.send(sendName)).not.toHaveBeenCalled();
    await answerConfirm(false);
    expect(t.send(sendName)).not.toHaveBeenCalled();

    (document.querySelector(selector) as HTMLButtonElement).click();
    await answerConfirm(true);
    expect(t.send(sendName)).toHaveBeenCalledWith(...args);
    t.screen.onDeactivate();
  });

  it('asks before leaving a guild', async () => {
    const t = setup();
    t.push([], { guild: { id: 'g', name: 'Guild', leaderUsername: 'alice' }, guildMembers: [{ username: 'alice', role: 'leader' }] });
    t.screen.setSubTab('guild');
    t.screen.onActivate();

    (document.querySelector('.social-guild-leave-btn') as HTMLButtonElement).click();
    expect(t.send('sendLeaveGuild')).not.toHaveBeenCalled();
    await answerConfirm(true);
    expect(t.send('sendLeaveGuild')).toHaveBeenCalled();
    t.screen.onDeactivate();
  });
});

describe('SocialScreen guild creation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  const typeName = (name: string) => {
    const input = document.querySelector('.social-guild-name-input') as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const createBtn = () => document.querySelector('.social-guild-create-btn') as HTMLButtonElement;

  it('disables Create below the level floor and says why', () => {
    const t = setup();
    t.push([], { guild: null }, { character: { inventory: {}, level: 12 } });
    t.screen.setSubTab('guild');
    t.screen.onActivate();
    typeName('Name');
    expect(createBtn().disabled).toBe(true);
    expect(t.panel().textContent).toContain('You are level 12');
    t.screen.onDeactivate();
  });

  it('enables Create once a name is typed at the required level', () => {
    const t = setup();
    t.push([], { guild: null });
    t.screen.setSubTab('guild');
    t.screen.onActivate();
    expect(createBtn().disabled).toBe(true);
    typeName('Name');
    expect(createBtn().disabled).toBe(false);
    createBtn().click();
    expect(t.send('sendCreateGuild')).toHaveBeenCalledWith('Name');
    t.screen.onDeactivate();
  });
});

describe('SocialScreen party room list', () => {
  const owner = { id: 'p', members: [{ username: 'alice', role: 'owner', gridPosition: 4 }] };
  const bobHere = { otherPlayers: [{ username: 'bob', col: 0, row: 0 }] };
  const invite = () => document.querySelector('.social-nearby-invite') as HTMLButtonElement;

  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('paints an invite only from what the server says went out', () => {
    const t = setup();
    t.push([], { party: { ...owner, henchmen: [] } }, bobHere);
    t.screen.onActivate();

    invite().click();
    expect(t.send('sendInviteParty')).toHaveBeenCalledWith('bob');
    expect(invite().disabled).toBe(false);
    expect(invite().textContent).toBe('Invite');

    t.push([], { party: { ...owner, henchmen: [] }, outgoingPartyInvites: ['bob'] }, bobHere);
    expect(invite().disabled).toBe(true);
    expect(invite().textContent).toBe('Invited');
  });

  it('turns the invite off with a reason when the party is full', () => {
    const t = setup();
    const henchmen = [0, 1, 2, 3].map(i => ({ instanceId: `h${i}`, gridPosition: i }));
    t.push([], { party: { ...owner, henchmen } }, bobHere);
    t.screen.onActivate();

    expect(invite().disabled).toBe(true);
    expect(document.querySelector('.social-party-roster')!.textContent).toContain('Your party is full (5/5)');
  });

  it('keeps keyboard focus on the same grid cell across a repaint', () => {
    const t = setup();
    t.push([], { party: { ...owner, henchmen: [] } });
    t.screen.onActivate();
    (document.querySelector('.social-party-cell[data-pos="1"]') as HTMLElement).focus();

    t.push([], { party: { id: 'p', members: [{ username: 'alice', role: 'owner', gridPosition: 1 }], henchmen: [] } });
    const active = document.activeElement as HTMLElement;
    expect(active.getAttribute('data-pos')).toBe('1');
    expect(active.classList.contains('self')).toBe(true);
  });
});

describe('SocialScreen guild creation', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  const reason = () => document.querySelector('.social-guild-reason') as HTMLElement;
  const create = () => document.querySelector('.social-guild-create-btn') as HTMLButtonElement;
  const typeName = (name: string) => {
    const input = document.querySelector('.social-guild-name-input') as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  it('asks an eligible player for a name, then gets out of the way', () => {
    const t = setup();
    t.push([], {}, { character: { level: 34 } });
    t.screen.onActivate();
    t.screen.setSubTab('guild');

    expect(create().disabled).toBe(true);
    expect(reason().textContent).toBe('Pick a name to start your guild.');
    typeName('Hexers');
    expect(create().disabled).toBe(false);
    expect(reason().hidden).toBe(true);
  });

  it('gives the level reason to a player below the limit, name or not', () => {
    const t = setup();
    t.push([], {}, { character: { level: 7 } });
    t.screen.onActivate();
    t.screen.setSubTab('guild');

    expect(reason().textContent).toBe('Starting a guild needs level 20. You are level 7.');
    typeName('Hexers');
    expect(create().disabled).toBe(true);
    expect(reason().hidden).toBe(false);
  });
});

describe('SocialScreen long ranks', () => {
  const players = Array.from({ length: 250 }, (_, i) => ({
    username: `p${String(i).padStart(3, '0')}`,
    className: 'Knight',
    level: 1000 - i,
  }));
  const open = (self: string) => {
    const t = setup();
    t.push([], { allPlayers: players, party: { id: 'p', members: [{ username: self, role: 'owner', gridPosition: 4 }], henchmen: [] } }, { username: self });
    t.screen.onActivate();
    t.screen.setSubTab('ranks');
    return t;
  };
  const rows = () => [...document.querySelectorAll<HTMLElement>('.social-rank-row')];

  afterEach(() => {
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  it('renders a first window, and the player\'s own row even when the window ends above it', () => {
    open('p200');
    expect(rows()).toHaveLength(101);
    const self = rows()[100];
    expect(self.getAttribute('data-username')).toBe('p200');
    expect(self.classList.contains('self')).toBe(true);
    expect(self.querySelector('.social-rank-num')!.textContent).toBe('201');
    expect(document.querySelector('.social-user-count')!.textContent).toBe('250 players');
    expect(document.querySelector('.social-rank-you')!.textContent).toBe('You: #201');
  });

  it('grows the window on request until everyone is listed', () => {
    open('p000');
    const more = document.querySelector('.social-rank-more') as HTMLButtonElement;
    expect(more.hidden).toBe(false);
    expect(more.textContent).toContain('150');

    more.click();
    expect(rows()).toHaveLength(200);
    more.click();
    expect(rows()).toHaveLength(250);
    expect(more.hidden).toBe(true);
  });

  it('rewrites only the rows a level change touches', () => {
    const t = open('p000');
    const before = rows();
    const changed = players.map(p => (p.username === 'p003' ? { ...p, level: 1 } : p));
    t.push([], { allPlayers: changed, party: { id: 'p', members: [{ username: 'p000', role: 'owner', gridPosition: 4 }], henchmen: [] } }, { username: 'p000' });

    const after = rows();
    expect(after).toHaveLength(100);
    expect(after[0]).toBe(before[0]);
    expect(after[2]).toBe(before[2]);
    expect(after[3]).not.toBe(before[3]);
    expect(after[3].getAttribute('data-username')).toBe('p004');
    expect(after[3].querySelector('.social-rank-num')!.textContent).toBe('4');
  });

  it('empties the list while away and rebuilds it on return', () => {
    const t = open('p000');
    t.screen.onDeactivate();
    expect(rows()).toHaveLength(0);
    t.screen.onActivate();
    expect(rows()).toHaveLength(100);
    expect(rows()[0].getAttribute('data-username')).toBe('p000');
  });
});

describe('SocialScreen friends and ranks', () => {
  const allPlayers = [
    { username: 'low', className: 'Knight', level: 5 },
    { username: 'top', className: 'Mage', level: 50 },
    { username: 'alice', className: 'Knight', level: 30 },
    { username: 'pal', className: 'Bard', level: 20 },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  const rowNames = (selector: string) =>
    [...document.querySelectorAll(selector)].map(r => r.getAttribute('data-username'));

  it('numbers ranks by level and points to the player\'s own row', () => {
    const t = setup();
    t.push([], { allPlayers });
    t.screen.setSubTab('ranks');
    t.screen.onActivate();

    expect(rowNames('.social-rank-row')).toEqual(['top', 'alice', 'pal', 'low']);
    expect([...document.querySelectorAll('.social-rank-num')].map(n => n.textContent)).toEqual(['1', '2', '3', '4']);
    expect(document.querySelector('.social-rank-row.self')!.getAttribute('data-username')).toBe('alice');
    expect(document.querySelector('.social-rank-you')!.textContent).toBe('You: #2');
    t.screen.onDeactivate();
  });

  it('debounces ranks search and keeps real rank numbers when filtered', () => {
    const t = setup();
    t.push([], { allPlayers });
    t.screen.setSubTab('ranks');
    t.screen.onActivate();

    const input = document.querySelector('[data-search="ranks"]') as HTMLInputElement;
    input.value = 'pal';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    expect(rowNames('.social-rank-row')).toHaveLength(4);

    vi.advanceTimersByTime(200);
    expect(rowNames('.social-rank-row')).toEqual(['pal']);
    expect(document.querySelector('.social-rank-num')!.textContent).toBe('3');
    expect(document.querySelector('[data-search="ranks"]')).toBe(input);
    expect((document.querySelector('.social-rank-you') as HTMLElement).hidden).toBe(true);
    t.screen.onDeactivate();
  });

  it('filters by zone using the raw zone key, not the display name', () => {
    const t = setup();
    t.push([], { allPlayers }, {
      zoneName: 'Display Name',
      currentMapId: 'm',
      otherPlayers: [
        { username: 'pal', col: 9, row: 9, zone: 'zone_key' },
        { username: 'low', col: 9, row: 9, zone: 'elsewhere' },
      ],
    });
    t.screen.setSubTab('ranks');
    t.screen.onActivate();
    (document.querySelector('.social-filter-btn[data-filter="zone"]') as HTMLButtonElement).click();
    expect(rowNames('.social-rank-row')).toEqual(['pal']);
    t.screen.onDeactivate();
  });

  it('only walks status dots when someone came or went', () => {
    const t = setup();
    t.push([], { allPlayers });
    t.screen.setSubTab('ranks');
    t.screen.onActivate();
    t.push([], { allPlayers, onlinePlayers: ['alice'] });
    const walk = vi.spyOn(t.panel(), 'querySelectorAll');

    t.push([], { allPlayers, onlinePlayers: ['alice'] });
    expect(walk).not.toHaveBeenCalledWith('[data-username]');

    t.push([], { allPlayers, onlinePlayers: ['alice', 'pal'] });
    expect(walk).toHaveBeenCalledWith('[data-username]');
    expect(document.querySelector('.social-user-row[data-username="pal"] .social-status-dot')!.classList.contains('online')).toBe(true);
    walk.mockRestore();
    t.screen.onDeactivate();
  });

  it('groups friends and moves requests to the friends view', () => {
    const t = setup();
    t.push([], {
      allPlayers,
      friends: ['top', 'pal'],
      onlinePlayers: ['alice', 'top'],
      incomingFriendRequests: [{ fromUsername: 'low' }],
      outgoingFriendRequests: [],
      blockedUsers: {},
    });
    t.screen.setSubTab('friends');
    t.screen.onActivate();

    const text = t.panel().textContent ?? '';
    expect(text).toContain('Friend requests');
    expect(text).toContain('Online');
    expect(text).toContain('Offline');

    (document.querySelector('[data-action="accept_friend_request"]') as HTMLButtonElement).click();
    expect(t.send('sendAcceptFriendRequest')).toHaveBeenCalledWith('low');
    (document.querySelector('[data-action="friend_chat"][data-username="top"]') as HTMLButtonElement).click();
    expect(t.send('sendSetChatPreferences')).toHaveBeenCalledWith('dm', 'top');
    t.screen.onDeactivate();
  });

  it('offers to add players found by search, and says so when nothing matches', () => {
    const t = setup();
    t.push([], { allPlayers, friends: [] });
    t.screen.setSubTab('friends');
    t.screen.onActivate();
    expect(t.panel().textContent).toContain('No friends yet');

    const input = document.querySelector('[data-search="friends"]') as HTMLInputElement;
    input.value = 'to';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(200);
    (document.querySelector('[data-action="add_friend"][data-username="top"]') as HTMLButtonElement).click();
    expect(t.send('sendFriendRequest')).toHaveBeenCalledWith('top');

    input.value = 'zzz';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    vi.advanceTimersByTime(200);
    expect(t.panel().textContent).toContain('No players match');
    t.screen.onDeactivate();
  });
});

describe('user popup', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    while (dismissTop());
    document.body.innerHTML = '';
    sessionStorage.clear();
  });

  const anchor = () => {
    const el = document.createElement('button');
    document.body.appendChild(el);
    return el;
  };
  const item = (text: string) =>
    [...document.querySelectorAll<HTMLButtonElement>('.user-popup-item')].find(b => b.textContent?.startsWith(text)) ?? null;

  it('opens as a bottom sheet on phones, with no inline placement', () => {
    stubSheetViewport(true);
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('bob', anchor());
    const popup = document.querySelector('.user-popup-menu') as HTMLElement;
    expect(popup.classList.contains('user-popup-sheet')).toBe(true);
    expect(popup.style.top).toBe('');
    expect(document.querySelector('.user-popup-overlay-sheet')).not.toBeNull();
  });

  it('opens at the anchor on desktop', () => {
    stubSheetViewport(false);
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('bob', anchor());
    const popup = document.querySelector('.user-popup-menu') as HTMLElement;
    expect(popup.classList.contains('user-popup-sheet')).toBe(false);
    expect(popup.style.top).not.toBe('');
  });

  it.each([
    ['not in the room', {}, 'You must be in the same room'],
    ['already invited', { outgoingPartyInvites: ['bob'] }, 'Waiting for their answer'],
    ['not a leader', { party: { id: 'p', members: [{ username: 'alice', role: 'member', gridPosition: 4 }], henchmen: [] } }, 'Only the party owner or a leader'],
    ['party full', {
      party: {
        id: 'p',
        members: [{ username: 'alice', role: 'owner', gridPosition: 4 }],
        henchmen: [0, 1, 2, 3].map(i => ({ instanceId: `h${i}`, gridPosition: i })),
      },
    }, 'Your party is full (5/5)'],
  ])('shows the reason invites are off: %s', (_label, social, reason) => {
    const t = setup();
    t.push([], social);
    t.screen.showUserPopup('bob', anchor());
    const invite = item('Invite') ?? item('Invited');
    expect(invite?.disabled).toBe(true);
    expect(invite?.querySelector('.user-popup-note')?.textContent).toContain(reason);
    expect(invite?.getAttribute('title')).toBeNull();
  });

  it('closes the anchored menu when a rotation calls for the sheet, and re-clamps it otherwise', () => {
    const t = setup();
    t.push([]);
    const media = (sheet: boolean) => vi.spyOn(window, 'matchMedia').mockImplementation(() => ({ matches: sheet }) as unknown as MediaQueryList);

    media(false);
    t.screen.showUserPopup('bob', anchor());
    const menu = document.querySelector('.user-popup-menu') as HTMLElement;
    menu.style.left = '9000px';
    menu.getBoundingClientRect = () => ({ left: 9000, top: 20, width: 290, height: 300 }) as DOMRect;
    window.dispatchEvent(new Event('resize'));
    expect(parseInt(menu.style.left, 10)).toBeLessThan(window.innerWidth);

    media(true);
    window.dispatchEvent(new Event('resize'));
    expect(document.querySelector('.user-popup-menu')).toBeNull();
    vi.restoreAllMocks();
  });

  it('enables the invite when the player shares the room', () => {
    const t = setup();
    t.push([], {}, { otherPlayers: [{ username: 'bob', col: 0, row: 0 }] });
    t.screen.showUserPopup('bob', anchor());
    item('Invite to Party')!.click();
    expect(t.send('sendInviteParty')).toHaveBeenCalledWith('bob');
    expect(document.querySelector('.user-popup-menu')).toBeNull();
  });

  it('closes through Back and Escape, the X and the backdrop', () => {
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('bob', anchor());
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.user-popup-menu')).toBeNull();
    expect(document.querySelector('.user-popup-overlay')).toBeNull();
    expect(dismissTop()).toBe(false);

    t.screen.showUserPopup('bob', anchor());
    (document.querySelector('.user-popup-close') as HTMLButtonElement).click();
    expect(document.querySelector('.user-popup-menu')).toBeNull();

    t.screen.showUserPopup('bob', anchor());
    (document.querySelector('.user-popup-overlay') as HTMLElement).click();
    expect(document.querySelector('.user-popup-menu')).toBeNull();
  });

  it('confirms Block, but not Unblock', async () => {
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('bob', anchor());
    item('Block')!.click();
    expect(document.querySelector('.user-popup-menu')).toBeNull();
    expect(t.send('sendBlockUser')).not.toHaveBeenCalled();
    await answerConfirm(true);
    expect(t.send('sendBlockUser')).toHaveBeenCalledWith('bob', 'all');

    t.push([], { blockedUsers: { bob: 'all' } });
    t.screen.showUserPopup('bob', anchor());
    item('Unblock')!.click();
    expect(t.send('sendUnblockUser')).toHaveBeenCalledWith('bob');
  });

  it('does not call a player named after an Object.prototype member blocked', () => {
    const t = setup();
    t.push([], { blockedUsers: {} });
    t.screen.showUserPopup('constructor', anchor());
    expect(item('Block')).not.toBeNull();
    expect(item('Unblock')).toBeNull();
    expect(document.querySelector('.user-popup-menu')?.textContent).not.toContain('Blocked');
  });

  it('confirms removing a friend', async () => {
    const t = setup();
    t.push([], { friends: ['bob'] });
    t.screen.showUserPopup('bob', anchor());
    item('Remove Friend')!.click();
    expect(t.send('sendRemoveFriend')).not.toHaveBeenCalled();
    await answerConfirm(true);
    expect(t.send('sendRemoveFriend')).toHaveBeenCalledWith('bob');
  });

  it('opens the running trade instead of disabling Trade', () => {
    const t = setup();
    t.push([], {
      proposedTrades: [{
        id: 'trade_1',
        status: 'pending',
        initiator: { username: 'bob', items: [] },
        target: { username: 'alice', items: [] },
        lastUpdatedBy: 'bob',
        nonce: 'n',
      }],
    });
    t.screen.showUserPopup('bob', anchor());
    const trade = item('Open Trade')!;
    expect(trade.querySelector('.user-popup-note')?.textContent).toBe('Already in progress');
    trade.click();
    expect(document.querySelector('.trade-modal')).not.toBeNull();
    expect(document.querySelector('.trade-modal-title')?.textContent).toBe('Trade with bob');
  });

  it('closes the gift modal through Back and Escape', () => {
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('bob', anchor());
    item('Send Gift')!.click();
    expect(document.querySelector('.trade-modal')).not.toBeNull();
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.trade-modal')).toBeNull();
  });

  it('closes the profile through Back and Escape', () => {
    const t = setup();
    t.push([]);
    (t.screen as unknown as { renderPlayerProfileModal(p: unknown): void }).renderPlayerProfileModal({
      username: 'bob',
      className: 'Knight',
      level: 3,
      equipment: {},
      itemDefinitions: {},
      setDefinitions: {},
      skillLoadout: { equippedSkills: [] },
      partyMembers: [],
    });
    expect(document.querySelector('.player-profile-overlay')).not.toBeNull();
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.player-profile-overlay')).toBeNull();
  });

  it('shows the self popup with no actions', () => {
    const t = setup();
    t.push([]);
    t.screen.showUserPopup('alice', anchor());
    const popup = document.querySelector('.user-popup-self')!;
    expect(popup.querySelector('.user-popup-item')).toBeNull();
    expect(dismissTop()).toBe(true);
    expect(document.querySelector('.user-popup-self')).toBeNull();
  });
});
