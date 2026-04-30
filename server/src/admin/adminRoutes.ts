import { Router } from 'express';
import crypto from 'crypto';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { ContentStore } from '../game/ContentStore.js';
import type { VersionStore } from '../game/VersionStore.js';
import { ALL_CLASS_NAMES, SEED_TILE_TYPES, migrateLegacySet, findSetConflicts } from '@idle-party-rpg/shared';
import type { ClassName } from '@idle-party-rpg/shared';
import { adminMiddleware } from './adminMiddleware.js';

const artworkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

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
        deactivated: a.deactivated ?? false,
        hasReactivationRequest: !!a.reactivationRequest,
        reactivationRequest: a.reactivationRequest ?? null,
        sessionHistory: a.sessionHistory ?? [],
      };
    });
    res.json({ accounts });
  });

  /** Scan session histories for shared device tokens across accounts. */
  router.get('/duplicate-tokens', (_req, res) => {
    const tokenMap = new Map<string, Set<string>>();
    for (const account of accountStore.getAllAccounts()) {
      for (const record of account.sessionHistory ?? []) {
        if (record.deviceToken === 'unknown') continue;
        if (!tokenMap.has(record.deviceToken)) tokenMap.set(record.deviceToken, new Set());
        tokenMap.get(record.deviceToken)!.add(account.email);
      }
    }
    const duplicates: Record<string, string[]> = {};
    for (const [token, emails] of tokenMap) {
      if (emails.size > 1) duplicates[token] = Array.from(emails);
    }
    res.json({ duplicates });
  });

  /** Deactivate a player account. Fully removes them from the game world. */
  router.post('/players/:username/deactivate', async (req, res) => {
    const { username } = req.params;
    const account = accountStore.findByUsername(username);
    if (!account) {
      res.status(404).json({ error: `Account for "${username}" not found` });
      return;
    }
    await accountStore.setDeactivated(account.email, true);
    const pm = getPlayerManager();
    await pm.banPlayer(username);
    console.log(`[Admin] Deactivated "${username}"`);
    res.json({ success: true });
  });

  /** Reactivate a player account. */
  router.post('/players/:username/reactivate', async (req, res) => {
    const { username } = req.params;
    const account = accountStore.findByUsername(username);
    if (!account) {
      res.status(404).json({ error: `Account for "${username}" not found` });
      return;
    }
    await accountStore.setDeactivated(account.email, false);
    console.log(`[Admin] Reactivated "${username}"`);
    res.json({ success: true });
  });

  /** Full unfiltered game content — admin only. */
  router.get('/content', (_req, res) => {
    const content = getContentStore();
    res.json({
      monsters: content.getAllMonsters(),
      items: content.getAllItems(),
      zones: content.getAllZones(),
      encounters: content.getAllEncounters(),
      sets: content.getAllSets(),
      shops: content.getAllShops(),
      tileTypes: content.getAllTileTypes(),
      world: content.getWorld(),
    });
  });

  /** Add or update a world tile. Supports ?versionId= for draft editing. */
  router.put('/world/tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row, type, zone, name, encounterTable, shopId, requiredItemId } = req.body;
    if (col == null || row == null || !type || !zone || !name) {
      res.status(400).json({ error: 'Missing required fields: col, row, type, zone, name' });
      return;
    }

    // Validate optional encounter table entries
    if (encounterTable != null && Array.isArray(encounterTable)) {
      for (const entry of encounterTable) {
        if (!entry.encounterId || entry.weight == null) {
          res.status(400).json({ error: 'Each encounter entry requires: encounterId, weight' });
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
        snapshot.world.tiles[idx] = { id: snapshot.world.tiles[idx].id, col, row, type, zone, name, encounterTable: tileEncounterTable, shopId: shopId || undefined, requiredItemId: requiredItemId || undefined };
      } else {
        // New tile — generate a GUID
        snapshot.world.tiles.push({ id: crypto.randomUUID(), col, row, type, zone, name, encounterTable: tileEncounterTable, shopId: shopId || undefined, requiredItemId: requiredItemId || undefined });
      }
      await versions.saveSnapshot(versionId, snapshot);
      res.json({ success: true, world: snapshot.world });
    } else {
      const content = getContentStore();
      await content.addOrUpdateTile({ id: '', col, row, type, zone, name, encounterTable: tileEncounterTable, shopId: shopId || undefined, requiredItemId: requiredItemId || undefined });
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

  /** List all monsters. */
  router.get('/monsters', (_req, res) => {
    const content = getContentStore();
    res.json({ monsters: content.getAllMonsters() });
  });

  /** Add or update a monster. Supports ?versionId= for draft editing. */
  router.put('/monsters/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const monster = req.body;
    if (!monster.id || !monster.name || monster.hp == null ||
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

  /** Bulk import monsters. Adds or updates each monster. Supports ?versionId= for draft editing. */
  router.post('/monsters/bulk', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const monsters = req.body;
    if (!Array.isArray(monsters) || monsters.length === 0) {
      res.status(400).json({ error: 'Body must be a non-empty array of monsters' });
      return;
    }
    const errors: string[] = [];
    for (let i = 0; i < monsters.length; i++) {
      const m = monsters[i];
      if (!m.id || !m.name || m.hp == null ||
          m.damage == null || !m.damageType || m.xp == null ||
          m.goldMin == null || m.goldMax == null) {
        errors.push(`Monster at index ${i}: missing required fields (id, name, level, hp, damage, damageType, xp, goldMin, goldMax)`);
      }
    }
    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      for (const m of monsters) {
        const idx = snapshot.monsters.findIndex(existing => existing.id === m.id);
        if (idx >= 0) { snapshot.monsters[idx] = m; } else { snapshot.monsters.push(m); }
      }
      await versions.saveSnapshot(versionId, snapshot);
      const monstersRecord: Record<string, typeof monsters[0]> = {};
      for (const m of snapshot.monsters) monstersRecord[m.id] = m;
      res.json({ success: true, imported: monsters.length, monsters: monstersRecord });
    } else {
      const content = getContentStore();
      for (const m of monsters) {
        await content.addOrUpdateMonster(m);
      }
      res.json({ success: true, imported: monsters.length, monsters: content.getAllMonsters() });
    }
  });

  // ── Item endpoints ──────────────────────────────────────

  /** List all items. */
  router.get('/items', (_req, res) => {
    const content = getContentStore();
    res.json({ items: content.getAllItems() });
  });

  /** Bulk import items. Adds or updates each item. Supports ?versionId= for draft editing. */
  router.post('/items/bulk', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const items = req.body;
    if (!Array.isArray(items) || items.length === 0) {
      res.status(400).json({ error: 'Body must be a non-empty array of items' });
      return;
    }
    const errors: string[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item.id || !item.name || !item.rarity) {
        errors.push(`Item at index ${i}: missing required fields (id, name, rarity)`);
      }
    }
    if (errors.length > 0) {
      res.status(400).json({ error: 'Validation failed', errors });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      for (const item of items) {
        const idx = snapshot.items.findIndex(i => i.id === item.id);
        if (idx >= 0) { snapshot.items[idx] = item; } else { snapshot.items.push(item); }
      }
      await versions.saveSnapshot(versionId, snapshot);
      const itemsRecord: Record<string, typeof items[0]> = {};
      for (const i of snapshot.items) itemsRecord[i.id] = i;
      res.json({ success: true, imported: items.length, items: itemsRecord });
    } else {
      const content = getContentStore();
      for (const item of items) {
        await content.addOrUpdateItem(item);
      }
      res.json({ success: true, imported: items.length, items: content.getAllItems() });
    }
  });

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

  /** Upload artwork for an item. PNG only, square dimensions. */
  router.post('/items/:id/artwork', artworkUpload.single('artwork'), async (req, res) => {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded.' }); return; }
    if (req.file.mimetype !== 'image/png') { res.status(400).json({ error: 'Only PNG files are accepted.' }); return; }

    // Validate PNG is square by reading IHDR chunk
    // PNG structure: 8-byte signature, then IHDR chunk: 4 bytes length + 4 bytes 'IHDR' + 4 bytes width + 4 bytes height
    // So width is at offset 16 and height is at offset 20
    const buf = req.file.buffer;
    if (buf.length < 24) { res.status(400).json({ error: 'Invalid PNG file.' }); return; }
    const pngWidth = buf.readUInt32BE(16);
    const pngHeight = buf.readUInt32BE(20);
    if (pngWidth !== pngHeight) { res.status(400).json({ error: `Image must be square. Got ${pngWidth}x${pngHeight}.` }); return; }

    const artworkDir = path.resolve('data/item-artwork');
    await fs.mkdir(artworkDir, { recursive: true });
    await fs.writeFile(path.join(artworkDir, `${req.params.id}.png`), buf);
    res.json({ success: true });
  });

  /** Delete artwork for an item. */
  router.delete('/items/:id/artwork', async (req, res) => {
    const artworkPath = path.resolve('data/item-artwork', `${req.params.id}.png`);
    try {
      await fs.unlink(artworkPath);
      res.json({ success: true });
    } catch {
      res.json({ success: true }); // Already doesn't exist, that's fine
    }
  });

  // ── Set endpoints ──────────────────────────────────────

  /** List all sets. */
  router.get('/sets', (_req, res) => {
    const content = getContentStore();
    res.json({ sets: content.getAllSets() });
  });

  /** Add or update a set. Supports ?versionId= for draft editing. */
  router.put('/sets/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const raw = req.body;
    if (!raw || !raw.id || !raw.name || !Array.isArray(raw.itemIds)) {
      res.status(400).json({ error: 'Missing required fields: id, name, itemIds' });
      return;
    }
    if (!Array.isArray(raw.breakpoints) && !raw.bonuses) {
      res.status(400).json({ error: 'Set must include either breakpoints[] or legacy bonuses object' });
      return;
    }
    const set = migrateLegacySet(raw);

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.sets) snapshot.sets = [];

      // Validate against existing draft sets (other than the one being saved)
      const existingMigrated = snapshot.sets
        .filter(s => s.id !== set.id)
        .map(s => migrateLegacySet(s));
      const errors = findSetConflicts(set, existingMigrated);
      if (errors.length > 0) { res.status(400).json({ error: errors.join(' ') }); return; }

      const idx = snapshot.sets.findIndex(s => s.id === set.id);
      if (idx >= 0) {
        snapshot.sets[idx] = set;
      } else {
        snapshot.sets.push(set);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const setsRecord: Record<string, typeof set> = {};
      for (const s of snapshot.sets) setsRecord[s.id] = s;
      res.json({ success: true, sets: setsRecord });
    } else {
      const content = getContentStore();
      const result = await content.addOrUpdateSet(set);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, sets: content.getAllSets() });
    }
  });

  /** Delete a set. Supports ?versionId= for draft editing. */
  router.delete('/sets/:id', async (req, res) => {
    const setId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.sets) snapshot.sets = [];
      const idx = snapshot.sets.findIndex(s => s.id === setId);
      if (idx < 0) { res.status(400).json({ error: 'Set not found.' }); return; }
      snapshot.sets.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      const setsRecord: Record<string, typeof snapshot.sets[0]> = {};
      for (const s of snapshot.sets) setsRecord[s.id] = s;
      res.json({ success: true, sets: setsRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteSet(setId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, sets: content.getAllSets() });
    }
  });

  // ── Shop endpoints ──────────────────────────────────────

  /** List all shops. */
  router.get('/shops', (_req, res) => {
    const content = getContentStore();
    res.json({ shops: content.getAllShops() });
  });

  /** Add or update a shop. Supports ?versionId= for draft editing. */
  router.put('/shops/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const shop = req.body;
    if (!shop.id || !shop.name || !shop.inventory) {
      res.status(400).json({ error: 'Missing required fields: id, name, inventory' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.shops) snapshot.shops = [];
      const idx = snapshot.shops.findIndex(s => s.id === shop.id);
      if (idx >= 0) {
        snapshot.shops[idx] = shop;
      } else {
        snapshot.shops.push(shop);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const shopsRecord: Record<string, typeof shop> = {};
      for (const s of snapshot.shops) shopsRecord[s.id] = s;
      res.json({ success: true, shops: shopsRecord });
    } else {
      const content = getContentStore();
      await content.addOrUpdateShop(shop);
      res.json({ success: true, shops: content.getAllShops() });
    }
  });

  /** Delete a shop. Supports ?versionId= for draft editing. */
  router.delete('/shops/:id', async (req, res) => {
    const shopId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.shops) snapshot.shops = [];
      const idx = snapshot.shops.findIndex(s => s.id === shopId);
      if (idx < 0) { res.status(400).json({ error: 'Shop not found.' }); return; }
      snapshot.shops.splice(idx, 1);
      await versions.saveSnapshot(versionId, snapshot);
      const shopsRecord: Record<string, typeof snapshot.shops[0]> = {};
      for (const s of snapshot.shops) shopsRecord[s.id] = s;
      res.json({ success: true, shops: shopsRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteShop(shopId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, shops: content.getAllShops() });
    }
  });

  // ── Zone endpoints ──────────────────────────────────────

  /** List all zones. */
  router.get('/zones', (_req, res) => {
    const content = getContentStore();
    res.json({ zones: content.getAllZones() });
  });

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

  // ── Encounter endpoints ────────────────────────────────────

  /** List all encounters. */
  router.get('/encounters', (_req, res) => {
    const content = getContentStore();
    res.json({ encounters: content.getAllEncounters() });
  });

  /** Add or update an encounter. Supports ?versionId= for draft editing. */
  router.put('/encounters/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const encounter = req.body;
    if (!encounter.id || !encounter.name || !encounter.type) {
      res.status(400).json({ error: 'Missing required fields: id, name, type' });
      return;
    }

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.encounters) snapshot.encounters = [];
      const idx = snapshot.encounters.findIndex(e => e.id === encounter.id);
      if (idx >= 0) {
        snapshot.encounters[idx] = encounter;
      } else {
        snapshot.encounters.push(encounter);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const encountersRecord: Record<string, typeof encounter> = {};
      for (const e of snapshot.encounters) encountersRecord[e.id] = e;
      res.json({ success: true, encounters: encountersRecord });
    } else {
      const content = getContentStore();
      await content.addOrUpdateEncounter(encounter);
      res.json({ success: true, encounters: content.getAllEncounters() });
    }
  });

  /** Delete an encounter. Supports ?versionId= for draft editing. */
  router.delete('/encounters/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const encounterId = req.params.id;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.encounters) snapshot.encounters = [];
      // Check referential integrity within the snapshot
      for (const zone of snapshot.zones) {
        if (zone.encounterTable.some(e => e.encounterId === encounterId)) {
          res.status(400).json({ error: `Cannot delete: encounter is referenced by zone "${zone.displayName}".` });
          return;
        }
      }
      for (const tile of snapshot.world.tiles) {
        if (tile.encounterTable?.some(e => e.encounterId === encounterId)) {
          res.status(400).json({ error: `Cannot delete: encounter is referenced by tile "${tile.name}".` });
          return;
        }
      }
      snapshot.encounters = snapshot.encounters.filter(e => e.id !== encounterId);
      await versions.saveSnapshot(versionId, snapshot);
      const encountersRecord: Record<string, (typeof snapshot.encounters)[0]> = {};
      for (const e of snapshot.encounters) encountersRecord[e.id] = e;
      res.json({ success: true, encounters: encountersRecord });
    } else {
      const content = getContentStore();
      const result = await content.deleteEncounter(encounterId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, encounters: content.getAllEncounters() });
    }
  });

  // ── Tile Type endpoints ──────────────────────────────────────

  router.get('/tile-types', (_req, res) => {
    const content = getContentStore();
    res.json(content.getAllTileTypes());
  });

  router.put('/tile-types/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const tileTypeId = req.params.id;
    const { name, icon, color, traversable, requiredItemId } = req.body as {
      name?: string; icon?: string; color?: string; traversable?: boolean; requiredItemId?: string;
    };

    if (!name || typeof name !== 'string') {
      res.status(400).json({ error: 'name is required.' });
      return;
    }
    if (typeof color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(color)) {
      res.status(400).json({ error: 'color must be a hex string like #ff0000.' });
      return;
    }
    if (typeof traversable !== 'boolean') {
      res.status(400).json({ error: 'traversable is required (boolean).' });
      return;
    }

    const def = {
      id: tileTypeId,
      name,
      icon: icon ?? '',
      color,
      traversable,
      requiredItemId: requiredItemId || undefined,
    };

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.tileTypes || snapshot.tileTypes.length === 0) {
        // Old snapshot predates tile types — seed from live content
        snapshot.tileTypes = Object.values(getContentStore().getAllTileTypes());
      }
      const idx = snapshot.tileTypes.findIndex(t => t.id === tileTypeId);
      if (idx >= 0) snapshot.tileTypes[idx] = def;
      else snapshot.tileTypes.push(def);
      await versions.saveSnapshot(versionId, snapshot);
      const record: Record<string, import('@idle-party-rpg/shared').TileTypeDefinition> = {};
      for (const t of snapshot.tileTypes) record[t.id] = t;
      res.json({ success: true, tileTypes: record });
    } else {
      const content = getContentStore();
      await content.addOrUpdateTileType(def);
      res.json({ success: true, tileTypes: content.getAllTileTypes() });
    }
  });

  router.delete('/tile-types/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const tileTypeId = req.params.id;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.tileTypes || snapshot.tileTypes.length === 0) {
        snapshot.tileTypes = Object.values(getContentStore().getAllTileTypes());
      }
      // Check referential integrity
      for (const tile of snapshot.world.tiles) {
        if (tile.type === tileTypeId) {
          res.status(400).json({ error: `Cannot delete: tile type is used by room "${tile.name}".` });
          return;
        }
      }
      snapshot.tileTypes = snapshot.tileTypes.filter(t => t.id !== tileTypeId);
      await versions.saveSnapshot(versionId, snapshot);
      const record: Record<string, import('@idle-party-rpg/shared').TileTypeDefinition> = {};
      for (const t of snapshot.tileTypes) record[t.id] = t;
      res.json({ success: true, tileTypes: record });
    } else {
      const content = getContentStore();
      const result = await content.deleteTileType(tileTypeId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, tileTypes: content.getAllTileTypes() });
    }
  });

  /** Restore seed tile types (adds any missing defaults). */
  router.post('/tile-types/seed', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const versions = getVersionStore();
      const version = versions.get(versionId);
      if (!version) { res.status(404).json({ error: 'Version not found.' }); return; }
      if (version.status !== 'draft') { res.status(400).json({ error: 'Only drafts can be edited.' }); return; }
      const snapshot = await versions.loadSnapshot(versionId);
      if (!snapshot.tileTypes) snapshot.tileTypes = [];
      const existingIds = new Set(snapshot.tileTypes.map(t => t.id));
      for (const seed of SEED_TILE_TYPES) {
        if (!existingIds.has(seed.id)) snapshot.tileTypes.push(seed);
      }
      await versions.saveSnapshot(versionId, snapshot);
      const record: Record<string, import('@idle-party-rpg/shared').TileTypeDefinition> = {};
      for (const t of snapshot.tileTypes) record[t.id] = t;
      res.json({ success: true, tileTypes: record });
    } else {
      const content = getContentStore();
      for (const seed of SEED_TILE_TYPES) {
        if (!content.getTileType(seed.id)) {
          await content.addOrUpdateTileType(seed);
        }
      }
      res.json({ success: true, tileTypes: content.getAllTileTypes() });
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
    const encountersRecord: Record<string, NonNullable<(typeof snapshot.encounters)>[0]> = {};
    if (snapshot.encounters) {
      for (const e of snapshot.encounters) encountersRecord[e.id] = e;
    }
    const setsRecord: Record<string, NonNullable<(typeof snapshot.sets)>[0]> = {};
    if (snapshot.sets) {
      for (const s of snapshot.sets) setsRecord[s.id] = s;
    }
    const shopsRecord: Record<string, NonNullable<(typeof snapshot.shops)>[0]> = {};
    if (snapshot.shops) {
      for (const s of snapshot.shops) shopsRecord[s.id] = s;
    }
    const tileTypesRecord: Record<string, NonNullable<(typeof snapshot.tileTypes)>[0]> = {};
    if (snapshot.tileTypes && snapshot.tileTypes.length > 0) {
      for (const t of snapshot.tileTypes) tileTypesRecord[t.id] = t;
    } else {
      // Old snapshots predate tile types — seed from live content
      const liveTileTypes = getContentStore().getAllTileTypes();
      for (const [id, t] of Object.entries(liveTileTypes)) tileTypesRecord[id] = t;
    }
    res.json({ monsters: monstersRecord, items: itemsRecord, zones: zonesRecord, encounters: encountersRecord, sets: setsRecord, shops: shopsRecord, tileTypes: tileTypesRecord, world: snapshot.world });
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
    // Ensure the player has a party (needed if admin assigns class to characterless player)
    if (!session.getPartyId()) {
      pm.ensureParty(username);
    }
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
