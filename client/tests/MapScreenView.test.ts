import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerRouteConfirmMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import type { GameClient } from '../src/network/GameClient';
import { WorldCache } from '../src/network/WorldCache';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';
import { dismissMapToast } from '../src/ui/MapToast';
import { dismissTop } from '../src/ui/ModalStack';

/** A stand-in map that draws the viewed map, else the party's, and counts every bake of a new map. */
const mapStub = vi.hoisted(() => ({
  instances: [] as unknown[],
  tileInfo: null as null | ((mapId: string, col: number, row: number, state: unknown) => unknown),
}));

vi.mock('../src/ui/ThreeWorldMap', () => {
  class ThreeWorldMap {
    tap?: (info: unknown) => void;
    viewed: string | null = null;
    drawnMapId = '';
    bakes = 0;
    isFollowing = true;
    lastState: unknown = null;
    setViewedMap = vi.fn((mapId: string | null) => { this.viewed = mapId; });
    applyServerState = vi.fn((state: { currentMapId: string }) => {
      this.lastState = state;
      const shown = this.viewed ?? state.currentMapId;
      if (shown === this.drawnMapId) return;
      this.drawnMapId = shown;
      this.bakes++;
      if (shown === state.currentMapId) this.isFollowing = true;
    });
    getTileInfo = vi.fn((col: number, row: number) => mapStub.tileInfo?.(this.drawnMapId, col, row, this.lastState) ?? null);
    setOnTileClick = vi.fn((fn: (info: unknown) => void) => { this.tap = fn; });
    setOnBackgroundClick = vi.fn();
    setOnFollowChange = vi.fn();
    setSelectedRoom = vi.fn();
    revealRoom = vi.fn();
    focusOn = vi.fn(() => { this.isFollowing = false; });
    countOthersAt = vi.fn(() => 0);
    pause = vi.fn();
    resume = vi.fn();
    recenterOnPlayer = vi.fn(() => { this.isFollowing = true; });
    panBy = vi.fn();
    adjustZoom = vi.fn();
    setLockCheck = vi.fn();
    rebuildFromCache = vi.fn();
    constructor() {
      mapStub.instances.push(this);
    }
  }
  return { ThreeWorldMap };
});

import { MapScreen } from '../src/screens/MapScreen';

type StubMap = {
  tap: (info: TileClickInfo) => void;
  viewed: string | null;
  drawnMapId: string;
  bakes: number;
  isFollowing: boolean;
  setViewedMap: ReturnType<typeof vi.fn>;
  focusOn: ReturnType<typeof vi.fn>;
};

const room = (id: string, mapId: string, col: number, extra: Record<string, unknown> = {}) =>
  ({ id, mapId, col, row: 0, type: 'plains', zone: `${mapId}-zone`, zoneName: `${mapId} zone`, name: `Room ${id}`, ...extra });

/** Two maps the player knows, joined by one door, and one they have never set foot on. */
const WORLD = {
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
    room('g0', 'grotto', 0),
    room('g1', 'grotto', 1),
    room('g2', 'grotto', 2),
    room('p0', 'peak', 0),
  ],
  tileTypes: { plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true } },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

async function loadCache(world: unknown = WORLD): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/world' ? world : {})));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

function partyState(overrides: Partial<ServerStateMessage> = {}): ServerStateMessage {
  return {
    type: 'state',
    username: 'me',
    currentMapId: 'vale',
    party: { col: 0, row: 0, state: 'idle', path: [] },
    battle: { state: 'battle', visual: 'fighting', duration: 0 },
    unlocked: ['v0', 'v1', 'v2', 'g0', 'g1'],
    otherPlayers: [],
    social: null,
    character: { level: 3, equipment: {} },
    zoneName: 'vale zone',
    ...overrides,
  } as unknown as ServerStateMessage;
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const tick = async () => { for (let i = 0; i < 5; i++) await flush(); };

interface Mounted {
  screen: MapScreen;
  gameClient: GameClient & { sendMoveTo: ReturnType<typeof vi.fn>; requestForecast: ReturnType<typeof vi.fn> };
  cache: WorldCache;
  map: StubMap;
  push: (state: ServerStateMessage) => void;
  confirmRoute: (msg: ServerRouteConfirmMessage) => void;
}

async function mount(state = partyState()): Promise<Mounted> {
  document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
  const cache = await loadCache();
  mapStub.tileInfo = (mapId, col, row, shown) => {
    const def = cache.getTileOn(mapId, col, row);
    if (!def) return null;
    const s = shown as ServerStateMessage | null;
    const unlocked = s?.unlocked?.includes(def.id) ?? false;
    return {
      mapId, tileId: def.id, col, row, tileType: 'Plains', zoneName: def.zoneName ?? '', roomName: unlocked ? def.name : 'Unexplored Room',
      zoneId: def.zone, isTraversable: true, isUnlocked: unlocked, isSameZone: false,
      isCurrentTile: !!s && s.currentMapId === mapId && s.party.col === col && s.party.row === row,
      playersHere: [], partyMemberUsernames: [],
    } satisfies TileClickInfo;
  };
  const stateListeners: ((s: ServerStateMessage) => void)[] = [];
  let routeConfirm: (msg: ServerRouteConfirmMessage) => void = () => {};
  const gameClient = {
    lastState: state,
    lastStateAt: 0,
    isInitialState: false,
    onMoveBlocked: () => () => {},
    onRouteConfirm: (l: (msg: ServerRouteConfirmMessage) => void) => { routeConfirm = l; return () => {}; },
    onServerError: () => () => {},
    onForecast: () => () => {},
    subscribe: vi.fn((l: (s: ServerStateMessage) => void) => { stateListeners.push(l); return () => {}; }),
    sendMoveTo: vi.fn(() => true),
    sendEnterTransition: vi.fn(() => true),
    sendStopTravel: vi.fn(() => true),
    requestForecast: vi.fn(() => null),
    peekForecast: () => null,
  } as unknown as Mounted['gameClient'];
  const screen = new MapScreen('map-screen', gameClient, cache);
  screen.onActivate();
  await tick();
  const map = mapStub.instances[mapStub.instances.length - 1] as StubMap;
  const push = (next: ServerStateMessage) => {
    (gameClient as unknown as { lastState: ServerStateMessage }).lastState = next;
    for (const l of stateListeners) l(next);
  };
  return { screen, gameClient, cache, map, push, confirmRoute: msg => routeConfirm(msg) };
}

const banner = () => document.querySelector<HTMLElement>('.map-view-banner');
const viewing = () => !!banner() && !banner()!.hidden && document.getElementById('map-screen')!.dataset.viewing === '1';
const sheetOpen = () => !document.querySelector<HTMLElement>('.room-sheet')!.hidden;
const toast = () => document.querySelector('#map-screen .map-toast')?.textContent;
const tapRoom = (m: Mounted, col: number) => m.map.tap((m.map as unknown as { getTileInfo: (c: number, r: number) => TileClickInfo }).getTileInfo(col, 0));

async function openMaps(): Promise<HTMLElement[]> {
  document.querySelector<HTMLElement>('.map-maps-btn')!.click();
  await vi.waitFor(() => { if (!document.querySelector('.map-list-item')) throw new Error('no list yet'); });
  return [...document.querySelectorAll<HTMLElement>('.map-list-item')];
}

async function viewGrotto(_m: Mounted): Promise<void> {
  (await openMaps()).find(item => item.dataset.mapId === 'grotto')!.click();
  await tick();
}

describe('Looking at another map', () => {
  beforeEach(() => { mapStub.instances.length = 0; });
  afterEach(() => {
    dismissMapToast();
    while (dismissTop()) { /* drain */ }
    vi.unstubAllGlobals();
  });

  it('lists the party\'s map first, then only maps with a found room, each with how much is found', async () => {
    await mount();
    const items = await openMaps();
    expect(items.map(item => item.dataset.mapId)).toEqual(['vale', 'grotto']);
    expect(items[0].textContent).toContain('Your party is here');
    expect(items[0].querySelector('.map-list-count')!.textContent).toBe('3 of 3 rooms');
    expect(items[1].querySelector('.map-list-count')!.textContent).toBe('2 of 3 rooms');
    expect(document.querySelector('.map-list-modal')!.getAttribute('aria-label')).toBe('Maps');
  });

  it('shows the picked map with a banner back to the party, centred on its found rooms', async () => {
    const m = await mount();
    await viewGrotto(m);
    expect(m.map.drawnMapId).toBe('grotto');
    expect(viewing()).toBe(true);
    expect(banner()!.querySelector('.map-view-name')!.textContent).toBe('Grotto');
    expect(m.map.focusOn).toHaveBeenLastCalledWith(0, 0);
    expect(document.querySelector('.map-list-modal')).toBeNull();

    banner()!.querySelector<HTMLElement>('.map-view-name')!.click();
    await vi.waitFor(() => { if (!document.querySelector('.map-list-modal')) throw new Error('no list yet'); });
    expect(document.querySelector('.map-list-item[aria-current="true"]')!.getAttribute('data-map-id')).toBe('grotto');
  });

  it('sends Go off the party\'s map by room id alone, and on it with the room\'s place too', async () => {
    const m = await mount();
    tapRoom(m, 1);
    tapRoom(m, 1);
    expect(m.gameClient.sendMoveTo).toHaveBeenLastCalledWith('v1', { col: 1, row: 0 });

    await viewGrotto(m);
    tapRoom(m, 1);
    tapRoom(m, 1);
    expect(m.gameClient.sendMoveTo).toHaveBeenLastCalledWith('g1', undefined);
    expect(viewing()).toBe(true);
  });

  it('asks for no forecast off the party\'s map', async () => {
    const m = await mount();
    await viewGrotto(m);
    tapRoom(m, 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(document.querySelector<HTMLElement>('.room-sheet-forecast')!.hidden).toBe(true);
    expect(m.gameClient.requestForecast).not.toHaveBeenCalled();
  });

  it('closes an open sheet on Back first, then the view', async () => {
    const m = await mount();
    await viewGrotto(m);
    tapRoom(m, 1);
    expect(sheetOpen()).toBe(true);

    dismissTop();
    expect(sheetOpen()).toBe(false);
    expect(viewing()).toBe(true);

    dismissTop();
    expect(viewing()).toBe(false);
    expect(m.map.drawnMapId).toBe('vale');
    expect(m.map.setViewedMap).toHaveBeenLastCalledWith(null);
  });

  it.each([
    ['Home', (m: Mounted) => {
      document.getElementById('game-container')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
      return m;
    }],
    ['the recentre button', (m: Mounted) => { document.querySelector<HTMLElement>('.map-recenter')!.click(); return m; }],
    ['a second tap on the Map tab', (m: Mounted) => { m.screen.recenterOnPlayer(); return m; }],
    ['the banner', (m: Mounted) => { banner()!.querySelector<HTMLElement>('.map-view-back')!.click(); return m; }],
  ])('ends the view on %s', async (_name, act) => {
    const m = await mount();
    await viewGrotto(m);
    act(m);
    expect(viewing()).toBe(false);
    expect(m.map.drawnMapId).toBe('vale');
  });

  it('keeps the view across a tab switch, with no new bake', async () => {
    const m = await mount();
    await viewGrotto(m);
    const bakes = m.map.bakes;
    m.screen.onDeactivate();
    m.screen.onActivate();
    expect(m.map.drawnMapId).toBe('grotto');
    expect(m.map.bakes).toBe(bakes);
    expect(viewing()).toBe(true);

    dismissTop();
    expect(viewing()).toBe(false);
  });

  it('ends the view quietly when the party arrives on the viewed map', async () => {
    const m = await mount();
    await viewGrotto(m);
    const bakes = m.map.bakes;
    m.push(partyState({ currentMapId: 'grotto', party: { col: 0, row: 0, state: 'idle', path: [] } }));
    expect(viewing()).toBe(false);
    expect(m.map.drawnMapId).toBe('grotto');
    expect(m.map.bakes).toBe(bakes);
    expect(m.map.setViewedMap).toHaveBeenLastCalledWith(null);
  });

  it('keeps the old map in view when the party crosses while a sheet is open, and says where it went', async () => {
    const m = await mount();
    m.push(partyState());
    tapRoom(m, 1);
    m.push(partyState({ currentMapId: 'grotto' }));
    expect(m.map.drawnMapId).toBe('vale');
    expect(sheetOpen()).toBe(true);
    expect(viewing()).toBe(true);
    expect(toast()).toBe('Your party traveled to Grotto.');
  });

  it('follows the party across when the player is just watching it', async () => {
    const m = await mount();
    m.push(partyState());
    m.push(partyState({ currentMapId: 'grotto' }));
    expect(m.map.drawnMapId).toBe('grotto');
    expect(viewing()).toBe(false);
  });

  it('ends the view when the viewed map is removed', async () => {
    const m = await mount();
    await viewGrotto(m);
    const world = { ...WORLD, maps: WORLD.maps.filter(map => map.id !== 'grotto'), tiles: WORLD.tiles.filter(t => t.mapId !== 'grotto') };
    vi.stubGlobal('fetch', vi.fn(async (url: string) => json(url === '/api/world' ? world : {})));
    await m.cache.loadWorld();
    m.screen.refreshWorld();
    expect(viewing()).toBe(false);
    expect(m.map.drawnMapId).toBe('vale');
  });

  it('opens a room on another visited map from focusRoom, and refuses one on a map never visited', async () => {
    const m = await mount();
    m.screen.focusRoom('g1');
    expect(m.map.drawnMapId).toBe('grotto');
    expect(m.map.focusOn).toHaveBeenLastCalledWith(1, 0);
    expect(sheetOpen()).toBe(true);

    m.screen.focusRoom('p0');
    expect(toast()).toBe("You haven't visited that map yet.");
    expect(m.map.drawnMapId).toBe('grotto');

    m.screen.focusRoom('v1');
    expect(m.map.drawnMapId).toBe('vale');
    expect(viewing()).toBe(false);
  });

  it('asks before a route the server warns about, and Go sends it again accepted', async () => {
    const m = await mount();
    m.confirmRoute({
      type: 'route_confirm',
      tileId: 'g1',
      warnings: [{ kind: 'hires_leave', names: ['Brin', 'Ode'], mapName: 'Vale' }, { kind: 'no_way_back' }],
    });
    expect(document.querySelector('.confirm-title')!.textContent).toBe('Set off?');
    expect(document.querySelector('.confirm-body')!.textContent)
      .toBe('Your hired fighters (Brin, Ode) stay behind when your party leaves Vale. Your party knows no way back from there.');
    expect(document.querySelector('.confirm-ok')!.textContent).toBe('Go');
    document.querySelector<HTMLElement>('.confirm-ok')!.click();
    await tick();
    expect(m.gameClient.sendMoveTo).toHaveBeenCalledWith('g1', undefined, ['hires_leave', 'no_way_back']);
  });

  it('sends nothing when the route is called off', async () => {
    const m = await mount();
    m.confirmRoute({ type: 'route_confirm', tileId: 'v1', warnings: [{ kind: 'no_way_back' }] });
    document.querySelector<HTMLElement>('.confirm-cancel')!.click();
    await tick();
    expect(m.gameClient.sendMoveTo).not.toHaveBeenCalled();
  });
});
