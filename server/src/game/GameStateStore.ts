import type { CombatLogEntry, BlockLevel, ChatMessage, FriendRequest, SkillLoadout, MailboxEntry } from '@idle-party-rpg/shared';

/**
 * Serializable snapshot of a player's persistent state.
 */
export interface PlayerSaveData {
  username: string;
  battleCount: number;
  combatLog: CombatLogEntry[];
  unlockedKeys: string[];
  position: { col: number; row: number };
  target: { col: number; row: number } | null;
  movementQueue: { col: number; row: number }[];
  character?: {
    className: string;
    level: number;
    xp: number;
    gold?: number;
    inventory?: Record<string, number>;
    equipment?: Record<string, string | null>;
    skillLoadout?: SkillLoadout;
    skillPoints?: number;
    // Legacy fields (ignored on load, kept for backward compat with old saves)
    stats?: Record<string, number>;
    priorityStat?: string | null;
  };
  friends?: string[];
  outgoingFriendRequests?: FriendRequest[];
  blockedUsers?: Record<string, BlockLevel>;
  guildId?: string | null;
  partyId?: string | null;
  partyRole?: 'owner' | 'leader' | 'member';
  partyGridPosition?: number;
  chatHistory?: ChatMessage[];
  chatSendChannel?: string;
  chatDmTarget?: string;
  /** Pending gift entries awaiting accept/deny in the player's mailbox. */
  mailbox?: MailboxEntry[];
}

/**
 * Abstract interface for persisting game state.
 * Swap implementations (JSON files → SQLite → Postgres) without changing game code.
 */
export interface GameStateStore {
  /** Save a single player's state. */
  save(data: PlayerSaveData): Promise<void>;

  /** Save multiple players at once (batch). */
  saveAll(data: PlayerSaveData[]): Promise<void>;

  /** Load a single player's state, or null if not found. */
  load(username: string): Promise<PlayerSaveData | null>;

  /** Load all saved player states. */
  loadAll(): Promise<PlayerSaveData[]>;

  /** Delete a player's save data. */
  delete(username: string): Promise<void>;
}
