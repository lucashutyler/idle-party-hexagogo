import { randomUUID } from 'crypto';
import type { ChatMessage, ChatChannelType } from '@idle-party-rpg/shared';

export interface ChatRecipient {
  username: string;
  send: (msg: ChatMessage) => void;
}

/**
 * ChatSystem handles message creation and routing.
 * All messages are delivered to all recipients — filtering is client-side.
 */
export class ChatSystem {
  /**
   * Send a chat message. Returns the created message, or null if invalid.
   * `recipients` is the list of players who should receive this message.
   * Each recipient's `send` callback is responsible for storing the message
   * in their personal history (via PlayerManager.sendChatToPlayer).
   */
  sendMessage(
    senderUsername: string,
    channelType: ChatChannelType,
    channelId: string,
    text: string,
    recipients: ChatRecipient[],
  ): ChatMessage | null {
    if (!text || text.length === 0 || text.length > 500) return null;

    const message: ChatMessage = {
      id: randomUUID(),
      channelType,
      channelId,
      senderUsername,
      text,
      timestamp: Date.now(),
    };

    // Deliver to all recipients unconditionally — filtering is client-side
    for (const r of recipients) {
      r.send(message);
    }

    return message;
  }
}
