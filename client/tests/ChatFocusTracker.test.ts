import { describe, expect, it, vi } from 'vitest';
import { chatFocusTracker } from '../src/network/ChatFocusTracker';
import type { GameClient } from '../src/network/GameClient';

function client() {
  const connectionListeners = new Set<(connected: boolean) => void>();
  const sendSetChatFocus = vi.fn();
  const gameClient = {
    sendSetChatFocus,
    onConnection: (l: (connected: boolean) => void) => {
      connectionListeners.add(l);
      return () => connectionListeners.delete(l);
    },
  } as unknown as GameClient;
  const reconnect = () => { for (const l of connectionListeners) l(true); };
  return { gameClient, sendSetChatFocus, reconnect, connectionListeners };
}

describe('ChatFocusTracker', () => {
  it('reports the thread, not again when unchanged, and none while the window is blurred', () => {
    const c = client();
    chatFocusTracker.init(c.gameClient);
    window.dispatchEvent(new Event('focus'));

    chatFocusTracker.setActiveThread('dm', 'Mira');
    chatFocusTracker.setActiveThread('dm', 'Mira');
    expect(c.sendSetChatFocus).toHaveBeenCalledTimes(1);
    expect(c.sendSetChatFocus).toHaveBeenLastCalledWith('dm', 'Mira');

    window.dispatchEvent(new Event('blur'));
    expect(c.sendSetChatFocus).toHaveBeenLastCalledWith(null, null);

    window.dispatchEvent(new Event('focus'));
    chatFocusTracker.clearActiveThread();
    expect(c.sendSetChatFocus).toHaveBeenLastCalledWith(null, null);
  });

  it('sends the current value again on a new socket, even if it has not changed', () => {
    const c = client();
    chatFocusTracker.init(c.gameClient);
    window.dispatchEvent(new Event('focus'));
    chatFocusTracker.setActiveThread('dm', 'Mira');
    c.sendSetChatFocus.mockClear();

    c.reconnect();
    expect(c.sendSetChatFocus).toHaveBeenCalledOnce();
    expect(c.sendSetChatFocus).toHaveBeenCalledWith('dm', 'Mira');

    chatFocusTracker.clearActiveThread();
    c.sendSetChatFocus.mockClear();
    c.reconnect();
    expect(c.sendSetChatFocus).toHaveBeenCalledWith(null, null);
  });

  it('follows only the latest client', () => {
    const first = client();
    const second = client();
    chatFocusTracker.init(first.gameClient);
    chatFocusTracker.init(second.gameClient);
    expect(first.connectionListeners.size).toBe(0);
    expect(second.connectionListeners.size).toBe(1);
  });
});
