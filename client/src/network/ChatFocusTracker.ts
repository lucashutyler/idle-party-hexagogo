import type { GameClient } from './GameClient';
import type { ChatChannelType } from '@idle-party-rpg/shared';

/**
 * Tracks which chat thread (if any) the player is actively looking at, across
 * both chat surfaces (SocialScreen's embedded chat tab and the global
 * ChatPopout), combined with window focus — and reports the effective result
 * to the server so it can suppress DM notifications for that thread.
 *
 * Either UI surface calls setActiveThread()/clearActiveThread() as its own
 * visibility changes; window blur immediately reports "not focused" so a
 * backgrounded tab still gets notified even if a thread is nominally open.
 */
class ChatFocusTracker {
  private gameClient: GameClient | null = null;
  private currentThread: { channelType: ChatChannelType; channelId: string } | null = null;
  private windowFocused = document.hasFocus();
  private lastSent: { channelType: string | null; channelId: string | null } = { channelType: null, channelId: null };

  init(gameClient: GameClient): void {
    this.gameClient = gameClient;
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

  private report(): void {
    if (!this.gameClient) return;
    const effective = this.windowFocused && this.currentThread ? this.currentThread : null;
    const channelType = effective?.channelType ?? null;
    const channelId = effective?.channelId ?? null;
    if (channelType === this.lastSent.channelType && channelId === this.lastSent.channelId) return;
    this.lastSent = { channelType, channelId };
    this.gameClient.sendSetChatFocus(channelType, channelId);
  }
}

export const chatFocusTracker = new ChatFocusTracker();
