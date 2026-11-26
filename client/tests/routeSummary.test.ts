import { describe, expect, it } from 'vitest';
import type { ServerPartyRoute, ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../src/network/WorldCache';
import { destinationName, isTravelling, routeCountText, routeSummary } from '../src/ui/routeSummary';

const onMap: Record<string, { id: string; name: string }> = {
  '2,0': { id: 'r-known', name: 'Known Place' },
  '3,0': { id: 'r-secret', name: 'Secret Place' },
};
const byId: Record<string, { id: string; name: string }> = {
  'r-far': { id: 'r-far', name: 'Far Hall' },
  'r-fog': { id: 'r-fog', name: 'Fogged Hall' },
};
const world = {
  getTileOn: (_mapId: string, col: number, row: number) => onMap[`${col},${row}`],
  getTileByGuid: (id: string) => byId[id],
} as unknown as Pick<WorldCache, 'getTileOn' | 'getTileByGuid'>;

const ROUTE: ServerPartyRoute = { destinationId: 'r-far', destinationMapId: 'm2', doors: 2, rooms: 9, leavesMap: true };

function state(path: { col: number; row: number }[], route?: ServerPartyRoute): ServerStateMessage {
  return {
    currentMapId: 'm1',
    unlocked: ['r-known', 'r-far'],
    party: { col: 0, row: 0, state: 'idle', path, ...(route ? { route } : {}) },
  } as unknown as ServerStateMessage;
}

describe('route summary', () => {
  it('counts a walk as today', () => {
    const walk = state([{ col: 1, row: 0 }, { col: 2, row: 0 }]);
    expect(routeSummary(walk, world)).toBe('Known Place · 2 rooms');
    expect(routeSummary(state([{ col: 3, row: 0 }]), world)).toBe('1 room');
  });

  it('names a route\'s destination once found, with every room and door still ahead', () => {
    expect(routeSummary(state([{ col: 1, row: 0 }], ROUTE), world)).toBe('Far Hall · 9 rooms · 2 doors');
    const fogged = { ...ROUTE, destinationId: 'r-fog', doors: 1, rooms: 1 };
    expect(destinationName(state([], fogged), world)).toBeNull();
    expect(routeCountText(state([], fogged).party)).toBe('1 room · 1 door');
  });

  it('is travelling in a door room with the leg already walked', () => {
    expect(isTravelling(state([]).party)).toBe(false);
    expect(isTravelling(state([], ROUTE).party)).toBe(true);
    expect(isTravelling(state([{ col: 1, row: 0 }]).party)).toBe(true);
  });
});
