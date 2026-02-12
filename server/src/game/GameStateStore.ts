import type { CombatLogEntry } from '@idle-party-rpg/shared';

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
