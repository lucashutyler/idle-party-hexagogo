import { Router } from 'express';
import multer from 'multer';
import fs from 'fs/promises';
import path from 'path';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { InviteListStore } from '../auth/InviteListStore.js';
import type { ContentStore } from '../game/ContentStore.js';
import type { VersionStore } from '../game/VersionStore.js';
import { ALL_CLASS_NAMES, SEED_TILE_TYPES, SEED_SKILLS, SEED_SKILL_SLOT_SCHEDULES, migrateLegacySet, migrateLegacySkill, validateSkillDefinition, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { ClassName, SkillDefinition, SkillSlot, SkillSlotType } from '@idle-party-rpg/shared';
import { adminMiddleware } from './adminMiddleware.js';
import { DraftEditor, toRecord } from '../game/DraftEditor.js';

const artworkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 } });

interface AdminRouteOptions {
  playerManager: () => PlayerManager;
  accountStore: AccountStore;
  inviteListStore: InviteListStore;
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
  rebuildGrid: () => number;
  deployVersion: (versionId: string) => Promise<{ success: boolean; error?: string; relocated?: number }>;
}

export function createAdminRoutes({ playerManager: getPlayerManager, accountStore, inviteListStore, contentStore: getContentStore, versionStore: getVersionStore, rebuildGrid, deployVersion }: AdminRouteOptions): Router {
  const router = Router();
  router.use(adminMiddleware);
  const draftEditor = new DraftEditor(getVersionStore(), getContentStore);

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

  /** Invite-only beta gate: INVITE_ONLY env var + admin-managed allow list (ADMIN_EMAILS is always allowed). */
  router.get('/invite-list', (_req, res) => {
    res.json({
      inviteOnly: process.env.INVITE_ONLY === 'true',
      emails: inviteListStore.getAll(),
    });
  });

  router.post('/invite-list', async (req, res) => {
    const { email } = req.body;
    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }
    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }
    await inviteListStore.add(trimmed);
    res.json({ success: true, emails: inviteListStore.getAll() });
  });

  router.delete('/invite-list/:email', async (req, res) => {
    const email = decodeURIComponent(req.params.email).trim().toLowerCase();
    await inviteListStore.remove(email);
    res.json({ success: true, emails: inviteListStore.getAll() });
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
      recipes: content.getAllRecipes(),
      npcs: content.getAllNpcs(),
      quests: content.getAllQuests(),
      dungeons: content.getAllDungeons(),
      skills: content.getAllSkills(),
      skillSlotSchedules: content.getAllSkillSlotSchedules(),
      designNotes: content.getAllDesignNotes(),
      world: content.getWorld(),
    });
  });

  /** Add or update a world tile. Supports ?versionId= for draft editing. */
  router.put('/world/tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row, type, zone, name, encounterTable, shopId, npcId, dungeonId, requiredItemId, transitions } = req.body;
    if (col == null || row == null || !type || !zone || !name) {
      res.status(400).json({ error: 'Missing required fields: col, row, type, zone, name' });
      return;
    }

    // Normalize optional map transition links (drop malformed/empty entries).
    const tileTransitions = Array.isArray(transitions)
      ? transitions
          .filter((t: { mapId?: unknown; tileId?: unknown }) => t && t.mapId && t.tileId)
          .map((t: { mapId: string; tileId: string }) => ({ mapId: t.mapId, tileId: t.tileId }))
      : undefined;
    const tileTransitionsOrUndef = tileTransitions && tileTransitions.length > 0 ? tileTransitions : undefined;

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
    // Which map this tile belongs to. Clients that predate multi-map omit it → default map.
    const tileMapId = (req.body.mapId as string) || DEFAULT_MAP_ID;
    const tileInput = { mapId: tileMapId, col, row, type, zone, name, encounterTable: tileEncounterTable, shopId: shopId || undefined, npcId: npcId || undefined, dungeonId: dungeonId || undefined, requiredItemId: requiredItemId || undefined, transitions: tileTransitionsOrUndef };

    if (versionId) {
      const result = await draftEditor.upsertTile(versionId, tileInput);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, world: result.world });
    } else {
      const content = getContentStore();
      await content.addOrUpdateTile({ id: '', ...tileInput });
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
    }
  });

  /** Delete a world tile. Supports ?versionId= for draft editing. */
  router.delete('/world/tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row } = req.body;
    const tileMapId = (req.body.mapId as string) || DEFAULT_MAP_ID;
    if (col == null || row == null) {
      res.status(400).json({ error: 'Missing required fields: col, row' });
      return;
    }

    if (versionId) {
      const result = await draftEditor.deleteTile(versionId, tileMapId, col, row);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, world: result.world });
    } else {
      const content = getContentStore();
      const result = await content.deleteTile(tileMapId, col, row);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
    }
  });

  /**
   * Set a map's start tile. Defaults to the default map (the global spawn) when
   * `mapId` is omitted. Supports ?versionId= for draft editing.
   */
  router.put('/world/start-tile', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { col, row } = req.body;
    if (col == null || row == null) {
      res.status(400).json({ error: 'Missing required fields: col, row' });
      return;
    }

    if (versionId) {
      const result = await draftEditor.setStartTile(versionId, req.body.mapId as string | undefined, col, row);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, world: result.world });
    } else {
      const content = getContentStore();
      const mapId = (req.body.mapId as string) || content.getWorld().defaultMapId;
      const result = await content.setMapStartTile(mapId, col, row);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, world: content.getWorld() });
    }
  });

  /** Create or rename a map. Supports ?versionId= for draft editing. */
  router.post('/world/map', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { id, name, startTile } = req.body;
    if (!id || !name) {
      res.status(400).json({ error: 'Missing required fields: id, name' });
      return;
    }
    const meta = { id: id as string, name: name as string, startTile: startTile ?? { col: 0, row: 0 } };

    if (versionId) {
      const result = await draftEditor.upsertMap(versionId, meta);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, world: result.world });
    } else {
      const content = getContentStore();
      const result = await content.addOrUpdateMap(meta);
      if (!result.success) { res.status(400).json({ error: result.error }); return; }
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
    }
  });

  /** Delete a map (must have no rooms and no inbound transitions). Supports ?versionId=. */
  router.delete('/world/map', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const { id } = req.body;
    if (!id) { res.status(400).json({ error: 'Missing required field: id' }); return; }

    if (versionId) {
      const result = await draftEditor.deleteMap(versionId, id as string);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, world: result.world });
    } else {
      const content = getContentStore();
      const result = await content.deleteMap(id as string);
      if (!result.success) { res.status(400).json({ error: result.error }); return; }
      const relocated = rebuildGrid();
      res.json({ success: true, world: content.getWorld(), relocated });
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
      const result = await draftEditor.upsertMonster(versionId, monster);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, monsters: toRecord(result.entries) });
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
      const result = await draftEditor.deleteMonster(versionId, monsterId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, monsters: toRecord(result.entries) });
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
      const result = await draftEditor.upsertContentBulk('monsters', versionId, monsters);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, imported: monsters.length, monsters: toRecord(result.entries as typeof monsters) });
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
      const result = await draftEditor.upsertContentBulk('items', versionId, items);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, imported: items.length, items: toRecord(result.entries as typeof items) });
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
    const grantedSkillIds: string[] = Array.isArray(item.grantedSkillIds) ? item.grantedSkillIds : [];

    if (versionId) {
      const result = await draftEditor.upsertItem(versionId, item);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, items: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const unknownGrants = grantedSkillIds.filter(sid => !content.getSkill(sid));
      if (unknownGrants.length > 0) {
        res.status(400).json({ error: `Unknown skill id(s) in grantedSkillIds: ${unknownGrants.join(', ')}` });
        return;
      }
      await content.addOrUpdateItem(item);
      res.json({ success: true, items: content.getAllItems() });
    }
  });

  /** Delete an item. Supports ?versionId= for draft editing. */
  router.delete('/items/:id', async (req, res) => {
    const itemId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteItem(versionId, itemId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, items: toRecord(result.entries) });
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

  // ── Generic CRM artwork upload/delete ──────────────────────
  // Single endpoint handles every content kind so new content types don't
  // need their own bespoke routes. The admin client posts to
  // `/api/admin/artwork/:kind/:id` with a PNG file.
  /** Map of allowed kinds → on-disk folder. New kinds just add a row here. */
  const ARTWORK_KINDS: Record<string, string> = {
    item: 'data/item-artwork',
    monster: 'data/monster-artwork',
    set: 'data/set-artwork',
    shop: 'data/shop-artwork',
    zone: 'data/zone-artwork',
    'tile-type': 'data/tile-type-artwork',
    parchment: 'data/parchment-artwork',
  };

  /** Validate + write a square PNG into the appropriate kind folder. */
  router.post('/artwork/:kind/:id', artworkUpload.single('artwork'), async (req, res) => {
    const dir = ARTWORK_KINDS[req.params.kind];
    if (!dir) { res.status(400).json({ error: `Unknown artwork kind: ${req.params.kind}` }); return; }
    if (!req.file) { res.status(400).json({ error: 'No file uploaded.' }); return; }
    if (req.file.mimetype !== 'image/png') { res.status(400).json({ error: 'Only PNG files are accepted.' }); return; }

    // Validate PNG is square via the IHDR chunk (offset 16 width, 20 height).
    const buf = req.file.buffer;
    if (buf.length < 24) { res.status(400).json({ error: 'Invalid PNG file.' }); return; }
    const w = buf.readUInt32BE(16);
    const h = buf.readUInt32BE(20);
    if (w !== h) { res.status(400).json({ error: `Image must be square. Got ${w}x${h}.` }); return; }

    const artworkDir = path.resolve(dir);
    await fs.mkdir(artworkDir, { recursive: true });
    await fs.writeFile(path.join(artworkDir, `${req.params.id}.png`), buf);
    res.json({ success: true });
  });

  router.delete('/artwork/:kind/:id', async (req, res) => {
    const dir = ARTWORK_KINDS[req.params.kind];
    if (!dir) { res.status(400).json({ error: `Unknown artwork kind: ${req.params.kind}` }); return; }
    const artworkPath = path.resolve(dir, `${req.params.id}.png`);
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
    // Collect every skill this set's breakpoints grant (validated against the target store below)
    const setGrantIds: string[] = [];
    for (const bp of set.breakpoints ?? []) {
      for (const sid of bp.bonuses.grantedSkillIds ?? []) {
        if (!setGrantIds.includes(sid)) setGrantIds.push(sid);
      }
    }

    if (versionId) {
      const result = await draftEditor.upsertSet(versionId, set);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, sets: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const unknownGrants = setGrantIds.filter(sid => !content.getSkill(sid));
      if (unknownGrants.length > 0) {
        res.status(400).json({ error: `Unknown skill id(s) in grantedSkillIds: ${unknownGrants.join(', ')}` });
        return;
      }
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
      const result = await draftEditor.deleteSet(versionId, setId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, sets: toRecord(result.entries) });
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
      const result = await draftEditor.upsertShop(versionId, shop);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, shops: toRecord(result.entries) });
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
      const result = await draftEditor.deleteShop(versionId, shopId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, shops: toRecord(result.entries) });
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

  // ── Recipe endpoints ──────────────────────────────────────

  /** List all recipes. */
  router.get('/recipes', (_req, res) => {
    const content = getContentStore();
    res.json({ recipes: content.getAllRecipes() });
  });

  /** Add or update a recipe. Supports ?versionId= for draft editing. */
  router.put('/recipes/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const recipe = req.body;
    if (!recipe.id || !recipe.name || typeof recipe.durationSeconds !== 'number'
        || !Array.isArray(recipe.ingredients) || !recipe.result) {
      res.status(400).json({ error: 'Missing required fields: id, name, durationSeconds, ingredients[], result' });
      return;
    }
    if (recipe.durationSeconds <= 0) {
      res.status(400).json({ error: 'durationSeconds must be > 0' });
      return;
    }
    if (recipe.ingredients.length === 0) {
      res.status(400).json({ error: 'At least one ingredient is required' });
      return;
    }
    for (const ing of recipe.ingredients) {
      if (!ing.itemId || typeof ing.quantity !== 'number' || ing.quantity <= 0) {
        res.status(400).json({ error: 'Each ingredient requires: itemId, quantity > 0' });
        return;
      }
    }
    if (!recipe.result.itemId || typeof recipe.result.quantity !== 'number' || recipe.result.quantity <= 0) {
      res.status(400).json({ error: 'result requires: itemId, quantity > 0' });
      return;
    }

    if (versionId) {
      const result = await draftEditor.upsertRecipe(versionId, recipe);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, recipes: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      await content.addOrUpdateRecipe(recipe);
      res.json({ success: true, recipes: content.getAllRecipes() });
    }
  });

  /** Delete a recipe. Supports ?versionId= for draft editing. */
  router.delete('/recipes/:id', async (req, res) => {
    const recipeId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteRecipe(versionId, recipeId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, recipes: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const result = await content.deleteRecipe(recipeId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, recipes: content.getAllRecipes() });
    }
  });

  // ── NPC endpoints ───────────────────────────────────────

  /** List all NPCs. */
  router.get('/npcs', (_req, res) => {
    const content = getContentStore();
    res.json({ npcs: content.getAllNpcs() });
  });

  /** Add or update an NPC. Supports ?versionId= for draft editing. */
  router.put('/npcs/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const npc = req.body;
    if (!npc.id || !npc.name || !npc.emoji || !npc.greeting) {
      res.status(400).json({ error: 'Missing required fields: id, name, emoji, greeting' });
      return;
    }

    if (versionId) {
      const result = await draftEditor.upsertNpc(versionId, npc);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, npcs: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      await content.addOrUpdateNpc(npc);
      res.json({ success: true, npcs: content.getAllNpcs() });
    }
  });

  /** Delete an NPC. Supports ?versionId= for draft editing. */
  router.delete('/npcs/:id', async (req, res) => {
    const npcId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteNpc(versionId, npcId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, npcs: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const result = await content.deleteNpc(npcId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, npcs: content.getAllNpcs() });
    }
  });

  // ── Quest endpoints ─────────────────────────────────────

  /** List all quests. */
  router.get('/quests', (_req, res) => {
    const content = getContentStore();
    res.json({ quests: content.getAllQuests() });
  });

  /** Add or update a quest. Supports ?versionId= for draft editing. */
  router.put('/quests/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const quest = req.body;
    if (!quest.id || !quest.name || !quest.scope || !Array.isArray(quest.objectives) || !Array.isArray(quest.rewards)) {
      res.status(400).json({ error: 'Missing required fields: id, name, scope, objectives, rewards' });
      return;
    }

    if (versionId) {
      const result = await draftEditor.upsertQuest(versionId, quest);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, quests: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      await content.addOrUpdateQuest(quest);
      res.json({ success: true, quests: content.getAllQuests() });
    }
  });

  /** Delete a quest. Supports ?versionId= for draft editing. */
  router.delete('/quests/:id', async (req, res) => {
    const questId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteQuest(versionId, questId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, quests: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const result = await content.deleteQuest(questId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, quests: content.getAllQuests() });
    }
  });

  // ── Dungeon endpoints ───────────────────────────────────

  /** List all dungeons. */
  router.get('/dungeons', (_req, res) => {
    const content = getContentStore();
    res.json({ dungeons: content.getAllDungeons() });
  });

  /** Add or update a dungeon. Supports ?versionId= for draft editing. */
  router.put('/dungeons/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const dungeon = req.body;
    if (!dungeon.id || !dungeon.name || !Array.isArray(dungeon.floors)) {
      res.status(400).json({ error: 'Missing required fields: id, name, floors' });
      return;
    }
    for (const floor of dungeon.floors) {
      if (typeof floor.floorNumber !== 'number'
        || !floor.gridShape
        || typeof floor.gridShape.cols !== 'number'
        || typeof floor.gridShape.rows !== 'number'
        || floor.gridShape.cols < 1
        || floor.gridShape.rows < 1
        || !Array.isArray(floor.encounterTable)) {
        res.status(400).json({ error: 'Each floor needs floorNumber, gridShape (cols/rows >= 1), and encounterTable.' });
        return;
      }
    }

    if (versionId) {
      const result = await draftEditor.upsertDungeon(versionId, dungeon);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, dungeons: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      await content.addOrUpdateDungeon(dungeon);
      res.json({ success: true, dungeons: content.getAllDungeons() });
    }
  });

  /** Delete a dungeon. Supports ?versionId= for draft editing. */
  router.delete('/dungeons/:id', async (req, res) => {
    const dungeonId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteDungeon(versionId, dungeonId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, dungeons: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const result = await content.deleteDungeon(dungeonId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      res.json({ success: true, dungeons: content.getAllDungeons() });
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
      const result = await draftEditor.upsertZone(versionId, zone);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, zones: toRecord(result.entries) });
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
      const result = await draftEditor.deleteZone(versionId, zoneId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, zones: toRecord(result.entries) });
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
      const result = await draftEditor.upsertEncounter(versionId, encounter);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, encounters: toRecord(result.entries) });
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
      const result = await draftEditor.deleteEncounter(versionId, encounterId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, encounters: toRecord(result.entries) });
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
      const result = await draftEditor.upsertTileType(versionId, def);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, tileTypes: toRecord(result.entries) });
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
      const result = await draftEditor.deleteTileType(versionId, tileTypeId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, tileTypes: toRecord(result.entries) });
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
      const result = await draftEditor.seedTileTypes(versionId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, tileTypes: toRecord(result.entries) });
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

  // ── Skill endpoints ─────────────────────────────────────

  /** List all skills. */
  router.get('/skills', (_req, res) => {
    const content = getContentStore();
    res.json({ skills: content.getAllSkills() });
  });

  /** Add or update a skill. Accepts legacy-shaped bodies. Supports ?versionId= for draft editing. */
  router.put('/skills/:id', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const raw = req.body;
    if (!raw || typeof raw !== 'object' || !raw.id) {
      res.status(400).json({ error: 'Missing required field: id' });
      return;
    }
    const skill = migrateLegacySkill(raw);
    const errors = validateSkillDefinition(skill);
    if (errors.length > 0) {
      res.status(400).json({ error: errors.join(' ') });
      return;
    }

    if (versionId) {
      const result = await draftEditor.upsertSkill(versionId, skill);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, skills: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      await content.addOrUpdateSkill(skill);
      for (const session of getPlayerManager().getAllSessions()) session.autoUnlockSkills();
      res.json({ success: true, skills: content.getAllSkills() });
    }
  });

  /** Delete a skill. Blocked while any item or set breakpoint grants it. Supports ?versionId=. */
  router.delete('/skills/:id', async (req, res) => {
    const skillId = req.params.id;
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.deleteSkill(versionId, skillId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      res.json({ success: true, skills: toRecord(result.entries) });
    } else {
      const content = getContentStore();
      const result = await content.deleteSkill(skillId);
      if (!result.success) {
        res.status(400).json({ error: result.error });
        return;
      }
      for (const session of getPlayerManager().getAllSessions()) session.autoUnlockSkills();
      res.json({ success: true, skills: content.getAllSkills() });
    }
  });

  /** Restore seed skills + slot schedules (overwrites seed ids, keeps custom skills). Supports ?versionId=. */
  router.post('/skills/seed', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;

    if (versionId) {
      const result = await draftEditor.seedSkills(versionId);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      const schedulesRecord: Record<string, SkillSlot[]> = {};
      for (const entry of result.skillSlotSchedules) schedulesRecord[entry.className] = entry.slots;
      res.json({ success: true, skills: toRecord(result.skills), skillSlotSchedules: schedulesRecord });
    } else {
      const content = getContentStore();
      for (const seed of Object.values(SEED_SKILLS)) {
        await content.addOrUpdateSkill(seed);
      }
      for (const [className, slots] of Object.entries(SEED_SKILL_SLOT_SCHEDULES)) {
        await content.setSkillSlotSchedule(className, slots);
      }
      for (const session of getPlayerManager().getAllSessions()) session.autoUnlockSkills();
      res.json({ success: true, skills: content.getAllSkills(), skillSlotSchedules: content.getAllSkillSlotSchedules() });
    }
  });

  /** Replace a class's skill slot schedule. Supports ?versionId= for draft editing. */
  router.put('/skill-slots/:className', async (req, res) => {
    const versionId = req.query.versionId as string | undefined;
    const className = req.params.className;
    if (!ALL_CLASS_NAMES.includes(className as ClassName)) {
      res.status(400).json({ error: `Invalid class. Valid classes: ${ALL_CLASS_NAMES.join(', ')}` });
      return;
    }
    const { slots } = req.body as { slots?: { type?: unknown; unlocksAtLevel?: unknown }[] };
    if (!Array.isArray(slots) || slots.length === 0) {
      res.status(400).json({ error: 'slots must be a non-empty array.' });
      return;
    }
    for (const slot of slots) {
      if (!slot || (slot.type !== 'passive' && slot.type !== 'active')) {
        res.status(400).json({ error: "Each slot requires type 'passive' or 'active'." });
        return;
      }
      if (typeof slot.unlocksAtLevel !== 'number' || !Number.isInteger(slot.unlocksAtLevel) || slot.unlocksAtLevel < 1 || slot.unlocksAtLevel > 100) {
        res.status(400).json({ error: 'Each slot requires an integer unlocksAtLevel between 1 and 100.' });
        return;
      }
    }
    const schedule: SkillSlot[] = slots.map(s => ({ type: s.type as SkillSlotType, unlocksAtLevel: s.unlocksAtLevel as number }));

    if (versionId) {
      const result = await draftEditor.setSkillSlotSchedule(versionId, className, schedule);
      if (!result.success) { res.status(result.status).json({ error: result.error }); return; }
      const schedulesRecord: Record<string, SkillSlot[]> = {};
      for (const entry of result.skillSlotSchedules) schedulesRecord[entry.className] = entry.slots;
      res.json({ success: true, skillSlotSchedules: schedulesRecord });
    } else {
      const content = getContentStore();
      await content.setSkillSlotSchedule(className, schedule);
      for (const session of getPlayerManager().getAllSessions()) session.autoUnlockSkills();
      res.json({ success: true, skillSlotSchedules: content.getAllSkillSlotSchedules() });
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
    const monstersRecord = toRecord(snapshot.monsters);
    const itemsRecord = toRecord(snapshot.items);
    const zonesRecord = toRecord(snapshot.zones);
    const encountersRecord = toRecord(snapshot.encounters ?? []);
    const setsRecord = toRecord(snapshot.sets ?? []);
    const shopsRecord = toRecord(snapshot.shops ?? []);
    // Old snapshots predate tile types/recipes/skills/design notes — seed from live content so
    // admin shows what's actually in-game. A present-but-empty array means the draft genuinely has none.
    const tileTypesRecord = snapshot.tileTypes && snapshot.tileTypes.length > 0
      ? toRecord(snapshot.tileTypes)
      : getContentStore().getAllTileTypes();
    const recipesRecord = snapshot.recipes && snapshot.recipes.length > 0
      ? toRecord(snapshot.recipes)
      : getContentStore().getAllRecipes();
    const npcsRecord = toRecord(snapshot.npcs ?? []);
    const questsRecord = toRecord(snapshot.quests ?? []);
    const dungeonsRecord = toRecord(snapshot.dungeons ?? []);
    const skillsRecord: Record<string, SkillDefinition> = snapshot.skills !== undefined
      ? toRecord(snapshot.skills)
      : getContentStore().getAllSkills();
    const designNotesRecord = snapshot.designNotes !== undefined
      ? toRecord(snapshot.designNotes)
      : getContentStore().getAllDesignNotes();
    const skillSlotSchedulesRecord: Record<string, SkillSlot[]> = {};
    if (snapshot.skillSlotSchedules !== undefined) {
      for (const entry of snapshot.skillSlotSchedules) skillSlotSchedulesRecord[entry.className] = entry.slots;
    } else {
      // Old snapshots predate slot schedules (key absent) — seed from live content.
      const liveSchedules = getContentStore().getAllSkillSlotSchedules();
      for (const [cn, sl] of Object.entries(liveSchedules)) skillSlotSchedulesRecord[cn] = sl;
    }
    res.json({ monsters: monstersRecord, items: itemsRecord, zones: zonesRecord, encounters: encountersRecord, sets: setsRecord, shops: shopsRecord, tileTypes: tileTypesRecord, recipes: recipesRecord, npcs: npcsRecord, quests: questsRecord, dungeons: dungeonsRecord, skills: skillsRecord, skillSlotSchedules: skillSlotSchedulesRecord, designNotes: designNotesRecord, world: snapshot.world });
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
