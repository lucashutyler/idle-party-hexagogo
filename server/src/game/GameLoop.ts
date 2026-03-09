import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager.js';
import type { GameStateStore } from './GameStateStore.js';
import { GuildStore } from './social/GuildStore.js';
import { ContentStore } from './ContentStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds

export class GameLoop {
  readonly playerManager!: PlayerManager;
  readonly contentStore: ContentStore;
  private store: GameStateStore;
  private guildStore: GuildStore;
  private saveInterval?: ReturnType<typeof setInterval>;
  private grid!: HexGrid;

  constructor(store: GameStateStore) {
    this.contentStore = new ContentStore();
    this.guildStore = new GuildStore();
    this.store = store;
  }

  /**
   * Load content, build grid, init player manager, restore saves, start periodic saving.
   * Call once after construction, before accepting connections.
   */
  async init(accountStore: AccountStore): Promise<void> {
    // Load game content from data/*.json (seeds defaults if files missing)
    await this.contentStore.load();

    // Build hex grid from content store world data
    this.grid = this.buildGridFromContent();

    // Create player manager now that grid + content are ready
    (this as { playerManager: PlayerManager }).playerManager = new PlayerManager(
      this.grid,
      this.contentStore,
      this.guildStore,
      () => accountStore.getAllUsernames(),
    );

    console.log(`[GameLoop] Map: ${this.grid.size} tiles`);

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
    await this.contentStore.save();
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

  /**
   * Build a HexGrid from the content store's world data.
   */
  private buildGridFromContent(): HexGrid {
    const grid = new HexGrid();
    const world = this.contentStore.getWorld();

    for (const tileDef of world.tiles) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tile = new HexTile(coord, tileDef.type, tileDef.zone);
      grid.addTile(tile);
    }

    return grid;
  }
}
