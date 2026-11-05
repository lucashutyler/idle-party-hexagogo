import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';
import { dismissMapToast } from '../src/ui/MapToast';
import { dismissModals, dismissTop } from '../src/ui/ModalStack';
import { OFFLINE_NOTICE } from '../src/network/GameClient';

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
    panBy = vi.fn();
    adjustZoom = vi.fn();
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

let stateListeners: ((state: unknown) => void)[] = [];

function mount(lastState: unknown = null) {
  stateListeners = [];
  document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
  const gameClient = {
    lastState,
    isInitialState: false,
    onMoveBlocked: () => () => {},
    onServerError: () => () => {},
    onForecast: () => () => {},
    subscribe: vi.fn((listener: (state: unknown) => void) => { stateListeners.push(listener); return () => {}; }),
    sendMove: vi.fn(() => true),
    sendEnterTransition: vi.fn(() => true),
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
type StubMap = { tap: (i: TileClickInfo) => void; background: (blocked?: boolean) => void; setSelectedRoom: ReturnType<typeof vi.fn>; revealRoom: ReturnType<typeof vi.fn>; focusOn: ReturnType<typeof vi.fn>; getTileInfo: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
const latestMap = () => mapStub.instances[mapStub.instances.length - 1] as StubMap;

const resizeObservers: (() => void)[] = [];
vi.stubGlobal('ResizeObserver', class {
  constructor(callback: () => void) { resizeObservers.push(callback); }
  observe() {}
  disconnect() {}
});

describe('MapScreen map loading', () => {
  beforeEach(() => { mapStub.instances.length = 0; mapStub.failNext = false; });
  afterEach(() => dismissMapToast());

  it('waits for the tab to be shown before fetching the map code', () => {
    const original = window.requestIdleCallback;
    const askForIdleTime = vi.fn(() => 1);
    vi.stubGlobal('requestIdleCallback', askForIdleTime);
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      mount();
      expect(askForIdleTime).not.toHaveBeenCalled();

      Reflect.deleteProperty(document, 'visibilityState');
      document.dispatchEvent(new Event('visibilitychange'));
      expect(askForIdleTime).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(document, 'visibilityState');
      vi.stubGlobal('requestIdleCallback', original);
    }
  });

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

describe('MapScreen keyboard', () => {
  beforeEach(() => { mapStub.instances.length = 0; mapStub.failNext = false; });

  const press = (key: string, target: Element) => {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    target.dispatchEvent(event);
    return event;
  };

  it('pans, zooms and recentres while the map itself has focus', async () => {
    const { screen } = mount();
    screen.onActivate();
    await tick();
    const map = latestMap() as unknown as Record<'panBy' | 'adjustZoom' | 'recenterOnPlayer', ReturnType<typeof vi.fn>>;
    const container = document.getElementById('game-container')!;

    expect(container.tabIndex).toBe(0);
    expect(press('ArrowLeft', container).defaultPrevented).toBe(true);
    expect(map.panBy).toHaveBeenCalledWith(-80, 0);
    press('ArrowDown', container);
    expect(map.panBy).toHaveBeenLastCalledWith(0, 80);
    press('+', container);
    expect(map.adjustZoom).toHaveBeenLastCalledWith(1);
    press('-', container);
    expect(map.adjustZoom).toHaveBeenLastCalledWith(-1);
    press('Home', container);
    expect(map.recenterOnPlayer).toHaveBeenCalled();
    expect(press('a', container).defaultPrevented).toBe(false);
  });

  it('leaves keys alone when focus is on a control inside the map', async () => {
    const { screen } = mount();
    screen.onActivate();
    await tick();
    const map = latestMap() as unknown as Record<'panBy', ReturnType<typeof vi.fn>>;
    const control = document.createElement('button');
    document.getElementById('game-container')!.appendChild(control);

    expect(press('ArrowLeft', control).defaultPrevented).toBe(false);
    expect(map.panBy).not.toHaveBeenCalled();
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

  it('says so when a blocked room is tapped, and only then', async () => {
    const { map } = await opened();
    map.tap(info());
    map.background();
    expect(sheet().hidden).toBe(true);
    expect(document.querySelector('#map-screen .map-toast')).toBeNull();

    map.background(true);
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe("You can't walk there");
  });

  it('keeps the sheet open and says why when Go finds the socket closed', async () => {
    const { map, gameClient } = await opened();
    vi.mocked(gameClient.sendMove).mockReturnValue(false);
    map.tap(info());
    map.tap(info());
    expect(sheet().hidden).toBe(false);
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe(OFFLINE_NOTICE);
  });

  it('dismisses the sheet when the party changes map', async () => {
    const state = { party: { col: 0, row: 0, path: [] }, unlocked: [], social: null, currentMapId: 'here', otherPlayers: [] };
    const { map, gameClient } = await opened(state);
    map.getTileInfo.mockReturnValue(info());
    map.tap(info());
    expect(sheet().hidden).toBe(false);

    const moved = { ...state, currentMapId: 'there' };
    (gameClient as unknown as { lastState: unknown }).lastState = moved;
    for (const listener of stateListeners) listener(moved);
    expect(sheet().hidden).toBe(true);
    expect(map.setSelectedRoom).toHaveBeenLastCalledWith(null);
  });

  it('works out the sheet layout and what fits from the screen size, also without a state push', async () => {
    const { map } = await opened();
    const screen = document.getElementById('map-screen')!;
    Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 375 });
    Object.defineProperty(screen, 'clientHeight', { configurable: true, value: 417 });
    map.tap(info());
    expect(screen.dataset.sheet).toBe('bottom');
    expect(screen.dataset.controls).toBe('full');

    Object.defineProperty(screen, 'clientHeight', { configurable: true, value: 149 });
    map.tap(info({ col: 5 }));
    expect(screen.dataset.controls).toBe('none');

    Object.defineProperty(screen, 'clientHeight', { configurable: true, value: 261 });
    map.tap(info({ col: 6 }));
    expect(screen.dataset.controls).toBe('some');

    Object.defineProperty(screen, 'clientWidth', { configurable: true, value: 800 });
    resizeObservers[resizeObservers.length - 1]();
    expect(screen.dataset.sheet).toBe('side');
    expect(screen.dataset.controls).toBe('full');
    expect(map.revealRoom).toHaveBeenLastCalledWith(6, 4, { right: 320, bottom: 0 });
  });

  it('an open room card closes with the other modals, as a chat DM asks', async () => {
    const { map } = await opened();
    map.tap(info({ isCurrentTile: true }));
    const card = document.querySelector<HTMLElement>('.room-view-overlay')!;
    expect(card.style.display).toBe('flex');
    dismissModals();
    expect(card.style.display).toBe('none');
  });

  it('closes the sheet when leaving the tab', async () => {
    const { screen, map } = await opened();
    map.tap(info());
    screen.onDeactivate();
    expect(sheet().hidden).toBe(true);
  });
});

describe('MapScreen status chips', () => {
  beforeEach(() => { mapStub.instances.length = 0; mapStub.failNext = false; });
  afterEach(() => {
    dismissMapToast();
    vi.restoreAllMocks();
    while (dismissTop()) { /* drain */ }
  });

  const state = { party: { col: 0, row: 0, path: [] }, unlocked: [], social: null, currentMapId: 'here', character: {}, zoneName: 'Z' };
  const transitionTile = { id: 'room-1', name: 'Pier', transitions: [{ tileId: 'far', mapId: 'there' }] };

  async function withTravelChip(wide: boolean) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('min-width: 768px') && wide,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList);
    const mounted = mount(state);
    Object.assign((mounted.screen as unknown as { worldCache: object }).worldCache, {
      getTileOn: () => transitionTile,
      getTileByGuid: () => ({ name: 'Harbour', mapId: 'there' }),
    });
    mounted.screen.onActivate();
    await tick();
    return mounted;
  }

  it('asks before a one-word chip takes the party away', async () => {
    const { gameClient } = await withTravelChip(false);
    const chip = document.querySelector<HTMLElement>('.room-status-chip')!;
    expect(chip.querySelector('.room-status-chip-short')!.textContent).toBe('Travel');

    chip.click();
    expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
    expect(document.querySelector('.confirm-title')!.textContent).toBe('Travel to Harbour?');

    document.querySelector<HTMLElement>('.confirm-cancel')!.click();
    await tick();
    expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();

    chip.click();
    document.querySelector<HTMLElement>('.confirm-ok')!.click();
    await tick();
    expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
  });

  it('goes straight there where the chip spells the action out', async () => {
    const { gameClient } = await withTravelChip(true);
    document.querySelector<HTMLElement>('.room-status-chip')!.click();
    expect(document.querySelector('.confirm-dialog')).toBeNull();
    expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
  });
});
