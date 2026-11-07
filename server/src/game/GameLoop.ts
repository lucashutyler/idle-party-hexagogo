import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { GAME_VERSION, DEV_SEED_MARKER_ZONE_ID } from '@idle-party-rpg/shared';
import { PlayerManager } from './PlayerManager.js';
import { WorldGrids } from './WorldGrids.js';
import type { GameStateStore } from './GameStateStore.js';
import { GuildStore } from './social/GuildStore.js';
import { TradeStore } from './social/TradeStore.js';
import { JsonMailboxStore } from './social/MailboxStore.js';
import type { MailboxStore } from './social/MailboxStore.js';
import { ContentStore } from './ContentStore.js';
import { VersionStore } from './VersionStore.js';
import { ForecastService } from './ForecastService.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { QuestDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';
import { seedDevContent, seedDevPlayers } from './DevSeed.js';

const SAVE_INTERVAL_MS = 30_000; // Save every 30 seconds
const CRAFT_TICK_MS = 1000;       // Check craft completions every 1s
const VERSION_FILE = path.resolve('data', 'game-version.txt');
const FORECAST_LOG_EVERY_MS = 60_000;

/**
 * Carry live room GUIDs onto a snapshot about to be deployed, keyed on
 * (mapId, col, row) — a position-only key hands one GUID to two rooms —
 * and repoint the snapshot's transitions and visit objectives at the new ids.
 * See docs/architecture/content.md.
 */
export function preserveTileGuids(
  liveTiles: readonly WorldTileDefinition[],
  snapshotTiles: WorldTileDefinition[],
  quests: QuestDefinition[] = [],
): void {
  const key = (t: WorldTileDefinition) => `${t.mapId}:${t.col},${t.row}`;

  const liveGuidByPos = new Map<string, string>();
  for (const t of liveTiles) {
    if (t.id) liveGuidByPos.set(key(t), t.id);
  }

  const assignedIds = new Set<string>();
  const keptIds = new Set<string>();
  const renamed = new Map<string, string>();
  for (const tile of snapshotTiles) {
    const before = tile.id;
    const liveGuid = liveGuidByPos.get(key(tile));
    if (liveGuid && !assignedIds.has(liveGuid)) {
      tile.id = liveGuid;
    } else if (!tile.id || assignedIds.has(tile.id)) {
      tile.id = crypto.randomUUID();
    }
    assignedIds.add(tile.id);
    if (before === tile.id) keptIds.add(before);
    else if (before && !renamed.has(before)) renamed.set(before, tile.id);
  }

  // A duplicate id that one room kept unchanged still names that room.
  for (const id of keptIds) renamed.delete(id);
  if (renamed.size === 0) return;

  const remap = (id: string) => renamed.get(id) ?? id;
  for (const tile of snapshotTiles) {
    for (const link of tile.transitions ?? []) link.tileId = remap(link.tileId);
  }
  for (const quest of quests) {
    for (const objective of quest.objectives) {
      if (objective.kind === 'visit') objective.tileId = remap(objective.tileId);
    }
  }
}

export class GameLoop {
  readonly playerManager!: PlayerManager;
  readonly contentStore: ContentStore;
  readonly versionStore: VersionStore;
  readonly forecaster: ForecastService;
  private store: GameStateStore;
  private guildStore: GuildStore;
  private tradeStore: TradeStore;
  private mailboxStore: MailboxStore;
  private saveInterval?: ReturnType<typeof setInterval>;
  private craftTickInterval?: ReturnType<typeof setInterval>;
  private grids!: WorldGrids;

  constructor(store: GameStateStore) {
    this.contentStore = new ContentStore();
    this.versionStore = new VersionStore();
    this.guildStore = new GuildStore();
    this.tradeStore = new TradeStore();
    this.forecaster = new ForecastService({ logEveryMs: FORECAST_LOG_EVERY_MS });
    this.mailboxStore = new JsonMailboxStore();
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
    // so the map has real scale to work against. Idempotent — skipped once
    // the dev raid dungeon exists; an older dev world is upgraded once.
    // (Version-snapshot sync happens below.)
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

    // Build per-map hex grids from content store world data
    t = performance.now();
    this.grids = new WorldGrids(this.contentStore);
    console.log(`[Startup] World grids built (${this.grids.totalSize()} tiles across ${this.grids.mapIds().length} map(s)) in ${(performance.now() - t).toFixed(1)}ms`);

    // Loaded before the player manager exists, so a shutdown signal can't save an empty set over the file.
    t = performance.now();
    const savedMailboxes = await this.mailboxStore.load();
    console.log(`[Startup] MailboxStore loaded in ${(performance.now() - t).toFixed(1)}ms`);

    // Create player manager now that grids + content are ready
    (this as { playerManager: PlayerManager }).playerManager = new PlayerManager(
      this.grids,
      this.contentStore,
      this.guildStore,
      accountStore,
      this.store,
      this.mailboxStore,
    );
    this.playerManager.partyBattles.setForecaster(this.forecaster);

    this.playerManager.mailboxes.restore(savedMailboxes);

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

    // Entries taken in from old saves must be in the store before any player save drops them.
    await this.playerManager.saveMailboxes();

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
    await this.playerManager.saveAll(this.store);
    if (count > 0) console.log(`[GameLoop] Saved ${count} session(s)`);
    await this.guildStore.save();
    await this.tradeStore.save(this.playerManager.trades.getAllTrades());
    await this.contentStore.persist();
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
    this.forecaster.stop();
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

    // 1. Load snapshot and preserve live GUIDs where tiles match by (map, col, row).
    //    This keeps player unlock data valid after deploying an old snapshot.
    const snapshot = await this.versionStore.loadSnapshot(versionId);
    const liveWorld = this.contentStore.getWorld();
    preserveTileGuids(liveWorld.tiles, snapshot.world.tiles, snapshot.quests ?? []);
    await this.contentStore.replaceAll(snapshot);

    // 2. Rebuild grid, refresh party tiles, relocate displaced parties
    const relocated = this.rebuildGridAndRelocate();

    // 2b. Reconcile every session's skill loadout against the new content —
    //     all sessions, not just online ones (idle sessions keep fighting).
    for (const session of this.playerManager.getAllSessions()) {
      session.autoUnlockSkills();
    }

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
    this.grids.rebuild();
    this.playerManager.partyBattles.refreshAllPartyTiles(this.grids);
    const relocated = this.playerManager.relocateDisplacedParties(this.grids, this.contentStore);
    this.playerManager.partyBattles.endOrphanedRuns();
    return relocated;
  }
}
