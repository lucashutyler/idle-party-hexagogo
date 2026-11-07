import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { RequestHandler } from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { DungeonDefinition, DungeonFloor } from '@idle-party-rpg/shared';
import { createAdminRoutes } from '../src/admin/adminRoutes.js';
import type { AdminAuth } from '../src/admin/adminMiddleware.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { VersionStore } from '../src/game/VersionStore.js';
import type { PlayerManager } from '../src/game/PlayerManager.js';
import type { AccountStore } from '../src/auth/AccountStore.js';
import type { ApiTokenStore } from '../src/auth/ApiTokenStore.js';
import type { InviteListStore } from '../src/auth/InviteListStore.js';
import type { AssetStore } from '../src/game/AssetStore.js';

const OLD_FLOOR: DungeonFloor & Record<string, unknown> = {
  floorNumber: 1,
  gridShape: { cols: 3, rows: 3 },
  encounterTable: [],
  isBoss: true,
  checkpoints: [0.4, 0.6, 7],
  maxWipes: -1.5,
  checkpointRewardFraction: 99,
};

describe('live dungeon routes', () => {
  const dungeons = new Map<string, DungeonDefinition>();
  const endOrphanedRuns = vi.fn();
  let server: Server;
  let base: string;

  beforeEach(async () => {
    dungeons.clear();
    endOrphanedRuns.mockClear();
    const allow: RequestHandler = (_req, _res, next) => next();
    const content = {
      getAllDungeons: () => Object.fromEntries(dungeons),
      addOrUpdateDungeon: async (dungeon: DungeonDefinition) => { dungeons.set(dungeon.id, dungeon); },
      deleteDungeon: async (id: string) => (dungeons.delete(id) ? { success: true } : { success: false, error: 'Dungeon not found.' }),
    } as unknown as ContentStore;
    const app = express();
    app.use(express.json());
    app.use(createAdminRoutes({
      playerManager: () => ({ partyBattles: { endOrphanedRuns } }) as unknown as PlayerManager,
      accountStore: {} as AccountStore,
      inviteListStore: {} as InviteListStore,
      apiTokenStore: {} as ApiTokenStore,
      adminAuth: { requireAdmin: allow, requireSuperAdmin: allow, requireSession: allow } as unknown as AdminAuth,
      contentStore: () => content,
      versionStore: () => ({}) as VersionStore,
      assetStore: {} as AssetStore,
      rebuildGrid: () => 0,
      deployVersion: async () => ({ success: true }),
    }));
    await new Promise<void>(resolve => { server = app.listen(0, '127.0.0.1', resolve); });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
  });

  const put = (dungeon: object) => fetch(`${base}/dungeons/hall`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(dungeon),
  });

  it('saves a floor still carrying the old flag fields, whatever their values', async () => {
    const res = await put({ id: 'hall', name: 'Hall', floors: [OLD_FLOOR] });

    expect(res.status).toBe(200);
    expect(dungeons.get('hall')!.floors[0]).toMatchObject({ isBoss: true, maxWipes: -1.5 });
  });

  it('still refuses a floor with no shape', async () => {
    const res = await put({ id: 'hall', name: 'Hall', floors: [{ floorNumber: 1, encounterTable: [] }] });

    expect(res.status).toBe(400);
    expect(endOrphanedRuns).not.toHaveBeenCalled();
  });

  it('ends runs left without content after a live save or delete, and not after a refused delete', async () => {
    await put({ id: 'hall', name: 'Hall', floors: [] });
    expect(endOrphanedRuns).toHaveBeenCalledTimes(1);

    expect((await fetch(`${base}/dungeons/hall`, { method: 'DELETE' })).status).toBe(200);
    expect(endOrphanedRuns).toHaveBeenCalledTimes(2);

    expect((await fetch(`${base}/dungeons/hall`, { method: 'DELETE' })).status).toBe(400);
    expect(endOrphanedRuns).toHaveBeenCalledTimes(2);
  });
});
