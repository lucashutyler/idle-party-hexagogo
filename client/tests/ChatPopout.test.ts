import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ChatMessage } from '@idle-party-rpg/shared';
import { ChatPopout } from '../src/ui/ChatPopout';
import type { GameClient } from '../src/network/GameClient';

type ChatListener = (msg: ChatMessage) => void;
type SyncListener = (messages: ChatMessage[], full: boolean) => void;

function message(id: string, sender: string, text = `hello from ${sender}`): ChatMessage {
  return { id, channelType: 'zone', channelId: 'z1', senderUsername: sender, text, timestamp: Date.now() };
}

function setup() {
  document.body.innerHTML = '<div id="chat-popout-root"></div>';
  const chatListeners = new Set<ChatListener>();
  const syncListeners = new Set<SyncListener>();

  const gameClient = {
    lastState: null,
    onChat: (l: ChatListener) => { chatListeners.add(l); return () => chatListeners.delete(l); },
    onSyncChat: (l: SyncListener) => { syncListeners.add(l); return () => syncListeners.delete(l); },
    subscribe: () => () => {},
    onResume: () => () => {},
    sendSyncChat: vi.fn(),
    sendChat: vi.fn(),
  } as unknown as GameClient;

  const chat = new ChatPopout(gameClient);
  const onUserClick = vi.fn();
  chat.setOnUserClick(onUserClick);

  const receive = (msg: ChatMessage) => { for (const l of chatListeners) l(msg); };
  const sync = (messages: ChatMessage[]) => { for (const l of syncListeners) l(messages, true); };
  const senderBtn = (user: string) => document.querySelector(`.chat-msg-sender-btn[data-user="${user}"]`) as HTMLButtonElement | null;
  const texts = () => [...document.querySelectorAll('.chat-msg-text')].map(el => el.textContent);

  return { chat, receive, sync, senderBtn, texts, onUserClick };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('ChatPopout timeline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

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

  it('keeps timeline nodes when a duplicate message arrives', () => {
    const t = setup();
    t.chat.open();
    t.receive(message('m1', 'bob'));
    const bob = t.senderBtn('bob');

    t.receive(message('m1', 'bob'));
    expect(t.senderBtn('bob')).toBe(bob);
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
});
