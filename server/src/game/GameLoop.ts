import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { HexGrid, HexTile, offsetToCube, GAME_VERSION, DEV_SEED_MARKER_ZONE_ID } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager.js';
import type { GameStateStore } from './GameStateStore.js';
import { GuildStore } from './social/GuildStore.js';
import { TradeStore } from './social/TradeStore.js';
import { ContentStore } from './ContentStore.js';
import { VersionStore } from './VersionStore.js';
import type { AccountStore } from '../auth/AccountStore.js';
import { seedDevContent, seedDevPlayers } from './DevSeed.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds
const CRAFT_TICK_MS = 1000;       // Check craft completions every 1s
const VERSION_FILE = path.resolve('data', 'game-version.txt');

export class GameLoop {
  readonly playerManager!: PlayerManager;
  readonly contentStore: ContentStore;
  readonly versionStore: VersionStore;
  private store: GameStateStore;
  private guildStore: GuildStore;
  private tradeStore: TradeStore;
  private saveInterval?: ReturnType<typeof setInterval>;
  private craftTickInterval?: ReturnType<typeof setInterval>;
  private grid!: HexGrid;

  constructor(store: GameStateStore) {
    this.contentStore = new ContentStore();
    this.versionStore = new VersionStore();
    this.guildStore = new GuildStore();
    this.tradeStore = new TradeStore();
    this.store = store;
  }

  /**
   * Load content, build grid, init player manager, restore saves, start periodic saving.
   * Call once after construction, before accepting connections.
   */
  async init(accountStore: AccountStore): Promise<void> {
    let t: number;

    // Load game content from data/*.json (seeds defaults if files missing)
    t = performance.now();
    await this.contentStore.load();
    console.log(`[Startup] ContentStore loaded in ${(performance.now() - t).toFixed(1)}ms`);

    // Dev-only: inject 20 procedurally-generated zones and ~1000 rooms
    // so the map has real scale to work against. Idempotent — re-runs
    // skip the merge if the marker zone is already present in the live
    // ContentStore. (Version-snapshot sync happens below.)
    const isDev = process.env.NODE_ENV !== 'production';
    let devContentAdded = false;
    if (isDev) {
      devContentAdded = await seedDevContent(this.contentStore);
    }

    t = performance.now();
    await this.versionStore.load();
    console.log(`[Startup] VersionStore loaded in ${(performance.now() - t).toFixed(1)}ms`);

    // Ensure at least one active version exists (first boot / fresh install)
    const activeId = this.versionStore.getActiveVersionId();
    if (!activeId) {
      const snapshot = this.contentStore.toSnapshot();
      const version = await this.versionStore.createDraft('1', null, snapshot);
      await this.versionStore.publish(version.id);
      await this.versionStore.setActive(version.id);
      console.log(`[GameLoop] Created initial version "1" (${version.id})`);
    } else if (isDev) {
      // In dev, keep the active version's snapshot in sync with the
      // live ContentStore whenever the dev seed has been applied.
      // Catches two cases:
      //   (a) the seed just ran this boot (devContentAdded === true)
      //   (b) the seed ran on a prior boot but the active version
      //       was created before the dev seed code existed, so its
      //       snapshot still doesn't contain the dev marker zone
      // Without this, an admin deploy of the active version would
      // play back the stale snapshot and wipe the dev content.
      let needsSync = devContentAdded;
      if (!needsSync) {
        try {
          const snap = await this.versionStore.loadSnapshot(activeId);
          needsSync = !snap.zones.some(z => z.id === DEV_SEED_MARKER_ZONE_ID);
        } catch (err) {
          console.warn('[GameLoop] Could not load active version snapshot for sync check:', err);
        }
      }
      if (needsSync) {
        await this.versionStore.saveSnapshot(activeId, this.contentStore.toSnapshot());
        console.log(`[GameLoop] Synced active version snapshot with dev seed content (${activeId})`);
      }
    }

    // Build hex grid from content store world data
    t = performance.now();
    this.grid = this.buildGridFromContent();
    console.log(`[Startup] HexGrid built (${this.grid.size} tiles) in ${(performance.now() - t).toFixed(1)}ms`);

    // Create player manager now that grid + content are ready
    (this as { playerManager: PlayerManager }).playerManager = new PlayerManager(
      this.grid,
      this.contentStore,
      this.guildStore,
      accountStore,
      this.store,
    );

    t = performance.now();
    await this.guildStore.load();
    console.log(`[Startup] GuildStore loaded in ${(performance.now() - t).toFixed(1)}ms`);

    t = performance.now();
    const savedTrades = await this.tradeStore.load();
    this.playerManager.trades.restoreFromSaveData(savedTrades);
    console.log(`[Startup] TradeStore loaded (${savedTrades.length} trades) in ${(performance.now() - t).toFixed(1)}ms`);

    t = performance.now();
    const saves = await this.store.loadAll();
    console.log(`[Startup] Save files loaded (${saves.length} players) in ${(performance.now() - t).toFixed(1)}ms`);

    // Dev-only: drop 100 bot saves on disk if they don't exist yet,
    // then fold them into the saves array so restoreFromSaveData
    // builds the in-memory sessions (= they show up as other players
    // on the map).
    if (process.env.NODE_ENV !== 'production') {
      const newBots = await seedDevPlayers(this.store, accountStore, this.contentStore.getWorld().tiles);
      if (newBots.length > 0) saves.push(...newBots);
    }

    if (saves.length > 0) {
      t = performance.now();
      this.playerManager.restoreFromSaveData(saves);
      console.log(`[Startup] Sessions restored in ${(performance.now() - t).toFixed(1)}ms`);
    } else {
      console.log('[GameLoop] No save files found — fresh start');
    }

    // Announce new version to all restored sessions if GAME_VERSION changed
    let lastVersion = '';
    try { lastVersion = (await fs.readFile(VERSION_FILE, 'utf-8')).trim(); } catch { /* first boot */ }
    if (lastVersion !== GAME_VERSION) {
      this.playerManager.broadcastServerMessage(`Update ${GAME_VERSION}! Check Settings > Patch Notes for details.`);
      await fs.writeFile(VERSION_FILE, GAME_VERSION, 'utf-8');
      console.log(`[GameLoop] Version updated: ${lastVersion || '(none)'} → ${GAME_VERSION}`);
    }

    this.saveInterval = setInterval(() => {
      this.saveAll().catch(err => console.error('[GameLoop] Periodic save failed:', err));
    }, SAVE_INTERVAL_MS);

    this.craftTickInterval = setInterval(() => {
      try { this.playerManager.tickAllCrafting(); }
      catch (err) { console.error('[GameLoop] Craft tick failed:', err); }
    }, CRAFT_TICK_MS);

    console.log(`[GameLoop] Periodic save every ${SAVE_INTERVAL_MS / 1000}s, craft tick every ${CRAFT_TICK_MS / 1000}s`);
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
    await this.tradeStore.save(this.playerManager.trades.getAllTrades());
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
    if (this.craftTickInterval) {
      clearInterval(this.craftTickInterval);
      this.craftTickInterval = undefined;
    }
    // Drain craft completions one last time so jobs that finished between ticks aren't lost.
    this.playerManager.tickAllCrafting();

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

    // 1. Load snapshot and preserve live GUIDs where tiles match by (col,row).
    //    This keeps player unlock data valid after deploying an old snapshot.
    const snapshot = await this.versionStore.loadSnapshot(versionId);
    const liveWorld = this.contentStore.getWorld();
    const liveGuidByPos = new Map<string, string>();
    for (const t of liveWorld.tiles) {
      if (t.id) liveGuidByPos.set(`${t.col},${t.row}`, t.id);
    }
    for (const tile of snapshot.world.tiles) {
      const liveGuid = liveGuidByPos.get(`${tile.col},${tile.row}`);
      if (liveGuid) {
        tile.id = liveGuid; // Preserve live GUID so player unlocks stay valid
      } else if (!tile.id) {
        tile.id = crypto.randomUUID(); // New tile — fresh GUID
      }
    }
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
      const tileTypeDef = this.contentStore.getTileType(tileDef.type);
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef);
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
      const tileTypeDef = this.contentStore.getTileType(tileDef.type);
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef);
      grid.addTile(tile);
    }

    return grid;
  }
}
