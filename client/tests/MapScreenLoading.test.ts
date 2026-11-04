import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';
import { dismissMapToast } from '../src/ui/MapToast';

const mapStub = vi.hoisted(() => ({
  instances: [] as unknown[],
  failNext: false,
}));

vi.mock('../src/ui/ThreeWorldMap', () => {
  class ThreeWorldMap {
    tap?: (info: unknown) => void;
    background?: () => void;
    setSendMove = vi.fn();
    setOnTileClick = vi.fn((fn: (info: unknown) => void) => { this.tap = fn; });
    setOnBackgroundClick = vi.fn((fn: () => void) => { this.background = fn; });
    setOnFollowChange = vi.fn();
    setSelectedRoom = vi.fn();
    revealRoom = vi.fn();
    focusOn = vi.fn();
    applyServerState = vi.fn();
    getTileInfo = vi.fn(() => null);
    countOthersAt = vi.fn(() => 0);
    pause = vi.fn();
    resume = vi.fn();
    recenterOnPlayer = vi.fn();
    constructor() {
      if (mapStub.failNext) {
        mapStub.failNext = false;
        throw new Error('no webgl');
      }
      mapStub.instances.push(this);
    }
  }
  return { ThreeWorldMap };
});

import { MapScreen } from '../src/screens/MapScreen';

function info(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    col: 3, row: 4, tileType: 'Plains', zoneName: 'Zone', roomName: 'Room', zoneId: 'z',
    isTraversable: true, isUnlocked: true, isSameZone: true, isCurrentTile: false, playersHere: [], partyMemberUsernames: [],
    ...overrides,
  };
}

function mount(lastState: unknown = null) {
  document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
  const gameClient = {
    lastState,
    isInitialState: false,
    onMoveBlocked: () => () => {},
    onServerError: () => () => {},
    onForecast: () => () => {},
    subscribe: () => () => {},
    sendMove: vi.fn(),
    requestForecast: () => null,
    peekForecast: () => null,
  } as unknown as GameClient;
  const worldCache = {
    isLoaded: true,
    getTile: () => ({ id: 'room-1', type: 'plains' }),
    getTileOn: () => undefined,
    getTileByGuid: (id: string) => (id === 'room-1' ? { col: 3, row: 4, mapId: 'here' } : id === 'far' ? { col: 1, row: 1, mapId: 'there' } : undefined),
    getCurrentMapId: () => 'here',
    getNpc: () => undefined,
    getDungeon: () => undefined,
    getMaps: () => [],
  } as unknown as WorldCache;
  return { screen: new MapScreen('map-screen', gameClient, worldCache), gameClient };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const tick = async () => { for (let i = 0; i < 5; i++) await flush(); };
type StubMap = { tap: (i: TileClickInfo) => void; background: () => void; setSelectedRoom: ReturnType<typeof vi.fn>; revealRoom: ReturnType<typeof vi.fn>; focusOn: ReturnType<typeof vi.fn>; getTileInfo: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
const latestMap = () => mapStub.instances[mapStub.instances.length - 1] as StubMap;

describe('MapScreen map loading', () => {
  beforeEach(() => { mapStub.instances.length = 0; mapStub.failNext = false; });
  afterEach(() => dismissMapToast());

  it('creates one map however often the tab is reopened during the import', async () => {
    const { screen } = mount();
    screen.onActivate();
    screen.onDeactivate();
    screen.onActivate();
    screen.onActivate();
    await tick();
    expect(mapStub.instances).toHaveLength(1);
    expect(document.querySelector<HTMLElement>('.map-status-card')!.hidden).toBe(true);
  });

  it('parks the map if the player left before it finished loading', async () => {
    const { screen } = mount();
    screen.onActivate();
    screen.onDeactivate();
    await tick();
    expect(latestMap().pause).toHaveBeenCalled();
  });

  it('offers a retry when the map cannot start, and the retry can succeed', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mapStub.failNext = true;
    const { screen } = mount();
    screen.onActivate();
    await tick();
    const card = document.querySelector<HTMLElement>('.map-status-card')!;
    expect(card.hidden).toBe(false);
    expect(mapStub.instances).toHaveLength(0);

    card.querySelector<HTMLElement>('.map-status-retry')!.click();
    await tick();
    expect(mapStub.instances).toHaveLength(1);
    expect(card.hidden).toBe(true);
    warn.mockRestore();
  });
});

describe('MapScreen room selection', () => {
  beforeEach(() => { mapStub.instances.length = 0; mapStub.failNext = false; });
  afterEach(() => dismissMapToast());

  async function opened(lastState: unknown = { party: { col: 0, row: 0 }, unlocked: [], social: null }) {
    const mounted = mount(lastState);
    mounted.screen.onActivate();
    await tick();
    return { ...mounted, map: latestMap() };
  }

  const sheet = () => document.querySelector<HTMLElement>('.room-sheet')!;

  it('first tap selects, second tap on the same room walks there', async () => {
    const { map, gameClient } = await opened();
    map.tap(info());
    expect(sheet().hidden).toBe(false);
    expect(map.setSelectedRoom).toHaveBeenLastCalledWith({ col: 3, row: 4 });
    expect(map.revealRoom).toHaveBeenCalled();
    expect(gameClient.sendMove).not.toHaveBeenCalled();

    map.tap(info());
    expect(gameClient.sendMove).toHaveBeenCalledWith(3, 4);
    expect(sheet().hidden).toBe(true);
    expect(map.setSelectedRoom).toHaveBeenLastCalledWith(null);
  });

  it('your own room opens the room card, not the sheet', async () => {
    const { map } = await opened();
    map.tap(info({ isCurrentTile: true }));
    expect(sheet().hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.room-view-overlay')!.style.display).toBe('flex');
  });

  it('a tap on the sea dismisses', async () => {
    const { map } = await opened();
    map.tap(info());
    map.background();
    expect(sheet().hidden).toBe(true);
  });

  it('keeps the refusal and the selection when the party cannot move', async () => {
    const { map, gameClient } = await opened({
      username: 'me',
      party: { col: 0, row: 0 },
      unlocked: [],
      social: { party: { members: [{ username: 'me', role: 'member' }] } },
    });
    map.tap(info());
    map.tap(info());
    expect(gameClient.sendMove).not.toHaveBeenCalled();
    expect(sheet().hidden).toBe(false);
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('Only the party owner or a leader can move');
  });

  it('locks travel inside a dungeon, on the sheet and on a second tap', async () => {
    const { map, gameClient } = await opened({ party: { col: 0, row: 0 }, unlocked: [], social: null, dungeon: { name: 'Caves' } });
    map.tap(info());
    expect(document.querySelector<HTMLButtonElement>('.room-sheet-go')!.disabled).toBe(true);
    map.tap(info());
    expect(gameClient.sendMove).not.toHaveBeenCalled();
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('Leave the dungeon before traveling');
  });

  it('focusRoom pans to the room and selects it, even before the map has loaded', async () => {
    const { screen } = mount({ party: { col: 0, row: 0 }, unlocked: [], social: null });
    screen.focusRoom('room-1');
    screen.onActivate();

    await tick();
    const map = latestMap();
    expect(map.focusOn).toHaveBeenCalledWith(3, 4);
  });

  it('focusRoom refuses a room on another map', async () => {
    const { screen, map } = await opened();
    screen.focusRoom('far');
    expect(map.focusOn).not.toHaveBeenCalled();
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('That room is on another map');
  });

  it('closes the sheet when leaving the tab', async () => {
    const { screen, map } = await opened();
    map.tap(info());
    screen.onDeactivate();
    expect(sheet().hidden).toBe(true);
  });
});
