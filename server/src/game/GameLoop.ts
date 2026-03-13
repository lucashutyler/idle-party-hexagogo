import { HexGrid, HexTile, offsetToCube } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager.js';
import type { GameStateStore } from './GameStateStore.js';
import { GuildStore } from './social/GuildStore.js';
import { ContentStore } from './ContentStore.js';
import { VersionStore } from './VersionStore.js';
import type { AccountStore } from '../auth/AccountStore.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds

export class GameLoop {
  readonly playerManager!: PlayerManager;
  readonly contentStore: ContentStore;
  readonly versionStore: VersionStore;
  private store: GameStateStore;
  private guildStore: GuildStore;
  private saveInterval?: ReturnType<typeof setInterval>;
  private grid!: HexGrid;

  constructor(store: GameStateStore) {
    this.contentStore = new ContentStore();
    this.versionStore = new VersionStore();
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
    await this.versionStore.load();

    // Ensure at least one active version exists (first boot / fresh install)
    if (!this.versionStore.getActiveVersionId()) {
      const snapshot = this.contentStore.toSnapshot();
      const version = await this.versionStore.createDraft('1', null, snapshot);
      await this.versionStore.publish(version.id);
      await this.versionStore.setActive(version.id);
      console.log(`[GameLoop] Created initial version "1" (${version.id})`);
    }

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
    await this.versionStore.save();
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
   * Deploy a published version: replace live content, rebuild grid, relocate displaced parties.
   */
  async deployVersion(versionId: string): Promise<{ success: boolean; error?: string; relocated?: number }> {
    const version = this.versionStore.get(versionId);
    if (!version) return { success: false, error: 'Version not found.' };
    if (version.status !== 'published') return { success: false, error: 'Only published versions can be deployed.' };

    // 1. Load snapshot and replace live content
    const snapshot = await this.versionStore.loadSnapshot(versionId);
    await this.contentStore.replaceAll(snapshot);

    // 2. Rebuild grid, refresh party tiles, relocate displaced parties
    const relocated = this.rebuildGridAndRelocate();

    // 3. Set as active version
    await this.versionStore.setActive(versionId);

    // 4. Save all state
    await this.saveAll();

    // 5. Notify all connected clients that the world has changed
    this.playerManager.broadcastToAll({ type: 'world_update' });

    // 6. Send updated state to all connected players (zone/position may have changed)
    for (const username of this.playerManager.getOnlinePlayers()) {
      this.playerManager.sendStateToPlayer(username);
    }

    console.log(`[GameLoop] Deployed version "${version.name}" (${versionId}), relocated ${relocated} parties`);
    return { success: true, relocated };
  }

  /**
   * Rebuild the grid and relocate any parties on unreachable tiles.
   * Used after any content change (deploy or direct tile edit).
   * Returns the number of parties relocated.
   */
  rebuildGridAndRelocate(): number {
    this.rebuildGrid();
    this.playerManager.partyBattles.refreshAllPartyTiles(this.grid);
    return this.playerManager.relocateDisplacedParties(this.grid, this.contentStore);
  }

  /**
   * Rebuild the HexGrid in-place from current content store data.
   * All existing references (PlayerManager, PlayerSession, etc.) remain valid
   * because the same grid object is reused.
   */
  rebuildGrid(): void {
    this.grid.clear();
    const world = this.contentStore.getWorld();
    for (const tileDef of world.tiles) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id);
      this.grid.addTile(tile);
    }
    console.log(`[GameLoop] Grid rebuilt: ${this.grid.size} tiles`);
  }

  /**
   * Build a HexGrid from the content store's world data.
   */
  private buildGridFromContent(): HexGrid {
    const grid = new HexGrid();
    const world = this.contentStore.getWorld();

    for (const tileDef of world.tiles) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id);
      grid.addTile(tile);
    }

    return grid;
  }
}
