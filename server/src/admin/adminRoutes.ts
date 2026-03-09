import { Router } from 'express';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import type { ContentStore } from '../game/ContentStore.js';
import { adminMiddleware } from './adminMiddleware.js';

interface AdminRouteOptions {
  playerManager: () => PlayerManager;
  accountStore: AccountStore;
  contentStore: () => ContentStore;
}

export function createAdminRoutes({ playerManager: getPlayerManager, accountStore, contentStore: getContentStore }: AdminRouteOptions): Router {
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

  return router;
}
