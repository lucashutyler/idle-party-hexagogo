import { Router } from 'express';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { ContentStore } from '../game/ContentStore.js';
import type { VersionStore } from '../game/VersionStore.js';
import { adminMiddleware } from './adminMiddleware.js';

interface AdminRouteOptions {
  playerManager: () => PlayerManager;
  accountStore: AccountStore;
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
  rebuildGrid: () => number;
  deployVersion: (versionId: string) => Promise<{ success: boolean; error?: string; relocated?: number }>;
}

export function createAdminRoutes({ playerManager: getPlayerManager, accountStore, contentStore: getContentStore, versionStore: getVersionStore, rebuildGrid, deployVersion }: AdminRouteOptions): Router {
  const router = Router();
  router.use(adminMiddleware);

  router.get('/overview', (_req, res) => {
    const pm = getPlayerManager();
    const onlinePlayers = pm.getOnlinePlayers();
    res.json({
      onlinePlayers: onlinePlayers.length,
      totalSessions: pm.sessionCount,
      totalConnections: pm.connectionCount,
      totalAccounts: accountStore.getAllAccounts().length,
      uptime: Math.floor(process.uptime()),
    });
  });

  router.get('/accounts', (_req, res) => {
    const pm = getPlayerManager();
    const onlineSet = new Set(pm.getOnlinePlayers());
    const accounts = accountStore.getAllAccounts().map(a => ({
      email: a.email,
      username: a.username,
      verified: a.verified,
      createdAt: a.createdAt,
      isOnline: a.username ? onlineSet.has(a.username) : false,
    }));
    res.json({ accounts });
  });

  /** Full unfiltered game content — admin only. */
  router.get('/content', (_req, res) => {
    const content = getContentStore();
    res.json({
      monsters: content.getAllMonsters(),
      items: content.getAllItems(),
      zones: content.getAllZones(),
      world: content.getWorld(),
    });
  });

  /** Add or update a world tile. Supports ?versionId= for draft editing. */
  router.put('/world/tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row, type, zone, name } = req.body;
    if (col == null || row == null || !type || !zone || !name) {
      res.status(400).json({ error: 'Missing required fields: col, row, type, zone, name' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.world.tiles.findIndex(t => t.col === col && t.row === row);
      if (idx >= 0) {
        snapshot.world.tiles[idx] = { col, row, type, zone, name };
      } else {
        snapshot.world.tiles.push({ col, row, type, zone, name });
      }
      await versions.saveSnapshot(versionId, snapshot);
      res.json({ success: true, world: snapshot.world });
    } else {
      const content = getContentStore();
      await content.addOrUpdateTile({ col, row, type, zone, name });
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
    }
  });

  /** Delete a world tile. Supports ?versionId= for draft editing. */
  router.delete('/world/tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row } = req.body;
    if (col == null || row == null) {
      res.status(400).json({ error: 'Missing required fields: col, row' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const { startTile } = snapshot.world;
      if (startTile.col === col && startTile.row === row) {
        res.status(400).json({ error: 'Cannot delete the start tile.' });
        return;
      }
      const idx = snapshot.world.tiles.findIndex(t => t.col === col && t.row === row);
      if (idx < 0) { res.status(400).json({ error: 'Tile not found.' }); return; }
      snapshot.world.tiles.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      res.json({ success: true, world: snapshot.world });
    } else {
      const content = getContentStore();
      const result = await content.deleteTile(col, row);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
    }
  });

  /** Set the start tile. Supports ?versionId= for draft editing. */
  router.put('/world/start-tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row } = req.body;
    if (col == null || row == null) {
      res.status(400).json({ error: 'Missing required fields: col, row' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const tile = snapshot.world.tiles.find(t => t.col === col && t.row === row);
      if (!tile) { res.status(400).json({ error: 'Tile not found.' }); return; }
      snapshot.world.startTile = { col, row };
      await versions.saveSnapshot(versionId, snapshot);
      res.json({ success: true, world: snapshot.world });
    } else {
      const content = getContentStore();
      const result = await content.setStartTile(col, row);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, world: content.getWorld() });
    }
  });

  // ── Version endpoints ──────────────────────────────────────

  /** List all versions. */
  router.get('/versions', (_req, res) => {
    const versions = getVersionStore();
    res.json({
      versions: versions.getAll(),
      activeVersionId: versions.getActiveVersionId(),
    });
  });

  /** Create a new draft version. */
  router.post('/versions', async (req, res) => {
    const { name, fromVersionId } = req.body;
    if (!name) {
      res.status(400).json({ error: 'Missing required field: name' });
      return;
    }

    const versions = getVersionStore();
    let snapshot;
    if (fromVersionId) {
      const fromVersion = versions.get(fromVersionId);
      if (!fromVersion) {
        res.status(404).json({ error: 'Source version not found.' });
        return;
      }
      snapshot = await versions.loadSnapshot(fromVersionId);
    } else {
      // Snapshot from current live content
      snapshot = getContentStore().toSnapshot();
    }

    const version = await versions.createDraft(name, fromVersionId ?? null, snapshot);
    res.json({ success: true, version });
  });

  /** Get a version's full content snapshot. */
  router.get('/versions/:id/content', async (req, res) => {
    const versions = getVersionStore();
    const version = versions.get(req.params.id);
    if (!version) {
      res.status(404).json({ error: 'Version not found.' });
      return;
    }
    const snapshot = await versions.loadSnapshot(req.params.id);
    res.json(snapshot);
  });

  /** Rename a draft version. */
  router.put('/versions/:id', async (req, res) => {
    const versions = getVersionStore();
    const version = versions.get(req.params.id);
    if (!version) {
      res.status(404).json({ error: 'Version not found.' });
      return;
    }
    if (version.status !== 'draft') {
      res.status(400).json({ error: 'Only drafts can be renamed.' });
      return;
    }
    if (req.body.name) {
      version.name = req.body.name;
      await versions.save();
    }
    res.json({ success: true, version });
  });

  /** Delete a version. */
  router.delete('/versions/:id', async (req, res) => {
    const versions = getVersionStore();
    const result = await versions.deleteVersion(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ success: true });
  });

  /** Publish a draft version (freeze it). */
  router.post('/versions/:id/publish', async (req, res) => {
    const versions = getVersionStore();
    const result = await versions.publish(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ success: true, version: result.version });
  });

  /** Deploy a published version to the live game. */
  router.post('/versions/:id/deploy', async (req, res) => {
    const result = await deployVersion(req.params.id);
    if (!result.success) {
      res.status(400).json({ error: result.error });
      return;
    }
    res.json({ success: true, relocated: result.relocated });
  });

  return router;
}
