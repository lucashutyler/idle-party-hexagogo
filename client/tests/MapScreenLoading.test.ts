import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';
import { dismissMapToast } from '../src/ui/MapToast';
import { dismissModals, dismissTop } from '../src/ui/ModalStack';
import { OFFLINE_NOTICE } from '../src/network/GameClient';
import { buildRouteIndex } from '@idle-party-rpg/shared';
import type { RouteRoom } from '@idle-party-rpg/shared';

const mapStub = vi.hoisted(() => ({
  instances: [] as unknown[],
  failNext: false,
}));

vi.mock('../src/ui/ThreeWorldMap', () => {
  class ThreeWorldMap {
    tap?: (info: unknown) => void;
    background?: () => void;
    drawnMapId = 'here';
    isFollowing = true;
    setViewedMap = vi.fn();
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
    setLockCheck = vi.fn();
    setTrackedRoom = vi.fn();
    setOnTrackedRoomClick = vi.fn();
    setEdgeArrowInsets = vi.fn();
    avoidWithEdgeArrow = vi.fn();
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

import { LOCK_INSPECT_DEBOUNCE_MS, LOCK_REFRESH_MS, MapScreen, ORDER_ANSWER_MS } from '../src/screens/MapScreen';
import { SETTING_OFF_TEXT } from '../src/ui/RoomSheet';
import { NO_KNOWN_WAY_TEXT } from '../src/ui/routePreview';

function info(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    mapId: 'here', tileId: 'room-1', col: 3, row: 4, tileType: 'Plains', zoneName: 'Zone', roomName: 'Room', zoneId: 'z',
    isTraversable: true, isUnlocked: true, isSameZone: true, isCurrentTile: false, playersHere: [], partyMemberUsernames: [],
    ...overrides,
  };
}

let stateListeners: ((state: unknown) => void)[] = [];
let moveBlockedListeners: ((msg: unknown) => void)[] = [];
let lockInfoListeners: ((msg: unknown) => void)[] = [];
let connectionListeners: ((connected: boolean) => void)[] = [];
const PARTY_ROOM = { id: 'party-room', mapId: 'here', col: 0, row: 0, type: 'plains' };

function mount(lastState: unknown = null, tile: Record<string, unknown> = { id: 'room-1', type: 'plains' }, routeRooms: RouteRoom[] = []) {
  stateListeners = [];
  moveBlockedListeners = [];
  lockInfoListeners = [];
  connectionListeners = [];
  document.body.innerHTML = '<div id="map-screen"></div><div id="game-container"></div>';
  const gameClient: Record<string, unknown> = {
    lastState,
    isInitialState: false,
    onMoveBlocked: (l: (msg: unknown) => void) => { moveBlockedListeners.push(l); return () => {}; },
    onRouteConfirm: (l: (msg: unknown) => void) => { gameClient.routeConfirm = l; return () => {}; },
    onLockInfo: (l: (msg: unknown) => void) => { lockInfoListeners.push(l); return () => {}; },
    onConnection: (l: (connected: boolean) => void) => { connectionListeners.push(l); return () => {}; },
    onServerError: () => () => {},
    onForecast: () => () => {},
    subscribe: vi.fn((listener: (state: unknown) => void) => { stateListeners.push(listener); return () => {}; }),
    sendMoveTo: vi.fn(() => true),
    sendEnterTransition: vi.fn(() => true),
    sendInspectLock: vi.fn(() => true),
    requestForecast: () => null,
    peekForecast: () => null,
  };
  const index = buildRouteIndex(routeRooms);
  const worldCache = {
    isLoaded: true,
    getTileOn: (mapId: string, col: number, row: number) => (mapId === 'here' && col === 0 && row === 0 ? PARTY_ROOM : tile),
    getTileByGuid: (id: string) => (id === 'room-1' ? { col: 3, row: 4, mapId: 'here' } : id === 'far' ? { col: 1, row: 1, mapId: 'there' } : undefined),
    getCurrentMapId: () => 'here',
    getNpc: () => undefined,
    getDungeon: () => undefined,
    getMaps: () => [],
    getTileTypeDef: () => undefined,
    routeIndex: () => index,
    viewableMapIds: () => new Set(['here']),
    roomsFoundByMap: () => new Map(),
    getRoomLevels: (def: { levels?: [number, number] }) => def.levels,
  } as unknown as WorldCache;
  const client = gameClient as unknown as GameClient;
  return { screen: new MapScreen('map-screen', client, worldCache), gameClient: client };
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0));
const tick = async () => { for (let i = 0; i < 5; i++) await flush(); };
type StubMap = { tap: (i: TileClickInfo) => void; background: (blocked?: boolean) => void; setSelectedRoom: ReturnType<typeof vi.fn>; setLockCheck: ReturnType<typeof vi.fn>; revealRoom: ReturnType<typeof vi.fn>; focusOn: ReturnType<typeof vi.fn>; getTileInfo: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> };
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

  async function opened(lastState: unknown = { party: { col: 0, row: 0 }, unlocked: [], social: null, currentMapId: 'here' }, tile?: Record<string, unknown>, routeRooms?: RouteRoom[]) {
    const mounted = mount(lastState, tile, routeRooms);
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
    expect(gameClient.sendMoveTo).not.toHaveBeenCalled();

    map.tap(info());
    expect(gameClient.sendMoveTo).toHaveBeenCalledWith('room-1', { col: 3, row: 4 });
  });

  it('keeps the edge arrow clear of the docked sheet and of the controls over the map', async () => {
    const { map } = await opened();
    const edge = map as unknown as { setEdgeArrowInsets: ReturnType<typeof vi.fn>; avoidWithEdgeArrow: ReturnType<typeof vi.fn> };
    const avoided = edge.avoidWithEdgeArrow.mock.calls.map(([el]) => (el as HTMLElement).className);
    expect(avoided).toEqual(expect.arrayContaining(['map-zoom-controls', 'room-status', 'map-route-chip']));

    map.tap(info());
    expect(edge.setEdgeArrowInsets).toHaveBeenLastCalledWith({ right: 0, bottom: 112 });
    map.background();
    expect(edge.setEdgeArrowInsets).toHaveBeenLastCalledWith({ right: 0, bottom: 0 });
  });

  describe('Go waits for the server with the sheet up', () => {
    const here = { username: 'me', party: { col: 0, row: 0, state: 'idle', path: [] }, unlocked: [], social: null, currentMapId: 'here', otherPlayers: [] };
    const go = () => document.querySelector<HTMLButtonElement>('.room-sheet-go')!;
    const push = (state: unknown) => { for (const listener of stateListeners) listener(state); };

    async function sent() {
      const mounted = await opened(here);
      mounted.map.getTileInfo.mockReturnValue(info());
      mounted.map.tap(info());
      mounted.map.tap(info());
      return mounted;
    }

    it('says the party sets off and holds Go until a push shows the party on its way', async () => {
      const { map, gameClient } = await sent();
      expect(sheet().hidden).toBe(false);
      expect(go().textContent).toBe(SETTING_OFF_TEXT);
      expect(go().disabled).toBe(true);
      map.tap(info());
      go().click();
      expect(gameClient.sendMoveTo).toHaveBeenCalledOnce();

      push({ ...here, party: { ...here.party, path: [{ col: 1, row: 1 }] } });
      expect(sheet().hidden).toBe(false);
      push({ ...here, party: { ...here.party, state: 'moving', path: [{ col: 1, row: 1 }, { col: 3, row: 4 }] } });
      expect(sheet().hidden).toBe(true);
      expect(map.setSelectedRoom).toHaveBeenLastCalledWith(null);
    });

    it('closes when the push shows a door route to the room', async () => {
      await sent();
      push({ ...here, party: { ...here.party, path: [{ col: 1, row: 0 }], route: { destinationId: 'room-1', destinationMapId: 'here', doors: 1, rooms: 3, leavesMap: false } } });
      expect(sheet().hidden).toBe(true);
    });

    it('turns into the lock card when the server refuses at a locked room', async () => {
      const lock = { roomId: 'room-1', requirements: [{ kind: 'level', minLevel: 7, members: [{ username: 'me', met: false, level: 2 }] }] };
      await sent();
      for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'level', reason: 'Level 7 is required to enter this room.', missingPlayers: ['me'], lock });
      expect(sheet().hidden).toBe(false);
      expect(sheet().dataset.lock).toBe('1');
      expect(document.querySelector('.lock-card-title')!.textContent).toBe('🔒 Locked');
      expect(go().hidden).toBe(true);
      expect(document.querySelector('#map-screen .map-toast')).toBeNull();
    });

    it('shows a refusal without a card in the sheet, keeping Go', async () => {
      await sent();
      for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'item', reason: 'A Brass Key is required to enter this room.', missingPlayers: ['me'] });
      expect(document.querySelector('.room-sheet-lock-line[data-kind="notice"]')!.textContent).toBe('A Brass Key is required to enter this room.');
      expect(go().hidden).toBe(false);
      expect(go().textContent).toBe('Go');
    });

    it('closes after a while with no answer, and a late refusal is a toast', async () => {
      const { map } = await opened(here);
      map.getTileInfo.mockReturnValue(info());
      vi.useFakeTimers();
      try {
        map.tap(info());
        map.tap(info());
        vi.advanceTimersByTime(ORDER_ANSWER_MS - 1);
        expect(sheet().hidden).toBe(false);
        vi.advanceTimersByTime(1);
        expect(sheet().hidden).toBe(true);

        for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'level', reason: 'Level 7 is required to enter this room.', missingPlayers: ['me'] });
        expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('Level 7 is required to enter this room.');
      } finally {
        vi.useRealTimers();
      }
    });

    it('waits the same way after Go to room in the room card, so a lock refusal becomes the card', async () => {
      const { map, gameClient } = await opened(here);
      map.getTileInfo.mockReturnValue(info());
      map.tap(info());
      document.querySelector<HTMLElement>('.room-sheet-details')!.click();
      document.querySelector<HTMLElement>('.room-view-action-go')!.click();
      expect(gameClient.sendMoveTo).toHaveBeenCalledOnce();
      expect(sheet().hidden).toBe(false);
      expect(go().textContent).toBe(SETTING_OFF_TEXT);

      const lock = { roomId: 'room-1', requirements: [{ kind: 'level', minLevel: 7, members: [{ username: 'me', met: false, level: 2 }] }] };
      for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'level', reason: 'Level 7 is required to enter this room.', missingPlayers: ['me'], lock });
      expect(sheet().dataset.lock).toBe('1');
      expect(document.querySelector('#map-screen .map-toast')).toBeNull();
    });

    it('gives Go back with the offline notice when the connection drops before an answer', async () => {
      const { map } = await opened(here);
      map.getTileInfo.mockReturnValue(info());
      vi.useFakeTimers();
      try {
        map.tap(info());
        map.tap(info());
        for (const listener of connectionListeners) listener(false);
        vi.advanceTimersByTime(ORDER_ANSWER_MS);
        expect(sheet().hidden).toBe(false);
        expect(document.querySelector('.room-sheet-lock-line[data-kind="notice"]')?.textContent).toBe(OFFLINE_NOTICE);
        expect(go().textContent).toBe('Go');
        expect(go().disabled).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });

    it('closes when the server asks first about the route, and the dialog takes over', async () => {
      const { gameClient } = await sent();
      const confirm = (gameClient as unknown as { routeConfirm: (msg: unknown) => void }).routeConfirm;
      confirm({ type: 'route_confirm', tileId: 'room-1', warnings: [{ kind: 'no_way_back' }] });
      expect(sheet().hidden).toBe(true);
      expect(document.querySelector('.confirm-title')!.textContent).toBe('Set off?');
      document.querySelector<HTMLElement>('.confirm-cancel')!.click();
    });
  });

  it('says on the sheet when fights in the room pay no XP', async () => {
    const { map } = await opened(undefined, { id: 'room-1', type: 'plains', noXp: true });
    map.tap(info());
    expect(document.querySelector('.room-sheet-sub-noxp')?.textContent).toBe('Fights here pay no XP');

    const paying = await opened();
    paying.map.tap(info());
    expect(document.querySelector('.room-sheet-sub-noxp')).toBeNull();
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
    expect(gameClient.sendMoveTo).not.toHaveBeenCalled();
    expect(sheet().hidden).toBe(false);
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('Only the party owner or a leader can move');
  });

  it('locks travel inside a dungeon, on the sheet and on a second tap', async () => {
    const { map, gameClient } = await opened({ party: { col: 0, row: 0 }, unlocked: [], social: null, dungeon: { name: 'Caves' } });
    map.tap(info());
    expect(document.querySelector<HTMLButtonElement>('.room-sheet-go')!.disabled).toBe(true);
    map.tap(info());
    expect(gameClient.sendMoveTo).not.toHaveBeenCalled();
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe('Leave the dungeon before traveling');
  });

  describe('a room the party cannot enter', () => {
    const lowLevel = { username: 'me', party: { col: 0, row: 0 }, unlocked: [], social: null, currentMapId: 'here', character: { level: 1, equipment: {} } };
    const lockLines = () => [...document.querySelectorAll('.room-sheet-lock-line')].map(line => line.textContent);

    it('says why on the sheet, and a second tap sends nothing but draws the eye to the lock', async () => {
      const { map, gameClient } = await opened(lowLevel, { id: 'room-1', type: 'plains', entryRequirements: { minLevel: 5 } });
      map.tap(info());
      expect(lockLines()).toEqual(["Needs level 5 (you're level 1)"]);
      expect(document.querySelector<HTMLElement>('.room-sheet-go')!.hidden).toBe(true);

      map.tap(info());
      expect(gameClient.sendMoveTo).not.toHaveBeenCalled();
      expect(sheet().hidden).toBe(false);
      expect(document.querySelector('.room-sheet-lock')!.classList.contains('room-sheet-lock-pulse')).toBe(true);
    });

    it('hides Go to room in the room card as well', async () => {
      const { map } = await opened(lowLevel, { id: 'room-1', type: 'plains', entryRequirements: { minLevel: 5 } });
      map.tap(info());
      document.querySelector<HTMLElement>('.room-sheet-details')!.click();
      expect(document.querySelector('.room-view-lock')!.textContent).toBe("Needs level 5 (you're level 1)");
      expect(document.querySelector('.room-view-action-go')).toBeNull();
    });

    it('says when the player knows no way to a room cut off from the party, and sends nothing', async () => {
      const cutOff: RouteRoom[] = [
        { id: 'party-room', mapId: 'here', col: 0, row: 0, traversable: true },
        { id: 'room-1', mapId: 'here', col: 3, row: 4, traversable: true },
      ];
      const { map, gameClient } = await opened(lowLevel, undefined, cutOff);
      map.tap(info());
      expect(lockLines()).toEqual([NO_KNOWN_WAY_TEXT]);
      map.tap(info());
      expect(gameClient.sendMoveTo).not.toHaveBeenCalled();
    });

    it('walks into a gated room the party already qualifies for', async () => {
      const { map, gameClient } = await opened({ ...lowLevel, character: { level: 9, equipment: {} } }, { id: 'room-1', type: 'plains', entryRequirements: { minLevel: 5 } });
      map.tap(info());
      expect(document.querySelector<HTMLElement>('.room-sheet-lock')!.hidden).toBe(true);
      map.tap(info());
      expect(gameClient.sendMoveTo).toHaveBeenCalledWith('room-1', { col: 3, row: 4 });
    });
  });

  describe('the lock card', () => {
    const gated = { id: 'room-1', type: 'plains', entryRequirements: { minLevel: 5 } };
    const solo = { username: 'me', party: { col: 0, row: 0, path: [] }, unlocked: [], social: null, currentMapId: 'here', otherPlayers: [], character: { level: 1, equipment: {} } };
    const duo = (level: number, mateLevel: number) => ({
      ...solo,
      character: { level, equipment: {} },
      social: { party: { members: [{ username: 'me', role: 'owner', level }, { username: 'Bryn', role: 'member', level: mateLevel }] }, onlinePlayers: ['me'] },
    });
    const lock = (members: { username: string; met: boolean; level?: number }[]) =>
      ({ roomId: 'room-1', requirements: [{ kind: 'level', minLevel: 5, members }] });
    const wait = () => new Promise(resolve => setTimeout(resolve, LOCK_INSPECT_DEBOUNCE_MS + 20));
    const reply = (lockInfo: unknown) => { for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: { kind: 'room', tileId: 'room-1' }, lock: lockInfo }); };

    it('asks the server after a pause when the preview finds a lock, and keeps the card through pushes until it reports the room open', async () => {
      const { map, gameClient } = await opened(solo, gated);
      const push = (state: unknown) => {
        (gameClient as unknown as { lastState: unknown }).lastState = state;
        for (const listener of stateListeners) listener(state);
      };
      map.getTileInfo.mockReturnValue(info());
      map.tap(info());
      expect(gameClient.sendInspectLock).not.toHaveBeenCalled();
      await wait();
      expect(gameClient.sendInspectLock).toHaveBeenCalledWith({ kind: 'room', tileId: 'room-1' });

      reply(lock([{ username: 'me', met: false, level: 1 }]));
      expect(sheet().dataset.lock).toBe('1');
      expect(document.querySelector('.lock-card-need-text')!.textContent).toBe("You need level 5 (you're level 1)");
      push(solo);
      expect(document.querySelector('.lock-card')).not.toBeNull();
      expect(gameClient.sendInspectLock).toHaveBeenCalledOnce();

      push({ ...solo, character: { level: 5, equipment: {} } });
      await wait();
      expect(gameClient.sendInspectLock).toHaveBeenCalledTimes(2);
      reply(null);
      expect(document.querySelector('.lock-card')).toBeNull();
      expect(document.querySelector<HTMLElement>('.room-sheet-go')!.hidden).toBe(false);
    });

    it('asks nothing for a lone player when nothing is locked', async () => {
      const { map, gameClient } = await opened(solo);
      map.tap(info());
      await wait();
      expect(gameClient.sendInspectLock).not.toHaveBeenCalled();
    });

    it('asks about any gate with others along, since their quests and gear are hidden, and ticks each member', async () => {
      const { map, gameClient } = await opened(duo(9, 9), gated);
      map.tap(info());
      await wait();
      expect(gameClient.sendInspectLock).toHaveBeenCalledWith({ kind: 'room', tileId: 'room-1' });
      reply(lock([{ username: 'me', met: true, level: 9 }, { username: 'Bryn', met: false, level: 3 }]));
      const rows = [...document.querySelectorAll('.lock-card-member')].map(row => row.textContent);
      expect(rows).toEqual(['✓You', '✗Brynlevel 3']);
      expect(document.querySelector('[data-lock-action="remove"]')!.textContent).toBe('Remove Bryn from the party');
    });

    it('withholds Go to room in the room card while the card says the room is locked', async () => {
      const { map, gameClient } = await opened(duo(9, 9), gated);
      map.tap(info());
      reply(lock([{ username: 'me', met: true, level: 9 }, { username: 'Bryn', met: false, level: 3 }]));
      document.querySelector<HTMLElement>('.room-sheet-details')!.click();
      expect(document.querySelector('.room-view-lock')!.textContent).toBe('🔒 Locked');
      expect(document.querySelector('.room-view-action-go')).toBeNull();
      expect(gameClient.sendMoveTo).not.toHaveBeenCalled();
    });

    it('asks again once the viewer takes on the quest the card names as the next step', async () => {
      const { map, gameClient } = await opened(solo, { ...gated, entryRequirements: { requiredQuestIds: ['q-gate'] } });
      const push = (state: unknown) => {
        (gameClient as unknown as { lastState: unknown }).lastState = state;
        for (const listener of stateListeners) listener(state);
      };
      map.getTileInfo.mockReturnValue(info());
      map.tap(info());
      await wait();
      expect(gameClient.sendInspectLock).toHaveBeenCalledOnce();
      push({ ...solo, activeQuests: [{ questId: 'q-first', status: 'active', progress: [0], acceptedAt: '' }] });
      await wait();
      expect(gameClient.sendInspectLock).toHaveBeenCalledTimes(2);
    });

    it('asks before removing a member, then sends the kick', async () => {
      const { map, gameClient } = await opened(duo(9, 9), gated);
      (gameClient as unknown as { sendKickPartyMember: ReturnType<typeof vi.fn> }).sendKickPartyMember = vi.fn();
      map.tap(info());
      reply(lock([{ username: 'me', met: true }, { username: 'Bryn', met: false }]));
      document.querySelector<HTMLElement>('[data-lock-action="remove"]')!.click();
      expect(document.querySelector('.confirm-title')!.textContent).toBe('Kick Bryn?');
      document.querySelector<HTMLElement>('.confirm-ok')!.click();
      await tick();
      expect((gameClient as unknown as { sendKickPartyMember: ReturnType<typeof vi.fn> }).sendKickPartyMember).toHaveBeenCalledWith('Bryn');
    });

    describe('while it waits on another member', () => {
      const questGate = { id: 'room-1', type: 'plains', entryRequirements: { requiredQuestIds: ['q-gate'] } };
      const mates = (forecastKey: string, others = ['Bryn']) => ({
        ...solo,
        character: { level: 9, equipment: {} },
        completedQuests: [{ questId: 'q-gate', completedAt: '' }],
        social: {
          party: { forecastKey, members: [{ username: 'me', role: 'owner', level: 9 }, ...others.map(username => ({ username, role: 'member', level: 9 }))] },
          onlinePlayers: ['me', ...others],
        },
      });
      const gate = (met: Record<string, boolean>) => ({
        roomId: 'room-1',
        requirements: [{ kind: 'quest', questId: 'q-gate', questName: 'The Gate', members: Object.entries(met).map(([username, has]) => ({ username, met: has })) }],
      });
      const rows = () => [...document.querySelectorAll('.lock-card-member')].map(row => row.textContent);
      const asked = (gameClient: GameClient) => vi.mocked(gameClient.sendInspectLock).mock.calls.length;

      async function waiting(lastState: unknown = mates('k1'), first: Record<string, boolean> = { me: true, Bryn: false }) {
        const mounted = await opened(lastState, questGate);
        vi.useFakeTimers();
        const push = (state: unknown) => {
          (mounted.gameClient as unknown as { lastState: unknown }).lastState = state;
          for (const listener of stateListeners) listener(state);
        };
        mounted.map.getTileInfo.mockReturnValue(info());
        mounted.map.tap(info());
        vi.advanceTimersByTime(LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(mounted.gameClient)).toBe(1);
        reply(gate(first));
        return { ...mounted, push };
      }

      afterEach(() => {
        vi.useRealTimers();
        Reflect.deleteProperty(document, 'visibilityState');
      });

      it('asks again when the party\'s forecast key moves, and Go comes back once the server finds the room open', async () => {
        const { gameClient, push, map } = await waiting();
        expect(rows()).toEqual(['✓You', '✗Bryn']);
        push(mates('k1'));
        vi.advanceTimersByTime(LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(1);

        push(mates('k2'));
        vi.advanceTimersByTime(LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(2);
        reply(null);
        expect(document.querySelector('.lock-card')).toBeNull();
        expect(document.querySelector<HTMLButtonElement>('.room-sheet-go')!.hidden).toBe(false);
        map.tap(info());
        expect(gameClient.sendMoveTo).toHaveBeenCalledWith('room-1', { col: 3, row: 4 });
      });

      it('asks again every so often, since other members\' quest turn-ins never reach this player, until the room opens', async () => {
        const { gameClient } = await waiting();
        vi.advanceTimersByTime(LOCK_REFRESH_MS - 1);
        expect(asked(gameClient)).toBe(1);
        vi.advanceTimersByTime(1 + LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(2);
        expect(gameClient.sendInspectLock).toHaveBeenLastCalledWith({ kind: 'room', tileId: 'room-1' });

        const card = document.querySelector('.lock-card');
        reply(gate({ me: true, Bryn: false }));
        expect(document.querySelector('.lock-card')).toBe(card);

        vi.advanceTimersByTime(LOCK_REFRESH_MS + LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(3);
        reply(null);
        expect(document.querySelector('.lock-card')).toBeNull();
        expect(document.querySelector<HTMLButtonElement>('.room-sheet-go')!.hidden).toBe(false);

        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(gameClient)).toBe(3);
      });

      it('updates the card in place as each member does their part', async () => {
        const { gameClient } = await waiting(mates('k1', ['Bryn', 'Cy']), { me: true, Bryn: false, Cy: false });
        expect(rows()).toEqual(['✓You', '✗Bryn', '✗Cy']);
        vi.advanceTimersByTime(LOCK_REFRESH_MS + LOCK_INSPECT_DEBOUNCE_MS);
        reply(gate({ me: true, Bryn: false, Cy: true }));
        expect(rows()).toEqual(['✓You', '✗Bryn', '✓Cy']);
        expect(document.querySelector<HTMLButtonElement>('.room-sheet-go')!.hidden).toBe(true);

        vi.advanceTimersByTime(LOCK_REFRESH_MS + LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(3);
      });

      it('keeps a tap on the card working when an answer lands under the finger', async () => {
        const { gameClient } = await waiting();
        vi.advanceTimersByTime(LOCK_REFRESH_MS + LOCK_INSPECT_DEBOUNCE_MS);
        const remove = document.querySelector<HTMLElement>('[data-lock-action="remove"]')!;
        remove.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
        reply(gate({ me: true, Bryn: true }));
        expect(document.querySelector('[data-lock-action="remove"]')).toBe(remove);
        remove.click();
        expect(document.querySelector('.confirm-title')!.textContent).toBe('Kick Bryn?');
        vi.advanceTimersByTime(0);
        expect(rows()).toEqual(['✓You', '✓Bryn']);
        expect(asked(gameClient)).toBe(2);
        while (dismissTop()) { /* drain */ }
      });

      it('stops once the sheet closes or shows another room', async () => {
        const closed = await waiting();
        closed.map.background();
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(closed.gameClient)).toBe(1);

        vi.useRealTimers();
        const other = await waiting();
        const cache = (other.screen as unknown as { worldCache: { getTileOn: (mapId: string, col: number, row: number) => unknown } }).worldCache;
        const getTileOn = cache.getTileOn;
        cache.getTileOn = (mapId, col, row) => (col === 5 ? { id: 'room-2', type: 'plains' } : getTileOn(mapId, col, row));
        other.map.tap(info({ col: 5, tileId: 'room-2' }));
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(other.gameClient)).toBe(1);
      });

      it('stops once the viewer is on their own, or the card waits only on the viewer', async () => {
        const left = await waiting();
        left.push({ ...mates('k1'), social: { party: { forecastKey: 'k1', members: [{ username: 'me', role: 'owner', level: 9 }] } } });
        vi.advanceTimersByTime(LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(left.gameClient)).toBe(2);
        reply(gate({ me: false }));
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(left.gameClient)).toBe(2);

        vi.useRealTimers();
        const mine = await waiting({ ...mates('k1'), completedQuests: [] }, { me: false, Bryn: true });
        expect(rows()).toEqual(['✗You', '✓Bryn']);
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(mine.gameClient)).toBe(1);
      });

      it('stops when the map screen is left', async () => {
        const { screen, gameClient } = await waiting();
        screen.onDeactivate();
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(gameClient)).toBe(1);
      });

      it('rests while the page is hidden and asks at once on return', async () => {
        const { gameClient } = await waiting();
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(asked(gameClient)).toBe(1);

        Reflect.deleteProperty(document, 'visibilityState');
        document.dispatchEvent(new Event('visibilitychange'));
        vi.advanceTimersByTime(LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(2);
        vi.advanceTimersByTime(LOCK_REFRESH_MS + LOCK_INSPECT_DEBOUNCE_MS);
        expect(asked(gameClient)).toBe(3);
      });
    });
  });

  it('focusRoom pans to the room and selects it, even before the map has loaded', async () => {
    const { screen } = mount({ party: { col: 0, row: 0 }, unlocked: [], social: null });
    screen.focusRoom('room-1');
    screen.onActivate();

    await tick();
    const map = latestMap();
    expect(map.focusOn).toHaveBeenCalledWith(3, 4);
  });

  it('focusRoom refuses a room on a map the player has not visited', async () => {
    const { screen, map } = await opened();
    screen.focusRoom('far');
    expect(map.focusOn).not.toHaveBeenCalled();
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe("You haven't visited that map yet.");
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
    vi.mocked(gameClient.sendMoveTo).mockReturnValue(false);
    map.tap(info());
    map.tap(info());
    expect(sheet().hidden).toBe(false);
    expect(document.querySelector('#map-screen .map-toast')?.textContent).toBe(OFFLINE_NOTICE);
  });

  it('dismisses the sheet once another map is drawn', async () => {
    const state = { party: { col: 0, row: 0, path: [] }, unlocked: [], social: null, currentMapId: 'here', otherPlayers: [] };
    const { map } = await opened(state);
    map.getTileInfo.mockReturnValue(info());
    map.tap(info());
    expect(sheet().hidden).toBe(false);

    (map as unknown as { drawnMapId: string }).drawnMapId = 'there';
    for (const listener of stateListeners) listener(state);
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

  const withHires = {
    ...state,
    username: 'me',
    social: { party: { members: [{ username: 'me', role: 'owner' }], henchmen: [{ instanceId: 'h1', henchmanId: 'brin', mapId: 'here', name: 'Brin' }] } },
  };

  async function withTravelChip(wide: boolean, lastState: unknown = state, link = transitionTile.transitions[0], dest: Record<string, unknown> = {}) {
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
      matches: query.includes('min-width: 768px') && wide,
      addEventListener: () => {},
      removeEventListener: () => {},
    }) as unknown as MediaQueryList);
    const mounted = mount(lastState);
    Object.assign((mounted.screen as unknown as { worldCache: object }).worldCache, {
      getTileOn: () => ({ ...transitionTile, transitions: [link] }),
      getTileByGuid: () => ({ name: 'Harbour', mapId: link.mapId, ...dest }),
      getMaps: () => [{ id: 'here', name: 'Home Isle', startTile: { col: 0, row: 0 } }],
    });
    mounted.screen.onActivate();
    await tick();
    return mounted;
  }

  describe('a door to another map while the party has hired fighters', () => {
    const hiresLine = 'Your hired fighter (Brin) stays behind when your party leaves Home Isle.';

    it.each([[false], [true]])('warns before travel starts, with Go and Cancel (wide: %s)', async (wide) => {
      const { gameClient } = await withTravelChip(wide, withHires);
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
      expect(document.querySelector('.confirm-body')!.textContent).toBe(hiresLine);
      expect(document.querySelector('.confirm-ok')!.textContent).toBe('Go');
      expect(document.querySelector('.confirm-cancel')!.textContent).toBe('Cancel');

      document.querySelector<HTMLElement>('.confirm-cancel')!.click();
      await tick();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();

      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      document.querySelector<HTMLElement>('.confirm-ok')!.click();
      await tick();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });

    it('warns from the room card\'s travel button too', async () => {
      const { gameClient } = await withTravelChip(true, withHires);
      latestMap().tap(info({ isCurrentTile: true, col: 0, row: 0 }));
      document.querySelector<HTMLElement>('.room-view-action-travel')!.click();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
      expect(document.querySelector('.confirm-body')!.textContent).toBe(hiresLine);
      document.querySelector<HTMLElement>('.confirm-ok')!.click();
      await tick();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });

    it('goes straight through a door that stays on this map, hires and all', async () => {
      const { gameClient } = await withTravelChip(true, withHires, { tileId: 'far', mapId: 'here' });
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(document.querySelector('.confirm-dialog')).toBeNull();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });
  });

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

  describe('the level of the monsters behind an exit', () => {
    const levelSix = { ...state, username: 'me', character: { level: 6, equipment: {} } };
    const note = () => document.querySelector<HTMLElement>('.confirm-note');

    it('is named in the phone confirm, and warns when they are far above the party', async () => {
      await withTravelChip(false, levelSix, transitionTile.transitions[0], { levels: [12, 12] });
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(document.querySelector('.confirm-body')!.textContent).toBe('Your party will go there right away.');
      expect(note()!.textContent).toBe("Monsters there are level 12. You're level 6.");
      expect(note()!.dataset.danger).toBe('1');
    });

    it('does not warn at the edge of what still pays more', async () => {
      await withTravelChip(false, levelSix, transitionTile.transitions[0], { levels: [11, 13] });
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(note()!.textContent).toBe("Monsters there are level 11–13. You're level 6.");
      expect(note()!.dataset.danger).toBe('0');
    });

    it('says nothing when the world sends no levels', async () => {
      await withTravelChip(false, levelSix);
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(document.querySelector('.confirm-dialog')).not.toBeNull();
      expect(note()).toBeNull();
    });

    it('rides on the wide chip and the room card button, marked when far above the party', async () => {
      await withTravelChip(true, levelSix, transitionTile.transitions[0], { levels: [12, 12] });
      const chip = document.querySelector<HTMLElement>('.room-status-chip')!;
      const chipLevel = chip.querySelector<HTMLElement>('.room-status-chip-level')!;
      expect(chipLevel.textContent).toBe('Lv 12');
      expect(chipLevel.dataset.danger).toBe('1');
      expect(chip.getAttribute('aria-label')).toBe('Travel to Harbour · Lv 12 · Far above your party');
      latestMap().tap(info({ isCurrentTile: true, col: 0, row: 0 }));
      const cardLevel = document.querySelector<HTMLElement>('.room-view-action-travel .room-view-action-level')!;
      expect(cardLevel.textContent).toBe('Lv 12');
      expect(cardLevel.dataset.danger).toBe('1');
    });

    it('marks nothing at the edge of what still pays more', async () => {
      await withTravelChip(true, levelSix, transitionTile.transitions[0], { levels: [11, 13] });
      const chip = document.querySelector<HTMLElement>('.room-status-chip')!;
      expect(chip.querySelector<HTMLElement>('.room-status-chip-level')!.dataset.danger).toBeUndefined();
      expect(chip.getAttribute('aria-label')).toBe('Travel to Harbour · Lv 11–13');
    });

    it('asks first before the wide chip or the room card takes the party far above its level', async () => {
      const { gameClient } = await withTravelChip(true, levelSix, transitionTile.transitions[0], { levels: [12, 12] });
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
      expect(document.querySelector('.confirm-title')!.textContent).toBe('Travel to Harbour?');
      expect(note()!.dataset.danger).toBe('1');
      document.querySelector<HTMLElement>('.confirm-cancel')!.click();
      await tick();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();

      latestMap().tap(info({ isCurrentTile: true, col: 0, row: 0 }));
      document.querySelector<HTMLElement>('.room-view-action-travel')!.click();
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
      expect(note()!.textContent).toBe("Monsters there are level 12. You're level 6.");
      document.querySelector<HTMLElement>('.confirm-ok')!.click();
      await tick();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });

    it('still goes straight there from the wide chip when the monsters are within reach', async () => {
      const { gameClient } = await withTravelChip(true, levelSix, transitionTile.transitions[0], { levels: [11, 13] });
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(document.querySelector('.confirm-dialog')).toBeNull();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });
  });

  describe('a locked exit', () => {
    const doorLock = {
      roomId: 'room-1',
      door: true,
      doorTileId: 'far',
      requirements: [{ kind: 'level', minLevel: 5, members: [{ username: 'me', met: false, level: 1 }] }],
    };

    async function withLockedExit(wide: boolean, levels?: [number, number], lastState: unknown = { ...state, username: 'me', character: { level: 1, equipment: {} } }) {
      vi.spyOn(window, 'matchMedia').mockImplementation((query: string) => ({
        matches: query.includes('min-width: 768px') && wide,
        addEventListener: () => {},
        removeEventListener: () => {},
      }) as unknown as MediaQueryList);
      const mounted = mount(lastState);
      Object.assign((mounted.screen as unknown as { worldCache: object }).worldCache, {
        getTileOn: () => ({ ...transitionTile, transitions: [{ tileId: 'far', mapId: 'there', entryRequirements: { minLevel: 5 } }] }),
        getTileByGuid: () => ({ name: 'Harbour', mapId: 'there', ...(levels ? { levels } : {}) }),
      });
      mounted.screen.onActivate();
      await tick();
      return mounted;
    }

    it.each([[false], [true]])('shows what it needs and asks the server, never "right away" (wide: %s)', async (wide) => {
      const { gameClient } = await withLockedExit(wide);
      const chip = document.querySelector<HTMLElement>('.room-status-chip')!;
      expect(chip.querySelector('.room-status-chip-badge')!.textContent).toBe('🔒');
      chip.click();

      expect(document.querySelector('.confirm-body')).toBeNull();
      expect(document.querySelector('.lock-dialog .confirm-title')!.textContent).toBe('Travel to Harbour');
      expect(document.querySelector('.lock-dialog .lock-card-need-text')!.textContent).toBe("Needs level 5 (you're level 1)");
      expect(gameClient.sendEnterTransition).not.toHaveBeenCalled();
      expect(gameClient.sendInspectLock).toHaveBeenCalledWith({ kind: 'door', fromTileId: 'room-1', tileId: 'far' });

      for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: { kind: 'door', fromTileId: 'room-1', tileId: 'far' }, lock: doorLock });
      expect(document.querySelector('.lock-dialog .lock-card-need-text')!.textContent).toBe("You need level 5 (you're level 1)");

      document.querySelector<HTMLElement>('.lock-dialog-close')!.click();
      expect(document.querySelector('.lock-dialog')).toBeNull();
    });

    it('names the monster levels behind the door, whatever the server answers', async () => {
      await withLockedExit(true, [12, 12]);
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      const note = () => document.querySelector<HTMLElement>('.lock-dialog .confirm-note');
      expect(note()!.textContent).toBe("Monsters there are level 12. You're level 1.");
      expect(note()!.dataset.danger).toBe('1');
      for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: { kind: 'door', fromTileId: 'room-1', tileId: 'far' }, lock: doorLock });
      expect(note()!.textContent).toBe("Monsters there are level 12. You're level 1.");

      document.querySelector<HTMLElement>('.lock-dialog-close')!.click();
      await withLockedExit(true, [6, 6]);
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      expect(note()!.dataset.danger).toBe('0');
    });

    it.each([[undefined], [[12, 12] as [number, number]]])('offers to travel when the server finds the way open after all (levels %j)', async (levels) => {
      const { gameClient } = await withLockedExit(true, levels);
      document.querySelector<HTMLElement>('.room-status-chip')!.click();
      for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: { kind: 'door', fromTileId: 'room-1', tileId: 'far' }, lock: null });
      document.querySelector<HTMLElement>('.lock-dialog-travel')!.click();
      await tick();
      expect(document.querySelector('.confirm-dialog')).toBeNull();
      expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    });

    it('asks again every so often while its card waits on another member, and stops once it is closed', async () => {
      const members = [{ username: 'me', role: 'owner', level: 9 }, { username: 'Bryn', role: 'member', level: 3 }];
      const { gameClient } = await withLockedExit(true, undefined, { ...state, username: 'me', character: { level: 9, equipment: {} }, social: { party: { members }, onlinePlayers: ['me', 'Bryn'] } });
      vi.useFakeTimers();
      try {
        const door = { kind: 'door', fromTileId: 'room-1', tileId: 'far' };
        const waitingLock = { ...doorLock, requirements: [{ kind: 'level', minLevel: 5, members: [{ username: 'me', met: true, level: 9 }, { username: 'Bryn', met: false, level: 3 }] }] };
        document.querySelector<HTMLElement>('.room-status-chip')!.click();
        expect(gameClient.sendInspectLock).toHaveBeenCalledOnce();
        for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: door, lock: waitingLock });
        const card = document.querySelector('.lock-dialog .lock-card');

        vi.advanceTimersByTime(LOCK_REFRESH_MS);
        expect(gameClient.sendInspectLock).toHaveBeenCalledTimes(2);
        expect(gameClient.sendInspectLock).toHaveBeenLastCalledWith(door);
        for (const listener of lockInfoListeners) listener({ type: 'lock_info', target: door, lock: waitingLock });
        expect(document.querySelector('.lock-dialog .lock-card')).toBe(card);

        document.querySelector<HTMLElement>('.lock-dialog-close')!.click();
        vi.advanceTimersByTime(LOCK_REFRESH_MS * 3);
        expect(gameClient.sendInspectLock).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('opens the lock dialog when the server refuses a door the client thought open', async () => {
    const { gameClient } = await withTravelChip(true);
    document.querySelector<HTMLElement>('.room-status-chip')!.click();
    expect(gameClient.sendEnterTransition).toHaveBeenCalledWith('far');
    const lock = { roomId: 'room-1', door: true, doorTileId: 'far', requirements: [{ kind: 'item', itemName: 'Tide Charm', members: [{ username: 'me', met: false }] }] };
    for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'item', reason: 'Tide Charm is required to enter this room.', missingPlayers: ['me'], lock });
    expect(document.querySelector('.lock-dialog .lock-card-need-text')!.textContent).toBe('You need Tide Charm equipped');
    expect(document.querySelector('#map-screen .map-toast')).toBeNull();
  });

  it('turns a door refusal that comes back after the player left the map into a toast over the page', async () => {
    const { screen } = await withTravelChip(true);
    document.querySelector<HTMLElement>('.room-status-chip')!.click();
    screen.onDeactivate();
    const lock = { roomId: 'room-1', door: true, doorTileId: 'far', requirements: [{ kind: 'item', itemName: 'Tide Charm', members: [{ username: 'me', met: false }] }] };
    for (const listener of moveBlockedListeners) listener({ type: 'move_blocked', requirement: 'item', reason: 'Tide Charm is required to enter this room.', missingPlayers: ['me'], lock });
    expect(document.querySelector('.lock-dialog')).toBeNull();
    expect(document.querySelector('body > .map-toast')?.textContent).toBe('Tide Charm is required to enter this room.');
  });

  it('hands the map checks that padlock rooms and exits the party would be refused', async () => {
    const { screen } = mount(state);
    screen.onActivate();
    await tick();
    const checks = latestMap().setLockCheck.mock.calls[0][0] as {
      room: (tile: unknown, s: unknown) => boolean;
      travel: (link: unknown, s: unknown) => boolean;
    };
    const viewer = { username: 'me', character: { level: 2, equipment: {} }, social: null };
    expect(checks.room({ entryRequirements: { minLevel: 5 } }, viewer)).toBe(true);
    expect(checks.room({ entryRequirements: { minLevel: 2 } }, viewer)).toBe(false);
    expect(checks.room({ entryRequirements: undefined }, viewer)).toBe(false);
    expect(checks.travel({ tileId: 'far', mapId: 'there', entryRequirements: { minLevel: 5 } }, viewer)).toBe(true);
    expect(checks.travel({ tileId: 'far', mapId: 'there' }, viewer)).toBe(false);
  });
});
