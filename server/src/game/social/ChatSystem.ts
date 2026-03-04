import type { ChatMessage, ChatChannelType, BlockLevel } from '@idle-party-rpg/shared';

let messageIdCounter = 0;

function generateMessageId(): string {
  return `msg_${Date.now()}_${++messageIdCounter}`;
}

export interface ChatRecipient {
  username: string;
  send: (msg: ChatMessage) => void;
}

/**
 * ChatSystem handles message creation, routing, and block filtering.
 * Chat history is stored per-player in PlayerSession, not per-channel.
 */
export class ChatSystem {
  /**
   * Send a chat message. Returns the created message, or null if blocked/invalid.
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
    blockedBy: Record<string, Record<string, BlockLevel>>,
  ): ChatMessage | null {
    if (!text || text.length === 0 || text.length > 500) return null;

    const message: ChatMessage = {
      id: generateMessageId(),
      channelType,
      channelId,
      senderUsername,
      text,
      timestamp: Date.now(),
    };

    // Deliver to recipients (excluding blocked)
    for (const r of recipients) {
      const recipientBlocks = blockedBy[r.username];
      if (recipientBlocks) {
        const blockLevel = recipientBlocks[senderUsername];
        if (blockLevel === 'all') continue;
        if (blockLevel === 'dm' && channelType === 'dm') continue;
      }
      r.send(message);
    }

    return message;
  }
}
