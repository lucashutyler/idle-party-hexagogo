import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import { ChatPopout } from '../src/ui/ChatPopout';
import { ChatStrip } from '../src/ui/ChatStrip';
import type { ChatPreview } from '../src/ui/chatModel';
import { chatFocusTracker } from '../src/network/ChatFocusTracker';
import { bringToFront, dismissTop, release } from '../src/ui/ModalStack';
import { CHAT_ROW_CAP } from '../src/ui/chatModel';
import type { GameClient } from '../src/network/GameClient';

type ChatListener = (msg: ChatMessage) => void;
type SyncListener = (messages: ChatMessage[], full: boolean) => void;
type StateListener = (state: ServerStateMessage) => void;
type ConnectionListener = (connected: boolean) => void;
type ErrorListener = (message: string) => void;

interface MediaOverrides {
  column?: boolean;
  coarse?: boolean;
  fine?: boolean;
}

function message(id: string, sender: string, text = `hello from ${sender}`, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id, channelType: 'zone', channelId: 'z1', senderUsername: sender, text, timestamp: Date.now(), ...over };
}

function stateWith(over: Record<string, unknown> = {}): ServerStateMessage {
  return {
    username: 'me',
    currentMapId: 'map1',
    party: { col: 1, row: 2 },
    social: {
      party: { id: 'p1', members: [{ username: 'me' }] },
      guild: null,
      allPlayers: [{ username: 'Mira', className: 'Knight' }],
      blockedUsers: {},
      chatPreferences: { sendChannel: 'global', dmTarget: '' },
    },
    ...over,
  } as unknown as ServerStateMessage;
}

function mockMedia({ column = false, coarse = false, fine = true }: MediaOverrides): void {
  vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
    matches: query.includes('min-width: 860px') ? column : query.includes('coarse') ? coarse : query.includes('fine') ? fine : false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }) as unknown as MediaQueryList);
}

describe('ChatPopout over a navigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    delete document.body.dataset.chatOpen;
    delete document.body.dataset.chatLayout;
    localStorage.clear();
  });

  it('closes a chat that covers the screen and leaves the sheet and column alone', () => {
    mockMedia({ column: false });
    localStorage.setItem('chatPopoutMobileLayout', 'full');
    const full = setup();
    full.chat.open();
    full.chat.closeIfCovering();
    expect(full.chat.isVisible()).toBe(false);

    localStorage.setItem('chatPopoutMobileLayout', 'sheet');
    const sheet = setup();
    sheet.chat.open();
    sheet.chat.closeIfCovering();
    expect(sheet.chat.isVisible()).toBe(true);

    mockMedia({ column: true });
    localStorage.setItem('chatPopoutMobileLayout', 'full');
    const column = setup();
    column.chat.open();
    column.chat.closeIfCovering();
    expect(column.chat.isVisible()).toBe(true);
    expect(column.chat.isLandscapeColumn()).toBe(false);
  });

  it('treats the column as a phone panel only in short landscape', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-height: 500px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList);
    const t = setup();
    expect(t.chat.isLandscapeColumn()).toBe(false);
    t.chat.open();
    expect(t.chat.isLandscapeColumn()).toBe(true);
  });

  it('treats the column as a phone panel on a phone wide enough for the rail', () => {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('max-height: 500px') || query.includes('min-width: 860px'),
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList);
    const t = setup();
    t.chat.open();
    expect(t.chat.isLandscapeColumn()).toBe(true);
  });
});

function setup(initialState: ServerStateMessage | null = stateWith()) {
  document.body.innerHTML = '<div id="screen-container"></div><div id="chat-popout-root"></div>';
  const chatListeners = new Set<ChatListener>();
  const syncListeners = new Set<SyncListener>();
  const stateListeners = new Set<StateListener>();
  const connectionListeners = new Set<ConnectionListener>();
  const errorListeners = new Set<ErrorListener>();

  const gameClient = {
    lastState: initialState,
    onChat: (l: ChatListener) => { chatListeners.add(l); return () => chatListeners.delete(l); },
    onSyncChat: (l: SyncListener) => { syncListeners.add(l); return () => syncListeners.delete(l); },
    subscribe: (l: StateListener, opts?: { replay?: boolean }) => {
      stateListeners.add(l);
      if (opts?.replay && gameClient.lastState) l(gameClient.lastState);
      return () => stateListeners.delete(l);
    },
    onResume: () => () => {},
    onConnection: (l: ConnectionListener) => { connectionListeners.add(l); return () => connectionListeners.delete(l); },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => errorListeners.delete(l); },
    sendSyncChat: vi.fn(),
    sendChat: vi.fn(() => true),
    sendSetChatPreferences: vi.fn(),
  };

  const worldCache = { getTileOn: vi.fn(() => ({ zone: 'raw_zone' })) };
  const chat = new ChatPopout(gameClient as unknown as GameClient, worldCache as never);
  const onUserClick = vi.fn();
  chat.setOnUserClick(onUserClick);

  const receive = (msg: ChatMessage) => { for (const l of chatListeners) l(msg); };
  const sync = (messages: ChatMessage[]) => { for (const l of syncListeners) l(messages, true); };
  const pushState = (state: ServerStateMessage) => {
    gameClient.lastState = state;
    for (const l of stateListeners) l(state);
  };
  const connect = () => { for (const l of connectionListeners) l(true); };
  const serverError = (text: string) => { for (const l of errorListeners) l(text); };
  const senderBtn = (user: string) => document.querySelector(`.chat-msg-sender-btn[data-user="${user}"]`) as HTMLButtonElement | null;
  const texts = () => [...document.querySelectorAll('.chat-msg-text')].map(el => el.textContent);
  const tab = (id: string) => document.querySelector(`.chat-tab[data-tab="${id}"]`) as HTMLButtonElement;
  const input = () => document.querySelector('.chat-popout-input') as HTMLInputElement;
  const select = () => document.querySelector('.chat-popout-channel') as HTMLSelectElement;
  const dmTarget = () => document.querySelector('.chat-popout-dm-target') as HTMLInputElement;
  const clickSend = () => (document.querySelector('.chat-popout-send') as HTMLElement).click();
  const status = () => document.querySelector('.chat-status') as HTMLElement;
  const pill = () => document.querySelector('.chat-new-pill') as HTMLElement;
  const timeline = () => document.querySelector('.chat-popout-timeline') as HTMLElement;

  return {
    chat, gameClient, worldCache, receive, sync, pushState, connect, serverError, senderBtn, texts,
    onUserClick, tab, input, select, dmTarget, clickSend, status, pill, timeline,
  };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

function setLayoutBox(el: HTMLElement, box: { scrollHeight: number; clientHeight: number; scrollTop: number }): void {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, value: box.scrollHeight });
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: box.clientHeight });
  el.scrollTop = box.scrollTop;
}

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  mockMedia({});
});

afterEach(() => {
  document.dispatchEvent(new PointerEvent('pointercancel'));
  vi.restoreAllMocks();
  vi.useRealTimers();
  document.body.innerHTML = '';
  delete document.body.dataset.chatOpen;
  delete document.body.dataset.chatLayout;
  delete document.body.dataset.chatTyping;
  while (dismissTop()) { /* drain the module-level stack between tests */ }
});

describe('ChatPopout timeline', () => {
  it('holds an incoming-message rebuild while a sender name is pressed', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    const bob = t.senderBtn('bob')!;

    press(bob);
    t.receive(message('m2', 'carol'));
    expect(t.senderBtn('bob')).toBe(bob);
    expect(t.senderBtn('carol')).toBeNull();

    bob.click();
    expect(t.onUserClick).toHaveBeenCalledWith('bob', bob);

    vi.advanceTimersByTime(0);
    expect(t.senderBtn('carol')).not.toBeNull();
  });

  it('holds a sync rebuild the same way', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    const bob = t.senderBtn('bob')!;

    press(bob);
    t.sync([message('m2', 'carol')]);
    expect(t.senderBtn('bob')).toBe(bob);

    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(t.texts()).toEqual(['hello from bob', 'hello from carol']);
  });

  it('does not lose an out-of-order rebuild to a later append during a press', () => {
    const t = setup();
    t.chat.open();
    const now = Date.now();
    t.receive(message('m2', 'bob', 'second', { timestamp: now }));
    const bob = t.senderBtn('bob')!;

    press(bob);
    t.sync([message('m1', 'carol', 'first', { timestamp: now - 1000 })]);
    t.receive(message('m3', 'dan', 'third', { timestamp: now + 1000 }));
    document.dispatchEvent(new PointerEvent('pointercancel'));

    expect(t.texts()).toEqual(['first', 'second', 'third']);
  });

  it('keeps timeline nodes when a duplicate message arrives', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    const bob = t.senderBtn('bob');

    t.receive(message('m1', 'bob'));
    expect(t.senderBtn('bob')).toBe(bob);
  });

  it('appends without rebuilding earlier rows', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    const bob = t.senderBtn('bob');

    t.receive(message('m2', 'carol'));
    expect(t.senderBtn('bob')).toBe(bob);
    expect(t.senderBtn('carol')).not.toBeNull();
  });

  it('shows messages that arrived while closed when reopened', () => {
    const t = setup();
    t.chat.open();
    t.chat.close();
    t.receive(message('m1', 'bob'));
    expect(t.senderBtn('bob')).toBeNull();

    t.chat.open();
    expect(t.senderBtn('bob')).not.toBeNull();
  });

  it('caps rows in the DOM', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m0', 'bob'));
    for (let i = 1; i <= 205; i++) t.receive(message(`m${i}`, 'bob', `line ${i}`));
    expect(document.querySelectorAll('.chat-msg')).toHaveLength(200);
    expect(t.texts().at(-1)).toBe('line 205');
  });

  it('hides blocked senders, and brings them back when unblocked', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'grief'));
    t.receive(message('m2', 'bob'));

    const blocked = stateWith();
    blocked.social!.blockedUsers = { grief: 'all' };
    t.pushState(blocked);
    expect(t.senderBtn('grief')).toBeNull();
    expect(t.senderBtn('bob')).not.toBeNull();

    t.pushState(stateWith());
    expect(t.senderBtn('grief')).not.toBeNull();
  });

  it('treats a message with a non-string channelId as ordinary text', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob', 'still here', { channelType: 'global', channelId: 42 as unknown as string }));
    expect(t.texts()).toEqual(['still here']);
  });

  it('shows who a sent DM went to in the All view', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'me', 'hi', { channelType: 'dm', channelId: 'Mira' }));
    expect(document.querySelector('.chat-msg-dm-to')).not.toBeNull();
    expect(t.senderBtn('Mira')).not.toBeNull();
  });

  it('leaves server rows without a popup or channel switch', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'Server', 'welcome', { channelType: 'server', channelId: 'server' }));
    expect(document.querySelector('.chat-msg-server button')).toBeNull();
  });

  it('applies a filter immediately and persists it', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    (document.querySelector('.chat-filter[data-ch="zone"]') as HTMLElement).click();
    expect(t.texts()).toEqual([]);
    expect(JSON.parse(localStorage.getItem('chatPopoutFilters')!).zone).toBe(false);
    expect(document.querySelector('.chat-empty')).not.toBeNull();
  });
});

describe('ChatPopout scrollback', () => {
  it('holds position while scrolled up and counts what is waiting', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    setLayoutBox(t.timeline(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    t.timeline().dispatchEvent(new Event('scroll'));

    t.receive(message('m2', 'carol'));
    t.receive(message('m3', 'dan'));
    expect(t.senderBtn('carol')).toBeNull();
    expect(t.timeline().scrollTop).toBe(100);
    expect(t.pill().hidden).toBe(false);
    expect(t.pill().textContent).toBe('↓ 2 new');

    t.pill().click();
    expect(t.pill().hidden).toBe(true);
    expect(t.senderBtn('dan')).not.toBeNull();
  });

  it('catches up when scrolled back to the bottom by hand', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    setLayoutBox(t.timeline(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    t.timeline().dispatchEvent(new Event('scroll'));
    t.receive(message('m2', 'carol'));

    t.timeline().scrollTop = 800;
    t.timeline().dispatchEvent(new Event('scroll'));
    expect(t.senderBtn('carol')).not.toBeNull();
    expect(t.pill().hidden).toBe(true);
  });

  it('jumps to the bottom for my own message', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    setLayoutBox(t.timeline(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    t.timeline().dispatchEvent(new Event('scroll'));

    t.receive(message('m2', 'me', 'mine'));
    expect(t.senderBtn('me')).not.toBeNull();
    expect(t.pill().hidden).toBe(true);
  });
});

describe('ChatPopout unread and preview', () => {
  function withPreview() {
    const t = setup();
    const previews: ChatPreview[] = [];
    const counts: number[] = [];
    t.chat.setOnPreviewChange(p => previews.push(p));
    t.chat.setOnUnreadChange(c => counts.push(c));
    return { ...t, previews, counts };
  }

  it('seeds last-seen on first run, so old backlog does not count', () => {
    const t = withPreview();
    t.sync([message('old', 'bob', 'old', { timestamp: Date.now() + 60_000 })]);
    vi.advanceTimersByTime(1000);
    expect(t.counts.at(-1)).toBe(0);
    expect(t.previews.at(-1)?.message?.text).toBe('old');
  });

  it('counts messages after last-seen, including synced ones', () => {
    localStorage.setItem('chatLastSeenAt', '1000');
    const t = withPreview();
    t.sync([message('m1', 'bob', 'a', { timestamp: 500 }), message('m2', 'bob', 'b', { timestamp: 2000 })]);
    vi.advanceTimersByTime(1000);
    expect(t.counts.at(-1)).toBe(1);
  });

  it('clears on open and remembers across a reload', () => {
    localStorage.setItem('chatLastSeenAt', '1000');
    const t = withPreview();
    t.receive(message('m1', 'bob', 'a', { timestamp: 2000 }));
    vi.advanceTimersByTime(1000);
    expect(t.counts.at(-1)).toBe(1);

    t.chat.open();
    expect(t.counts.at(-1)).toBe(0);
    expect(localStorage.getItem('chatLastSeenAt')).toBe('2000');
  });

  it('repaints the preview at most once a second', () => {
    localStorage.setItem('chatLastSeenAt', '1000');
    const t = withPreview();
    vi.advanceTimersByTime(1000);
    t.previews.length = 0;
    for (let i = 0; i < 5; i++) t.receive(message(`m${i}`, 'bob', `t${i}`, { timestamp: 2000 + i }));
    expect(t.previews.length).toBeLessThanOrEqual(1);
    vi.advanceTimersByTime(1000);
    expect(t.previews.length).toBeLessThanOrEqual(2);
    expect(t.previews.at(-1)?.count).toBe(5);
  });

  it('asks for the backlog at boot and again on reconnect', () => {
    const t = setup();
    expect(t.gameClient.sendSyncChat).toHaveBeenCalledTimes(1);
    t.receive(message('m1', 'bob'));
    t.connect();
    expect(t.gameClient.sendSyncChat).toHaveBeenLastCalledWith('m1');
  });
});

describe('ChatStrip', () => {
  function strip() {
    document.body.innerHTML = `
      <div id="chat-strip-slot">
        <button class="chat-strip-open">
          <span class="chat-strip-open-icon"></span>
          <span class="chat-strip-open-label">Chat</span>
        </button>
      </div>`;
    const onOpen = vi.fn();
    const slot = document.getElementById('chat-strip-slot')!;
    return { strip: new ChatStrip(slot, onOpen), slot, onOpen };
  }

  it('paints the sender and escaped text', () => {
    const { strip: s, slot } = strip();
    s.render({ count: 1, message: message('m1', 'bob', '<b>hi</b>') });
    expect(slot.querySelector('.chat-strip-sender')?.textContent).toBe('bob');
    expect(slot.querySelector('.chat-strip-text')?.textContent).toBe('<b>hi</b>');
    expect(slot.querySelector('b')).toBeNull();
    expect(slot.classList.contains('has-preview')).toBe(true);
  });

  it('dims a server line', () => {
    const { strip: s, slot } = strip();
    s.render({ count: 0, message: message('m1', 'Server', 'welcome', { channelType: 'server' }) });
    expect(slot.querySelector('.chat-strip-dim')).not.toBeNull();
  });

  it('falls back to a label with nothing to show', () => {
    const { strip: s, slot } = strip();
    s.render({ count: 0, message: null });
    expect(slot.querySelector('.chat-strip-open-label')?.textContent).toBe('Chat');
    expect(slot.classList.contains('has-preview')).toBe(false);
  });

  it('opens on a swipe up but not on a sideways drag', () => {
    const { slot, onOpen } = strip();
    const button = slot.querySelector('.chat-strip-open')!;
    const pointer = (type: string, x: number, y: number) => button.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: x, clientY: y, bubbles: true }),
    );
    pointer('pointerdown', 100, 100);
    pointer('pointerup', 200, 80);
    expect(onOpen).not.toHaveBeenCalled();

    pointer('pointerdown', 100, 100);
    pointer('pointerup', 100, 50);
    expect(onOpen).toHaveBeenCalledOnce();
  });
});

describe('ChatPopout tabs and DMs', () => {
  function withFullMembership() {
    return stateWith({
      social: {
        party: { id: 'p1', members: [{ username: 'me' }, { username: 'Mira' }] },
        guild: { id: 'guild-id' },
        allPlayers: [{ username: 'Mira', className: 'Knight' }],
        blockedUsers: {},
        chatPreferences: { sendChannel: 'global', dmTarget: '' },
      },
    });
  }

  it('omits Party and Guild when solo and guildless, from tabs and the channel list', () => {
    const t = setup();
    expect(t.tab('party').hidden).toBe(true);
    expect(t.tab('guild').hidden).toBe(true);
    expect([...t.select().options].map(o => o.value)).toEqual(['global', 'zone', 'tile', 'dm']);
  });

  it('locks the channel on Party and Guild tabs', () => {
    const t = setup(withFullMembership());
    t.chat.open();
    t.tab('party').click();
    expect(t.select().disabled).toBe(true);
    expect(t.select().value).toBe('party');

    t.tab('all').click();
    expect(t.select().disabled).toBe(false);
  });

  it('falls back to All when the party is gone', () => {
    const t = setup(withFullMembership());
    t.chat.open();
    t.tab('party').click();
    t.pushState(stateWith());
    expect(t.tab('all').classList.contains('active')).toBe(true);
  });

  it('marks tabs with unread dots until they are viewed', () => {
    const t = setup(withFullMembership());
    t.chat.open();
    t.tab('guild').click();
    t.receive(message('m1', 'Mira', 'in party', { channelType: 'party' }));
    expect(t.tab('party').classList.contains('has-unread')).toBe(true);
    t.tab('party').click();
    expect(t.tab('party').classList.contains('has-unread')).toBe(false);
  });

  it('lists threads, opens one, and reports exactly that thread as in focus', () => {
    const t = setup();
    const focus = vi.spyOn(chatFocusTracker, 'setActiveThread');
    const clear = vi.spyOn(chatFocusTracker, 'clearActiveThread');
    t.chat.open();
    t.receive(message('m1', 'Mira', 'psst', { channelType: 'dm', channelId: 'me', timestamp: Date.now() + 1000 }));
    expect(t.tab('dm').classList.contains('has-unread')).toBe(true);

    t.tab('dm').click();
    expect(focus).not.toHaveBeenCalled();
    const row = document.querySelector('.chat-thread') as HTMLElement;
    expect(row.dataset.thread).toBe('Mira');

    row.click();
    expect(focus).toHaveBeenLastCalledWith('dm', 'Mira');
    expect(t.tab('dm').classList.contains('has-unread')).toBe(false);
    expect(t.texts()).toEqual(['psst']);

    t.tab('all').click();
    expect(clear).toHaveBeenCalled();
    expect(focus).toHaveBeenCalledOnce();
  });

  it('does not report a DM picked in the composer on All, since no thread is on screen', () => {
    const t = setup();
    const focus = vi.spyOn(chatFocusTracker, 'setActiveThread');
    t.chat.open();
    t.select().value = 'dm';
    t.select().dispatchEvent(new Event('change'));
    t.dmTarget().value = 'Mira';
    t.dmTarget().dispatchEvent(new Event('input'));
    expect(focus).not.toHaveBeenCalled();
  });

  it('clears focus on close', () => {
    const t = setup();
    const clear = vi.spyOn(chatFocusTracker, 'clearActiveThread');
    t.chat.openDm('Mira');
    t.chat.close();
    expect(clear).toHaveBeenCalled();
  });

  it('openDm opens on the thread with the canonical name', () => {
    const t = setup();
    const focus = vi.spyOn(chatFocusTracker, 'setActiveThread');
    t.chat.openDm('mira');
    expect(t.chat.isVisible()).toBe(true);
    expect(focus).toHaveBeenLastCalledWith('dm', 'Mira');
    expect(document.querySelector('.chat-thread-name')?.textContent).toBe('Mira');
  });

  it('a sender click in the thread bar passes a real anchor', () => {
    const t = setup();
    t.chat.openDm('Mira');
    const name = document.querySelector('.chat-thread-name') as HTMLElement;
    name.click();
    expect(t.onUserClick).toHaveBeenCalledWith('Mira', name);
  });

  it('a channel tag switches the send channel; a DM tag opens that thread', () => {
    const t = setup();
    const focus = vi.spyOn(chatFocusTracker, 'setActiveThread');
    t.chat.open();
    t.receive(message('m1', 'bob', 'z', { channelType: 'tile', channelId: '' }));
    (document.querySelector('.chat-msg-tag-btn') as HTMLElement).click();
    expect(t.select().value).toBe('tile');

    t.receive(message('m2', 'me', 'd', { channelType: 'dm', channelId: 'Mira' }));
    const tags = document.querySelectorAll<HTMLElement>('.chat-msg-tag-btn');
    tags[tags.length - 1].click();
    expect(focus).toHaveBeenLastCalledWith('dm', 'Mira');
  });
});

describe('ChatPopout sending', () => {
  function choose(t: ReturnType<typeof setup>, channel: string): void {
    t.select().value = channel;
    t.select().dispatchEvent(new Event('change'));
  }

  it('sends the raw zone key from the current room', () => {
    const t = setup();
    t.chat.open();
    choose(t, 'zone');
    t.input().value = 'hi zone';
    t.clickSend();
    expect(t.worldCache.getTileOn).toHaveBeenCalledWith('map1', 1, 2);
    expect(t.gameClient.sendChat).toHaveBeenCalledWith('zone', 'raw_zone', 'hi zone');
    expect(t.input().value).toBe('');
  });

  it('sends the guild id on the guild channel', () => {
    const inGuild = stateWith();
    inGuild.social!.guild = { id: 'guild-id', name: 'G', leaderUsername: 'x', createdAt: 0 };
    const t = setup(inGuild);
    t.chat.open();
    t.tab('guild').click();
    t.input().value = 'hi guild';
    t.clickSend();
    expect(t.gameClient.sendChat).toHaveBeenCalledWith('guild', 'guild-id', 'hi guild');
  });

  it('keeps the text and says why when the socket is down', () => {
    const t = setup();
    t.gameClient.sendChat.mockReturnValue(false);
    t.chat.open();
    t.input().value = 'lost?';
    t.clickSend();
    expect(t.input().value).toBe('lost?');
    expect(t.status().hidden).toBe(false);
    expect(t.status().textContent).toContain('Not connected');
  });

  it('asks for a name on an empty DM, keeping the text', () => {
    const t = setup();
    t.chat.open();
    choose(t, 'dm');
    t.input().value = 'hello?';
    t.clickSend();
    expect(t.gameClient.sendChat).not.toHaveBeenCalled();
    expect(t.input().value).toBe('hello?');
    expect(t.status().hidden).toBe(false);
  });

  it('restores the text when the server does not know the DM target', () => {
    const t = setup();
    t.chat.open();
    choose(t, 'dm');
    t.dmTarget().value = 'Nobody';
    t.input().value = 'are you there';
    t.clickSend();
    expect(t.input().value).toBe('');

    t.serverError('User not found');
    expect(t.input().value).toBe('are you there');
    expect(t.status().textContent).toContain('Nobody');
  });

  it('ignores unrelated server errors', () => {
    const t = setup();
    t.chat.open();
    t.input().value = 'hi';
    t.clickSend();
    t.serverError('Only owners and leaders can move');
    expect(t.input().value).toBe('');
    expect(t.status().hidden).toBe(true);
  });

  it('moves a new DM from the thread list into its thread', () => {
    const t = setup();
    t.chat.open();
    t.tab('dm').click();
    t.dmTarget().value = 'mira';
    t.input().value = 'hello';
    t.clickSend();
    expect(t.gameClient.sendChat).toHaveBeenCalledWith('dm', 'Mira', 'hello');
    expect(document.querySelector('.chat-thread-name')?.textContent).toBe('Mira');
  });

  it('restores the send channel from saved preferences once', () => {
    const saved = stateWith();
    saved.social!.chatPreferences = { sendChannel: 'dm', dmTarget: 'Mira' };
    const t = setup(saved);
    expect(t.select().value).toBe('dm');
    expect(t.dmTarget().value).toBe('Mira');

    choose(t, 'global');
    t.pushState(saved);
    expect(t.select().value).toBe('global');
  });

  it('falls back to Global when the saved channel is not available', () => {
    const saved = stateWith();
    saved.social!.chatPreferences = { sendChannel: 'guild', dmTarget: '' };
    const t = setup(saved);
    expect(t.select().value).toBe('global');
  });

  it('saves a channel change', () => {
    const t = setup();
    t.chat.open();
    choose(t, 'tile');
    expect(t.gameClient.sendSetChatPreferences).toHaveBeenCalledWith('tile', '');
  });

  it('keeps the composer node across messages and state pushes', () => {
    const t = setup();
    t.chat.open();
    const input = t.input();
    input.value = 'half typed';
    t.receive(message('m1', 'bob'));
    t.pushState(stateWith());
    expect(t.input()).toBe(input);
    expect(input.value).toBe('half typed');
  });

  it('limits the message length and asks for a send key', () => {
    const t = setup();
    expect(t.input().maxLength).toBe(500);
    expect(t.input().getAttribute('enterkeyhint')).toBe('send');
  });
});

describe('ChatPopout layouts', () => {
  it('is a sheet on phones, without focusing the input', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    expect(document.body.dataset.chatLayout).toBe('sheet');
    expect(document.activeElement).not.toBe(t.input());
  });

  it('is a column on desktop, focused, and open by default', () => {
    mockMedia({ column: true, fine: true });
    const t = setup();
    expect(t.chat.wasOpen()).toBe(true);
    t.chat.open();
    expect(document.body.dataset.chatLayout).toBe('column');
    expect(document.activeElement).toBe(t.input());
  });

  it('stays closed by default on phones', () => {
    mockMedia({ coarse: true, fine: false });
    expect(setup().chat.wasOpen()).toBe(false);
  });

  it('remembers being closed on desktop', () => {
    mockMedia({ column: true });
    const t = setup();
    t.chat.open();
    t.chat.close();
    expect(localStorage.getItem('chatPopoutOpen')).toBe('0');
    expect(t.chat.wasOpen()).toBe(false);
  });

  it('expands to full and persists it', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    (document.querySelector('.chat-popout-layout-btn') as HTMLElement).click();
    expect(document.body.dataset.chatLayout).toBe('full');
    expect(localStorage.getItem('chatPopoutMobileLayout')).toBe('full');
    expect(document.getElementById('chat-popout-root')!.style.zIndex).not.toBe('');
  });

  it('gives the docked sheet no z-index', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    expect(document.getElementById('chat-popout-root')!.style.zIndex).toBe('');
  });

  it('closes on Back or Escape through the stack, as a sheet', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    const onClose = vi.fn();
    t.chat.setOnClose(onClose);
    t.chat.open();
    expect(dismissTop()).toBe(true);
    expect(t.chat.isVisible()).toBe(false);
    expect(onClose).toHaveBeenCalledOnce();
    expect(document.body.dataset.chatOpen).toBeUndefined();
    expect(document.body.dataset.chatLayout).toBeUndefined();
  });

  it('leaves the desktop column off the dismiss stack', () => {
    mockMedia({ column: true });
    const t = setup();
    t.chat.open();
    expect(dismissTop()).toBe(false);
    expect(t.chat.isVisible()).toBe(true);
  });

  it('closes the filter popover before the sheet', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    const toggle = document.querySelector('.chat-filter-toggle') as HTMLElement;
    const pop = document.querySelector('.chat-filter-pop') as HTMLElement;
    toggle.click();
    expect(pop.hidden).toBe(false);
    dismissTop();
    expect(pop.hidden).toBe(true);
    expect(t.chat.isVisible()).toBe(true);
  });

  it('closes on a swipe down over the tab row', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    const row = document.querySelector('.chat-tabs-row')!;
    const pointer = (type: string, y: number) => row.dispatchEvent(
      new PointerEvent(type, { pointerId: 1, pointerType: 'touch', clientX: 10, clientY: y, bubbles: true }),
    );
    pointer('pointerdown', 100);
    pointer('pointerup', 160);
    expect(t.chat.isVisible()).toBe(false);
  });
});

describe('ChatPopout keyboard', () => {
  function typingSetup() {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    return { ...t, screen: document.getElementById('screen-container')! };
  }

  it('pins the screen and marks typing when the input takes focus on a touch device', () => {
    const t = typingSetup();
    Object.defineProperty(t.screen, 'offsetHeight', { configurable: true, value: 417 });
    t.input().focus();
    expect(document.body.dataset.chatTyping).toBe('1');
    expect(t.screen.style.height).toBe('417px');
    expect(document.getElementById('chat-popout-root')!.style.zIndex).not.toBe('');
  });

  it('does nothing on a fine pointer', () => {
    mockMedia({ fine: true });
    const t = setup();
    t.chat.open();
    t.input().focus();
    expect(document.body.dataset.chatTyping).toBeUndefined();
  });

  it('does not treat the channel select as typing', () => {
    const t = typingSetup();
    t.select().focus();
    expect(document.body.dataset.chatTyping).toBeUndefined();
  });

  it('restores on blur, after a tap has had time to land', () => {
    const t = typingSetup();
    t.input().focus();
    t.input().blur();
    expect(document.body.dataset.chatTyping).toBe('1');
    vi.advanceTimersByTime(200);
    expect(document.body.dataset.chatTyping).toBeUndefined();
    expect(t.screen.style.height).toBe('');
    expect(document.getElementById('chat-popout-root')!.style.zIndex).toBe('');
  });

  it('stays typing when focus moves within the composer', () => {
    const t = typingSetup();
    t.select().value = 'dm';
    t.select().dispatchEvent(new Event('change'));
    t.input().focus();
    t.dmTarget().focus();
    vi.advanceTimersByTime(200);
    expect(document.body.dataset.chatTyping).toBe('1');
  });

  it('restores when closed mid-typing', () => {
    const t = typingSetup();
    t.input().focus();
    t.chat.close();
    expect(document.body.dataset.chatTyping).toBeUndefined();
    expect(t.screen.style.height).toBe('');
  });

  it('send keeps focus on the input', () => {
    const t = typingSetup();
    t.input().focus();
    t.input().value = 'hello';
    const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    document.querySelector('.chat-popout-send')!.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    t.clickSend();
    expect(document.activeElement).toBe(t.input());
    expect(document.body.dataset.chatTyping).toBe('1');
  });

  it('notices the keyboard going away while the input keeps focus', () => {
    const viewport = new EventTarget() as EventTarget & { height: number };
    viewport.height = 800;
    vi.stubGlobal('visualViewport', viewport);
    const original = Object.getOwnPropertyDescriptor(window, 'visualViewport');
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
    try {
      const t = typingSetup();
      t.input().focus();
      viewport.height = 450;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.dataset.chatTyping).toBe('1');

      viewport.height = 800;
      viewport.dispatchEvent(new Event('resize'));
      expect(document.body.dataset.chatTyping).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
      if (original) Object.defineProperty(window, 'visualViewport', original);
      else delete (window as unknown as Record<string, unknown>).visualViewport;
    }
  });
});

describe('ChatPopout and overlays opened since', () => {
  function popup(onClose: () => void): HTMLElement {
    const el = document.createElement('div');
    document.body.appendChild(el);
    bringToFront(el, () => { release(el); onClose(); }, { holdFocus: false });
    return el;
  }

  it('leaving typing keeps a popup opened meanwhile above the sheet', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    t.input().focus();
    let popupOpen = true;
    popup(() => { popupOpen = false; });
    t.input().blur();
    vi.advanceTimersByTime(200);
    expect(document.body.dataset.chatTyping).toBeUndefined();

    expect(dismissTop()).toBe(true);
    expect(popupOpen).toBe(false);
    expect(t.chat.isVisible()).toBe(true);
    expect(dismissTop()).toBe(true);
    expect(t.chat.isVisible()).toBe(false);
  });

  it('leaving typing in the full layout stays under that popup', () => {
    mockMedia({ coarse: true, fine: false });
    localStorage.setItem('chatPopoutMobileLayout', 'full');
    const t = setup();
    t.chat.open();
    t.input().focus();
    let popupOpen = true;
    const el = popup(() => { popupOpen = false; });
    t.input().blur();
    vi.advanceTimersByTime(200);

    const root = document.getElementById('chat-popout-root')!;
    expect(parseInt(root.style.zIndex, 10)).toBeLessThan(parseInt(el.style.zIndex, 10));
    dismissTop();
    expect(popupOpen).toBe(false);
    expect(t.chat.isVisible()).toBe(true);
  });

  it('crossing from the column to the sheet keeps a popup on top', () => {
    const queries: { matches: boolean; change?: () => void }[] = [];
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => {
      const entry: { matches: boolean; change?: () => void } = { matches: query.includes('860px') };
      queries.push(entry);
      return {
        get matches() { return entry.matches; },
        addEventListener: (_: string, fn: () => void) => { entry.change = fn; },
        removeEventListener: () => {},
      } as unknown as MediaQueryList;
    });
    const t = setup();
    t.chat.open();
    expect(document.body.dataset.chatLayout).toBe('column');
    let popupOpen = true;
    popup(() => { popupOpen = false; });

    const column = queries.find(q => q.change)!;
    column.matches = false;
    column.change!();
    expect(document.body.dataset.chatLayout).toBe('sheet');

    dismissTop();
    expect(popupOpen).toBe(false);
    expect(t.chat.isVisible()).toBe(true);
    dismissTop();
    expect(t.chat.isVisible()).toBe(false);
  });

  it('expanding is the player acting on chat, so it comes up over the popup', () => {
    mockMedia({ coarse: true, fine: false });
    const t = setup();
    t.chat.open();
    const el = popup(() => {});
    (document.querySelector('.chat-popout-layout-btn') as HTMLElement).click();
    const root = document.getElementById('chat-popout-root')!;
    expect(parseInt(root.style.zIndex, 10)).toBeGreaterThan(parseInt(el.style.zIndex, 10));
  });
});

describe('ChatPopout state-driven view changes', () => {
  it('holds the rebuild while a row is pressed when the party goes away', () => {
    const t = setup(stateWith({ social: { ...stateWith().social, party: { id: 'p1', members: [{ username: 'me' }, { username: 'bob' }] } } }));
    t.chat.open();
    t.tab('party').click();
    t.receive(message('p1', 'bob', 'party line', { channelType: 'party', channelId: 'p1' }));
    const bob = t.senderBtn('bob')!;

    press(bob);
    t.pushState(stateWith());
    expect(t.tab('all').classList.contains('active')).toBe(true);
    expect(t.senderBtn('bob')).toBe(bob);

    bob.click();
    expect(t.onUserClick).toHaveBeenCalledWith('bob', bob);
    vi.advanceTimersByTime(0);
    expect(document.querySelector('.chat-popout-timeline')!.contains(bob)).toBe(false);
  });

  it('holds the rebuild while a row is pressed when a DM comes back rejected', () => {
    const t = setup();
    t.chat.openDm('Mira');
    t.receive(message('d1', 'Mira', 'hi', { channelType: 'dm', channelId: 'me' }));
    t.input().value = 'hello';
    t.clickSend();
    const mira = t.senderBtn('Mira')!;

    press(mira);
    t.serverError('User not found');
    expect(t.senderBtn('Mira')).toBe(mira);
    expect(t.status().hidden).toBe(false);

    mira.click();
    vi.advanceTimersByTime(0);
    expect((document.querySelector('.chat-threads') as HTMLElement).hidden).toBe(false);
  });
});

describe('ChatPopout rows held while scrolled up', () => {
  function scrolledUp() {
    const t = setup();
    t.chat.open();
    t.receive(message('m0', 'bob'));
    setLayoutBox(t.timeline(), { scrollHeight: 1000, clientHeight: 200, scrollTop: 100 });
    t.timeline().dispatchEvent(new Event('scroll'));
    return t;
  }

  it('stops holding messages past the cap, keeps counting, and rebuilds on return', () => {
    const t = scrolledUp();
    for (let i = 0; i < CHAT_ROW_CAP + 5; i++) t.receive(message(`m${i + 1}`, 'carol', `line ${i}`));

    expect((t.chat as unknown as { unrenderedRows: unknown[] }).unrenderedRows).toHaveLength(0);
    expect(t.pill().textContent).toBe('↓ 99+ new');
    expect(t.texts()).toHaveLength(1);

    t.pill().click();
    expect(t.pill().hidden).toBe(true);
    expect(t.texts()).toHaveLength(CHAT_ROW_CAP);
    expect(t.texts()[CHAT_ROW_CAP - 1]).toBe(`line ${CHAT_ROW_CAP + 4}`);
  });
});
