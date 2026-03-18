import { Router } from 'express';
import crypto from 'crypto';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { ContentStore } from '../game/ContentStore.js';
import type { VersionStore } from '../game/VersionStore.js';
import { ALL_CLASS_NAMES } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';
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
    const accounts = accountStore.getAllAccounts().map(a => {
      const session = a.username ? pm.getSessionByUsername(a.username) : undefined;
      return {
        email: a.email,
        username: a.username,
        verified: a.verified,
        createdAt: a.createdAt,
        lastActiveAt: a.lastActiveAt ?? null,
        isOnline: a.username ? onlineSet.has(a.username) : false,
        className: session?.getClassName() ?? null,
        level: session?.getLevel() ?? null,
      };
    });
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
    const { col, row, type, zone, name, encounterTable } = req.body;
    if (col == null || row == null || !type || !zone || !name) {
      res.status(400).json({ error: 'Missing required fields: col, row, type, zone, name' });
      return;
    }

    // Validate optional encounter table entries
    if (encounterTable != null && Array.isArray(encounterTable)) {
      for (const entry of encounterTable) {
        if (!entry.monsterId || entry.weight == null || entry.minCount == null || entry.maxCount == null) {
          res.status(400).json({ error: 'Each encounter entry requires: monsterId, weight, minCount, maxCount' });
          return;
        }
      }
    }

    // Only include encounterTable if it has entries
    const tileEncounterTable = Array.isArray(encounterTable) && encounterTable.length > 0 ? encounterTable : undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.world.tiles.findIndex(t => t.col === col && t.row === row);
      if (idx >= 0) {
        // Preserve existing GUID on update
        snapshot.world.tiles[idx] = { id: snapshot.world.tiles[idx].id, col, row, type, zone, name, encounterTable: tileEncounterTable };
      } else {
        // New tile — generate a GUID
        snapshot.world.tiles.push({ id: crypto.randomUUID(), col, row, type, zone, name, encounterTable: tileEncounterTable });
      }
      await versions.saveSnapshot(versionId, snapshot);
      res.json({ success: true, world: snapshot.world });
    } else {
      const content = getContentStore();
      await content.addOrUpdateTile({ id: '', col, row, type, zone, name, encounterTable: tileEncounterTable });
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

  // ── Monster endpoints ────────────────────────────────────

  /** Add or update a monster. Supports ?versionId= for draft editing. */
  router.put('/monsters/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const monster = req.body;
    if (!monster.id || !monster.name || monster.level == null || monster.hp == null ||
        monster.damage == null || !monster.damageType || monster.xp == null ||
        monster.goldMin == null || monster.goldMax == null) {
      res.status(400).json({ error: 'Missing required fields: id, name, level, hp, damage, damageType, xp, goldMin, goldMax' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.monsters.findIndex(m => m.id === monster.id);
      if (idx >= 0) {
        snapshot.monsters[idx] = monster;
      } else {
        snapshot.monsters.push(monster);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const monstersRecord: Record<string, typeof monster> = {};
      for (const m of snapshot.monsters) monstersRecord[m.id] = m;
      res.json({ success: true, monsters: monstersRecord });
    } else {
      const content = getContentStore();
      await content.addOrUpdateMonster(monster);
      res.json({ success: true, monsters: content.getAllMonsters() });
    }
  });

  /** Delete a monster. Supports ?versionId= for draft editing. */
  router.delete('/monsters/:id', async (req, res) => {
    const monsterId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.monsters.findIndex(m => m.id === monsterId);
      if (idx < 0) { res.status(400).json({ error: 'Monster not found.' }); return; }
      snapshot.monsters.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      const monstersRecord: Record<string, typeof snapshot.monsters[0]> = {};
      for (const m of snapshot.monsters) monstersRecord[m.id] = m;
      res.json({ success: true, monsters: monstersRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteMonster(monsterId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, monsters: content.getAllMonsters() });
    }
  });

  // ── Item endpoints ──────────────────────────────────────

  /** Add or update an item. Supports ?versionId= for draft editing. */
  router.put('/items/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const item = req.body;
    if (!item.id || !item.name || !item.rarity) {
      res.status(400).json({ error: 'Missing required fields: id, name, rarity' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.items.findIndex(i => i.id === item.id);
      if (idx >= 0) {
        snapshot.items[idx] = item;
      } else {
        snapshot.items.push(item);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const itemsRecord: Record<string, typeof item> = {};
      for (const i of snapshot.items) itemsRecord[i.id] = i;
      res.json({ success: true, items: itemsRecord });
    } else {
      const content = getContentStore();
      await content.addOrUpdateItem(item);
      res.json({ success: true, items: content.getAllItems() });
    }
  });

  /** Delete an item. Supports ?versionId= for draft editing. */
  router.delete('/items/:id', async (req, res) => {
    const itemId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.items.findIndex(i => i.id === itemId);
      if (idx < 0) { res.status(400).json({ error: 'Item not found.' }); return; }
      // Check if any monster references this item in its drops
      const referencingMonster = snapshot.monsters.find(m => m.drops?.some(d => d.itemId === itemId));
      if (referencingMonster) {
        res.status(400).json({ error: `Cannot delete: item is referenced in ${referencingMonster.name}'s drop table.` });
        return;
      }
      snapshot.items.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      const itemsRecord: Record<string, typeof snapshot.items[0]> = {};
      for (const i of snapshot.items) itemsRecord[i.id] = i;
      res.json({ success: true, items: itemsRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteItem(itemId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, items: content.getAllItems() });
    }
  });

  // ── Zone endpoints ──────────────────────────────────────

  /** Add or update a zone. Supports ?versionId= for draft editing. */
  router.put('/zones/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const zone = req.body;
    if (!zone.id || !zone.displayName || !zone.levelRange || !zone.encounterTable) {
      res.status(400).json({ error: 'Missing required fields: id, displayName, levelRange, encounterTable' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.zones.findIndex(z => z.id === zone.id);
      if (idx >= 0) {
        snapshot.zones[idx] = zone;
      } else {
        snapshot.zones.push(zone);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const zonesRecord: Record<string, typeof zone> = {};
      for (const z of snapshot.zones) zonesRecord[z.id] = z;
      res.json({ success: true, zones: zonesRecord });
    } else {
      const content = getContentStore();
      await content.addOrUpdateZone(zone);
      res.json({ success: true, zones: content.getAllZones() });
    }
  });

  /** Delete a zone. Supports ?versionId= for draft editing. */
  router.delete('/zones/:id', async (req, res) => {
    const zoneId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      const idx = snapshot.zones.findIndex(z => z.id === zoneId);
      if (idx < 0) { res.status(400).json({ error: 'Zone not found.' }); return; }
      // Check if any world tile references this zone
      const referencingTile = snapshot.world.tiles.find(t => t.zone === zoneId);
      if (referencingTile) {
        res.status(400).json({ error: `Cannot delete: zone is used by tile "${referencingTile.name}" at (${referencingTile.col}, ${referencingTile.row}).` });
        return;
      }
      snapshot.zones.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      const zonesRecord: Record<string, typeof snapshot.zones[0]> = {};
      for (const z of snapshot.zones) zonesRecord[z.id] = z;
      res.json({ success: true, zones: zonesRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteZone(zoneId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, zones: content.getAllZones() });
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
    // Convert arrays to records keyed by ID (client expects Record<string, T>)
    const monstersRecord: Record<string, (typeof snapshot.monsters)[0]> = {};
    for (const m of snapshot.monsters) monstersRecord[m.id] = m;
    const itemsRecord: Record<string, (typeof snapshot.items)[0]> = {};
    for (const i of snapshot.items) itemsRecord[i.id] = i;
    const zonesRecord: Record<string, (typeof snapshot.zones)[0]> = {};
    for (const z of snapshot.zones) zonesRecord[z.id] = z;
    res.json({ monsters: monstersRecord, items: itemsRecord, zones: zonesRecord, world: snapshot.world });
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

  /** Master reset: reset all players to level 1, 0 XP, start tile (keep class). */
  router.post('/master-reset', (req, res) => {
    const { confirmation } = req.body as { confirmation?: string };
    if (confirmation !== 'IT ALL MUST END') {
      res.status(400).json({ error: 'Invalid confirmation' });
      return;
    }

    const pm = getPlayerManager();
    const count = pm.masterReset();
    console.log(`[Admin] Master reset executed: ${count} players reset`);
    res.json({ success: true, playersReset: count });
  });

  /** Change a player's class (admin). Resets character to level 1 with the new class. */
  router.post('/players/:username/class', (req, res) => {
    const { username } = req.params;
    const { className } = req.body as { className?: string };

    if (!className || !ALL_CLASS_NAMES.includes(className as ClassName)) {
      res.status(400).json({ error: `Invalid class. Valid classes: ${ALL_CLASS_NAMES.join(', ')}` });
      return;
    }

    const pm = getPlayerManager();
    const session = pm.getSessionByUsername(username);
    if (!session) {
      res.status(404).json({ error: `Player "${username}" not found` });
      return;
    }

    session.forceSetClass(className as ClassName);
    console.log(`[Admin] Changed "${username}" class to ${className}`);
    res.json({ success: true, className, level: session.getLevel() });
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
