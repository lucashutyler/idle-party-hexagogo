import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { WorldCache } from '../src/network/WorldCache';
import { isLevelDanger, levelBandText, partyBestLevel, travelLevelNote } from '../src/ui/roomLevels';

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

const room = (id: string, zone: string, extra: Record<string, unknown> = {}) =>
  ({ id, mapId: 'isle', col: 0, row: 0, type: 'plains', zone, name: id, ...extra });

async function loadCache(world: Record<string, unknown>): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/world'
    ? { startTile: { col: 0, row: 0 }, maps: [{ id: 'isle', name: 'Gull Isle', startTile: { col: 0, row: 0 } }], ...world }
    : {})));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

function state(level: number, others: { username: string; level?: number }[] = []): ServerStateMessage {
  return {
    username: 'me',
    character: { level },
    social: { party: { members: [{ username: 'me', level }, ...others] } },
  } as unknown as ServerStateMessage;
}

describe('WorldCache.getRoomLevels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it("takes a room's own band, else its zone's, and none for a room whose own table has no authored level", async () => {
    const own = room('own', 'shore', { levels: [16, 17], encounterTable: [{ encounterId: 'e', weight: 1 }] });
    const zoned = room('zoned', 'shore');
    const unrated = room('unrated', 'shore', { encounterTable: [{ encounterId: 'e', weight: 1 }] });
    const nowhere = room('nowhere', 'cliffs');
    const cache = await loadCache({ tiles: [own, zoned, unrated, nowhere], zoneLevels: { shore: [3, 5] } });
    expect(cache.getRoomLevels(cache.getTileByGuid('own')!)).toEqual([16, 17]);
    expect(cache.getRoomLevels(cache.getTileByGuid('zoned')!)).toEqual([3, 5]);
    expect(cache.getRoomLevels(cache.getTileByGuid('unrated')!)).toBeUndefined();
    expect(cache.getRoomLevels(cache.getTileByGuid('nowhere')!)).toBeUndefined();
  });

  it('knows no levels from an older server that sends none', async () => {
    const cache = await loadCache({ tiles: [room('zoned', 'shore')] });
    expect(cache.getRoomLevels(cache.getTileByGuid('zoned')!)).toBeUndefined();
  });

  it('never reads a zone named after an object built-in', async () => {
    const cache = await loadCache({ tiles: [room('odd', 'constructor')], zoneLevels: {} });
    expect(cache.getRoomLevels(cache.getTileByGuid('odd')!)).toBeUndefined();
  });
});

describe('room level text', () => {
  it('says one level or the band', () => {
    expect(levelBandText([16, 16])).toBe('Lv 16');
    expect(levelBandText([16, 17])).toBe('Lv 16–17');
  });

  it("takes the party's best player, never before the character loads", () => {
    expect(partyBestLevel(state(6))).toBe(6);
    expect(partyBestLevel(state(6, [{ username: 'bob', level: 9 }, { username: 'cat' }]))).toBe(9);
    expect(partyBestLevel(null)).toBeNull();
    expect(partyBestLevel({ username: 'me', character: null, social: null } as unknown as ServerStateMessage)).toBeNull();
  });

  it('warns only past the levels that still pay more', () => {
    expect(isLevelDanger([12, 12], 6)).toBe(true);
    expect(isLevelDanger([11, 14], 6)).toBe(false);
    expect(isLevelDanger([30, 30], null)).toBe(false);
  });

  it('compares the monsters with you alone, or with the best of your party', () => {
    expect(travelLevelNote([16, 16], state(6))).toEqual({ text: "Monsters there are level 16. You're level 6.", danger: true });
    expect(travelLevelNote([11, 12], state(6))).toEqual({ text: "Monsters there are level 11–12. You're level 6.", danger: false });
    expect(travelLevelNote([16, 17], state(6, [{ username: 'bob', level: 8 }])))
      .toEqual({ text: "Monsters there are level 16–17. Your party's best is level 8.", danger: true });
    expect(travelLevelNote(undefined, state(6))).toBeNull();
    expect(travelLevelNote([16, 16], null)).toBeNull();
  });
});
