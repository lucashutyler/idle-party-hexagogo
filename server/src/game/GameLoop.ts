import { generateWorldMap } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager.js';
import type { GameStateStore } from './GameStateStore.js';
import { ContentStore } from './ContentStore.js';
import { GuildStore } from './social/GuildStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds

export class GameLoop {
  readonly playerManager: PlayerManager;
  readonly contentStore: ContentStore;
  private store: GameStateStore;
  private guildStore: GuildStore;
  private saveInterval?: ReturnType<typeof setInterval>;

  constructor(store: GameStateStore, accountStore: AccountStore) {
    this.contentStore = new ContentStore();
    const grid = generateWorldMap();
    this.guildStore = new GuildStore();
    this.playerManager = new PlayerManager(grid, this.guildStore, () => accountStore.getAllUsernames());
    this.store = store;

    console.log(`Game loop started. Map: ${grid.size} tiles`);
  }

  /**
   * Load all saved sessions and start periodic saving.
   * Call once after construction, before accepting connections.
   */
  async init(): Promise<void> {
    // Load custom content from JSON files (falls back to hardcoded defaults)
    await this.contentStore.load();
    await this.guildStore.load();

    const saves = await this.store.loadAll();
    if (saves.length > 0) {
      console.log(`[GameLoop] Found ${saves.length} save file(s): ${saves.map(s => s.username).join(', ')}`);
      this.playerManager.restoreFromSaveData(saves);
    } else {
      console.log('[GameLoop] No save files found — fresh start');
    }

    this.saveInterval = setInterval(() => {
      this.saveAll().catch(err => console.error('[GameLoop] Periodic save failed:', err));
    }, SAVE_INTERVAL_MS);

    console.log(`[GameLoop] Periodic save every ${SAVE_INTERVAL_MS / 1000}s`);
  }

  /**
   * Save all player state.
   */
  async saveAll(): Promise<void> {
    const count = this.playerManager.sessionCount;
    if (count > 0) {
      await this.playerManager.saveAll(this.store);
      console.log(`[GameLoop] Saved ${count} session(s)`);
    }
    await this.guildStore.save();
  }

  /**
   * Graceful shutdown: add log entries, save, stop timer.
   */
  async shutdown(): Promise<void> {
    if (this.saveInterval) {
      clearInterval(this.saveInterval);
      this.saveInterval = undefined;
    }

    this.playerManager.addShutdownLog();
    await this.saveAll();
    console.log('[GameLoop] State saved on shutdown');
  }
}
