import { Router } from 'express';
import type { PlayerManager } from '../game/PlayerManager.js';
import type { AccountStore } from '../auth/AccountStore.js';
import { adminMiddleware } from './adminMiddleware.js';

interface AdminRouteOptions {
  playerManager: PlayerManager;
  accountStore: AccountStore;
}

export function createAdminRoutes({ playerManager, accountStore }: AdminRouteOptions): Router {
  const router = Router();
  router.use(adminMiddleware);

  router.get('/overview', (_req, res) => {
    const onlinePlayers = playerManager.getOnlinePlayers();
    res.json({
      onlinePlayers: onlinePlayers.length,
      totalSessions: playerManager.sessionCount,
      totalConnections: playerManager.connectionCount,
      totalAccounts: accountStore.getAllAccounts().length,
      uptime: Math.floor(process.uptime()),
    });
  });

  router.get('/accounts', (_req, res) => {
    const onlineSet = new Set(playerManager.getOnlinePlayers());
    const accounts = accountStore.getAllAccounts().map(a => ({
      email: a.email,
      username: a.username,
      verified: a.verified,
      createdAt: a.createdAt,
      isOnline: a.username ? onlineSet.has(a.username) : false,
    }));
    res.json({ accounts });
  });

  return router;
}
