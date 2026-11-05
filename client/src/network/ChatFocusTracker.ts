import type { GameClient } from './GameClient';
import type { ChatChannelType } from '@idle-party-rpg/shared';

/**
 * Tells the server which chat thread the player is looking at, combined with window focus,
 * so it can suppress DM notifications for that thread. A hidden or blurred tab reports none.
 */
class ChatFocusTracker {
  private gameClient: GameClient | null = null;
  private stopWatchingConnection: (() => void) | null = null;
  private windowWatched = false;
  private currentThread: { channelType: ChatChannelType; channelId: string } | null = null;
  private windowFocused = document.hasFocus();
  private lastSent: { channelType: string | null; channelId: string | null } = { channelType: null, channelId: null };

  init(gameClient: GameClient): void {
    this.gameClient = gameClient;
    this.stopWatchingConnection?.();
    // The server keeps the last value across a dropped socket, so a new socket always gets the current one.
    this.stopWatchingConnection = gameClient.onConnection((connected) => {
      if (connected) this.report(true);
    });
    if (this.windowWatched) return;
    this.windowWatched = true;
    window.addEventListener('focus', () => {
      this.windowFocused = true;
      this.report();
    });
    window.addEventListener('blur', () => {
      this.windowFocused = false;
      this.report();
    });
    document.addEventListener('visibilitychange', () => {
      this.windowFocused = document.visibilityState === 'visible' && document.hasFocus();
      this.report();
    });
  }

  setActiveThread(channelType: ChatChannelType, channelId: string): void {
    this.currentThread = { channelType, channelId };
    this.report();
  }

  clearActiveThread(): void {
    this.currentThread = null;
    this.report();
  }

  private report(force = false): void {
    if (!this.gameClient) return;
    const effective = this.windowFocused && this.currentThread ? this.currentThread : null;
    const channelType = effective?.channelType ?? null;
    const channelId = effective?.channelId ?? null;
    if (!force && channelType === this.lastSent.channelType && channelId === this.lastSent.channelId) return;
    this.lastSent = { channelType, channelId };
    this.gameClient.sendSetChatFocus(channelType, channelId);
  }
}

export const chatFocusTracker = new ChatFocusTracker();
