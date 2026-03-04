import fs from 'fs/promises';
import path from 'path';
import type { ChatMessage, ChatChannelType } from '@idle-party-rpg/shared';

const CHAT_DIR = path.resolve('data', 'chat');
const MAX_HISTORY_PER_CHANNEL = 200;

/**
 * Persists chat history per channel to data/chat/<channelKey>.json.
 * Channel key format: `<type>:<id>` e.g. `zone:friendly_forest`, `dm:alice_bob`.
 */
export class ChatStore {
  private channels = new Map<string, ChatMessage[]>();

  static channelKey(type: ChatChannelType, id: string): string {
    return `${type}:${id}`;
  }

  /** Normalized DM channel key (sorted alphabetically). */
  static dmKey(a: string, b: string): string {
    const sorted = [a, b].sort();
    return `dm:${sorted[0]}_${sorted[1]}`;
  }

  async load(): Promise<void> {
    try {
      await fs.mkdir(CHAT_DIR, { recursive: true });
      const files = await fs.readdir(CHAT_DIR);
      for (const file of files) {
        if (!file.endsWith('.json')) continue;
        try {
          const raw = await fs.readFile(path.join(CHAT_DIR, file), 'utf-8');
          const messages: ChatMessage[] = JSON.parse(raw);
          const key = file.replace('.json', '').replace(/_/g, ':');
          this.channels.set(key, messages);
        } catch {
          // Corrupt file — skip
        }
      }
      console.log(`[ChatStore] Loaded ${this.channels.size} chat channels`);
    } catch {
      // Dir doesn't exist yet
    }
  }

  async save(): Promise<void> {
    await fs.mkdir(CHAT_DIR, { recursive: true });
    for (const [key, messages] of this.channels) {
      const filename = key.replace(/:/g, '_') + '.json';
      await fs.writeFile(path.join(CHAT_DIR, filename), JSON.stringify(messages));
    }
  }

  addMessage(channelKey: string, message: ChatMessage): void {
    let messages = this.channels.get(channelKey);
    if (!messages) {
      messages = [];
      this.channels.set(channelKey, messages);
    }
    messages.push(message);
    if (messages.length > MAX_HISTORY_PER_CHANNEL) {
      messages.splice(0, messages.length - MAX_HISTORY_PER_CHANNEL);
    }
  }

  getHistory(channelKey: string, limit = 50): ChatMessage[] {
    const messages = this.channels.get(channelKey);
    if (!messages) return [];
    return messages.slice(-limit);
  }
}
