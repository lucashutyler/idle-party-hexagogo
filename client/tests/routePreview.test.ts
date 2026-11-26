import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { WorldCache } from '../src/network/WorldCache';
import { LOCKED_DOOR_WAY_TEXT, NO_KNOWN_WAY_TEXT, previewRoute, routePreviewLines } from '../src/ui/routePreview';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const room = (id: string, mapId: string, col: number, extra: Record<string, unknown> = {}) =>
  ({ id, mapId, col, row: 0, type: 'plains', zone: mapId, name: `Room ${id}`, ...extra });

/** Vale holds two areas split by water; one door into the grotto, whose far end leads back to the far area; a locked shortcut too. */
async function loadCache(): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url !== '/api/world') return json({});
    return json({
      startTile: { col: 0, row: 0 },
      maps: [
        { id: 'vale', name: 'Vale', startTile: { col: 0, row: 0 } },
        { id: 'grotto', name: 'Grotto', startTile: { col: 0, row: 0 } },
        { id: 'peak', name: 'Peak', startTile: { col: 0, row: 0 } },
      ],
      tiles: [
        room('v0', 'vale', 0),
        room('v1', 'vale', 1),
        room('v2', 'vale', 2, { transitions: [{ mapId: 'grotto', tileId: 'g0' }] }),
        room('v3', 'vale', 3, { transitions: [{ mapId: 'vale', tileId: 'v8', entryRequirements: { minLevel: 9 } }] }),
        room('v4', 'vale', 4, { type: 'water' }),
        room('v8', 'vale', 8),
        room('v9', 'vale', 9),
        room('g0', 'grotto', 0),
        room('g1', 'grotto', 1, { transitions: [{ mapId: 'vale', tileId: 'v9' }] }),
        room('p0', 'peak', 0),
      ],
      tileTypes: {
        plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true },
        water: { id: 'water', name: 'Water', icon: '', color: '#0000ff', traversable: false },
      },
    });
  }));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

function state(unlocked: string[]): ServerStateMessage {
  return {
    username: 'me',
    currentMapId: 'vale',
    party: { col: 0, row: 0, state: 'idle', path: [] },
    unlocked,
    character: { level: 1, equipment: {} },
    social: null,
  } as unknown as ServerStateMessage;
}

describe('previewRoute', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is a walk within the party\'s area', async () => {
    const cache = await loadCache();
    expect(previewRoute(state(['v0']), cache, 'v3')).toEqual({ kind: 'walk' });
  });

  it('counts the doors through a found door room, and says when one changes maps', async () => {
    const cache = await loadCache();
    expect(previewRoute(state(['v0', 'v2']), cache, 'g1')).toEqual({ kind: 'doors', doors: 1, otherMap: true });
  });

  it('goes round a door the viewer is locked out of', async () => {
    const cache = await loadCache();
    expect(previewRoute(state(['v2', 'v3', 'g1']), cache, 'v9')).toEqual({ kind: 'doors', doors: 2, otherMap: true });
  });

  it('names the lock of the only door the viewer knows', async () => {
    const cache = await loadCache();
    const route = previewRoute(state(['v2', 'v3']), cache, 'v9');
    expect(route.kind).toBe('locked');
    expect(routePreviewLines(route, state(['v2', 'v3']))).toEqual([LOCKED_DOOR_WAY_TEXT, "Needs level 9 (you're level 1)"]);
  });

  it('uses only the doors the viewer has found', async () => {
    const cache = await loadCache();
    expect(previewRoute(state(['v0']), cache, 'g1')).toEqual({ kind: 'none' });
    expect(previewRoute(state(['v0', 'v2']), cache, 'p0')).toEqual({ kind: 'none' });
  });

  it('treats a room it cannot place as a walk, so Go is never withheld on a guess', async () => {
    const cache = await loadCache();
    expect(previewRoute(state(['v0']), cache, 'gone')).toEqual({ kind: 'walk' });
    expect(previewRoute({ ...state(['v0']), party: { col: 5, row: 5, state: 'idle', path: [] } }, cache, 'g1')).toEqual({ kind: 'walk' });
  });
});

describe('routePreviewLines', () => {
  it('says how the way goes, and nothing for a walk', () => {
    expect(routePreviewLines({ kind: 'doors', doors: 1, otherMap: false }, null)).toEqual(['Through 1 door']);
    expect(routePreviewLines({ kind: 'doors', doors: 3, otherMap: true }, null)).toEqual(['Through 3 doors']);
    expect(routePreviewLines({ kind: 'none' }, null)).toEqual([NO_KNOWN_WAY_TEXT]);
    expect(routePreviewLines({ kind: 'walk' }, null)).toEqual([]);
    expect(routePreviewLines(null, null)).toEqual([]);
  });
});
