import { Router } from 'express';
import { contentRegistry } from '@idle-party-rpg/shared';
import type { ContentStore } from '../game/ContentStore.js';
import type { GameLoop } from '../game/GameLoop.js';
import type { MonsterDefinition, ItemDefinition, ZoneDefinition, TileConfig, MapDefinition } from '@idle-party-rpg/shared';

interface AdminDeps {
  contentStore: ContentStore;
  gameLoop: GameLoop;
}

export function createAdminRoutes({ contentStore, gameLoop }: AdminDeps): Router {
  const router = Router();

  // --- Health ---
  router.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  // --- Monsters ---

  router.get('/monsters', (_req, res) => {
    res.json(contentRegistry.getAllMonsters());
  });

  router.put('/monsters', async (req, res) => {
    const data = req.body as Record<string, MonsterDefinition>;
    await contentStore.saveMonsters(data);
    res.json({ success: true });
  });

  router.post('/monsters', async (req, res) => {
    const monster = req.body as MonsterDefinition;
    if (!monster.id) {
      res.status(400).json({ error: 'Monster id is required' });
      return;
    }
    const all = { ...contentRegistry.getAllMonsters(), [monster.id]: monster };
    await contentStore.saveMonsters(all);
    res.json({ success: true });
  });

  router.put('/monsters/:id', async (req, res) => {
    const monster = req.body as MonsterDefinition;
    monster.id = req.params.id;
    const all = { ...contentRegistry.getAllMonsters(), [monster.id]: monster };
    await contentStore.saveMonsters(all);
    res.json({ success: true });
  });

  router.delete('/monsters/:id', async (req, res) => {
    const all = { ...contentRegistry.getAllMonsters() };
    delete all[req.params.id];
    await contentStore.saveMonsters(all);
    res.json({ success: true });
  });

  // --- Items ---

  router.get('/items', (_req, res) => {
    res.json(contentRegistry.getAllItems());
  });

  router.put('/items', async (req, res) => {
    const data = req.body as Record<string, ItemDefinition>;
    await contentStore.saveItems(data);
    res.json({ success: true });
  });

  router.post('/items', async (req, res) => {
    const item = req.body as ItemDefinition;
    if (!item.id) {
      res.status(400).json({ error: 'Item id is required' });
      return;
    }
    const all = { ...contentRegistry.getAllItems(), [item.id]: item };
    await contentStore.saveItems(all);
    res.json({ success: true });
  });

  router.put('/items/:id', async (req, res) => {
    const item = req.body as ItemDefinition;
    item.id = req.params.id;
    const all = { ...contentRegistry.getAllItems(), [item.id]: item };
    await contentStore.saveItems(all);
    res.json({ success: true });
  });

  router.delete('/items/:id', async (req, res) => {
    const all = { ...contentRegistry.getAllItems() };
    delete all[req.params.id];
    await contentStore.saveItems(all);
    res.json({ success: true });
  });

  // --- Zones ---

  router.get('/zones', (_req, res) => {
    res.json(contentRegistry.getAllZones());
  });

  router.put('/zones', async (req, res) => {
    const data = req.body as Record<string, ZoneDefinition>;
    await contentStore.saveZones(data);
    res.json({ success: true });
  });

  router.post('/zones', async (req, res) => {
    const zone = req.body as ZoneDefinition;
    if (!zone.id) {
      res.status(400).json({ error: 'Zone id is required' });
      return;
    }
    const all = { ...contentRegistry.getAllZones(), [zone.id]: zone };
    await contentStore.saveZones(all);
    res.json({ success: true });
  });

  router.put('/zones/:id', async (req, res) => {
    const zone = req.body as ZoneDefinition;
    zone.id = req.params.id;
    const all = { ...contentRegistry.getAllZones(), [zone.id]: zone };
    await contentStore.saveZones(all);
    res.json({ success: true });
  });

  router.delete('/zones/:id', async (req, res) => {
    const all = { ...contentRegistry.getAllZones() };
    delete all[req.params.id];
    await contentStore.saveZones(all);
    res.json({ success: true });
  });

  // --- Tile Types ---

  router.get('/tile-types', (_req, res) => {
    res.json(contentRegistry.getAllTileTypes());
  });

  router.put('/tile-types', async (req, res) => {
    const data = req.body as Record<string, TileConfig>;
    await contentStore.saveTileTypes(data);
    res.json({ success: true });
  });

  router.post('/tile-types', async (req, res) => {
    const tileType = req.body as TileConfig;
    if (!tileType.type) {
      res.status(400).json({ error: 'Tile type id is required' });
      return;
    }
    const all = { ...contentRegistry.getAllTileTypes(), [tileType.type]: tileType };
    await contentStore.saveTileTypes(all);
    res.json({ success: true });
  });

  router.put('/tile-types/:id', async (req, res) => {
    const tileType = req.body as TileConfig;
    tileType.type = req.params.id;
    const all = { ...contentRegistry.getAllTileTypes(), [tileType.type]: tileType };
    await contentStore.saveTileTypes(all);
    res.json({ success: true });
  });

  router.delete('/tile-types/:id', async (req, res) => {
    const all = { ...contentRegistry.getAllTileTypes() };
    delete all[req.params.id];
    await contentStore.saveTileTypes(all);
    res.json({ success: true });
  });

  // --- Maps ---

  router.get('/maps', (_req, res) => {
    const maps = contentStore.getAllMaps().map(m => ({
      id: m.id,
      name: m.name,
      type: m.type,
      tileCount: m.tiles.length,
    }));
    res.json(maps);
  });

  router.get('/maps/:id', (req, res) => {
    const map = contentStore.getMap(req.params.id);
    if (!map) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    res.json(map);
  });

  router.post('/maps', async (req, res) => {
    const mapDef = req.body as MapDefinition;
    if (!mapDef.id) {
      res.status(400).json({ error: 'Map id is required' });
      return;
    }
    await contentStore.saveMap(mapDef);
    res.json({ success: true });
  });

  router.put('/maps/:id', async (req, res) => {
    const mapDef = req.body as MapDefinition;
    mapDef.id = req.params.id;
    await contentStore.saveMap(mapDef);
    res.json({ success: true });
  });

  router.delete('/maps/:id', async (req, res) => {
    const deleted = await contentStore.deleteMap(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    res.json({ success: true });
  });

  // --- Map tiles (granular editing) ---

  router.put('/maps/:id/tiles', async (req, res) => {
    const map = contentStore.getMap(req.params.id);
    if (!map) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    const patches = req.body as { col: number; row: number; type: string; zone: string }[];
    for (const patch of patches) {
      const idx = map.tiles.findIndex(t => t.col === patch.col && t.row === patch.row);
      if (idx >= 0) {
        map.tiles[idx] = patch;
      } else {
        map.tiles.push(patch);
      }
    }
    await contentStore.saveMap(map);
    res.json({ success: true });
  });

  router.post('/maps/:id/tiles', async (req, res) => {
    const map = contentStore.getMap(req.params.id);
    if (!map) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    const tile = req.body as { col: number; row: number; type: string; zone: string };
    const idx = map.tiles.findIndex(t => t.col === tile.col && t.row === tile.row);
    if (idx >= 0) {
      map.tiles[idx] = tile;
    } else {
      map.tiles.push(tile);
    }
    await contentStore.saveMap(map);
    res.json({ success: true });
  });

  router.delete('/maps/:id/tiles/:key', async (req, res) => {
    const map = contentStore.getMap(req.params.id);
    if (!map) {
      res.status(404).json({ error: 'Map not found' });
      return;
    }
    const [col, row] = req.params.key.split(',').map(Number);
    map.tiles = map.tiles.filter(t => t.col !== col || t.row !== row);
    await contentStore.saveMap(map);
    res.json({ success: true });
  });

  // --- Server Stats ---

  router.get('/server-stats', (_req, res) => {
    const { playerManager } = gameLoop;
    res.json({
      sessions: playerManager.sessionCount,
      connections: playerManager.connectionCount,
      uptime: process.uptime(),
    });
  });

  // --- Players ---

  router.get('/players', (_req, res) => {
    const { playerManager } = gameLoop;
    const online = new Set(playerManager.getOnlinePlayers());
    const players: { username: string; level: number; col: number; row: number; online: boolean }[] = [];
    for (const username of playerManager.getSessionUsernames()) {
      const session = playerManager.getSessionByUsername(username);
      if (session) {
        const pos = session.getPosition();
        players.push({
          username,
          level: session.getLevel(),
          col: pos.col,
          row: pos.row,
          online: online.has(username),
        });
      }
    }
    res.json(players);
  });

  return router;
}
