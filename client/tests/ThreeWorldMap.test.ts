import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cubeToPixel, offsetToCube } from '@idle-party-rpg/shared';
import type { QuestDefinition, QuestProgressEntry, ServerStateMessage } from '@idle-party-rpg/shared';

vi.mock('three', () => {
  class Stub {
    position = { x: 0, y: 0, z: 0, set() {} };
    color = { setHex() {} };
    map: unknown = null;
    needsUpdate = false;
    repeat = { set() {} };
    geometry = { dispose() {} };
    constructor(..._args: unknown[]) {}
    setClearColor() {} setPixelRatio() {} setSize() {} render() {} dispose() {}
    add() {} remove() {} updateProjectionMatrix() {} load() {}
  }
  return {
    WebGLRenderer: Stub, Scene: Stub, OrthographicCamera: Stub, MeshBasicMaterial: Stub, Color: Stub,
    TextureLoader: Stub, CanvasTexture: Stub, Mesh: Stub, PlaneGeometry: Stub,
    SRGBColorSpace: 'srgb', LinearFilter: 1, RepeatWrapping: 1,
  };
});

import { ThreeWorldMap } from '../src/ui/ThreeWorldMap';
import { WorldCache } from '../src/network/WorldCache';

const TILES = [
  { id: 't-home', mapId: 'overworld', col: 0, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Home', npcId: 'mira', dungeonId: 'caves' },
  { id: 't-shop', mapId: 'overworld', col: 1, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Market', shopId: 'store' },
  { id: 't-fog', mapId: 'overworld', col: 2, row: 0, type: 'plains', zone: 'z', zoneName: 'Zone', name: 'Secret', npcId: 'mira' },
  { id: 't-cellar', mapId: 'cellar', col: 2, row: 0, type: 'plains', zone: 'c', zoneName: 'Cellar', name: 'Cellar Door' },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

async function makeCache(): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/world') return json({
      startTile: { col: 0, row: 0 },
      maps: [{ id: 'overworld', name: 'Overworld', startTile: { col: 0, row: 0 } }],
      tiles: TILES,
      tileTypes: { plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true } },
      shops: { store: { id: 'store', name: 'General Store', sellsItems: true, hiresHenchmen: false } },
    });
    if (url === '/api/npcs') return json({ npcs: { mira: { id: 'mira', name: 'Mira', emoji: '🧙', greeting: '', questIds: ['q1'] } } });
    if (url === '/api/dungeons') return json({ dungeons: { caves: { id: 'caves', name: 'Crystal Caves', floors: [] } } });
    return json({});
  }));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

function makeState(overrides: Partial<ServerStateMessage> = {}): ServerStateMessage {
  return {
    type: 'state', username: 'me',
    party: { col: 0, row: 0, state: 'idle', path: [] },
    battle: { visual: 'none' } as ServerStateMessage['battle'],
    unlocked: ['t-home', 't-shop'], mapSize: 0, currentMapId: 'overworld',
    otherPlayers: [
      { username: 'alice', col: 0, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pa', inDungeon: true, dungeonName: 'Crystal Caves' },
      { username: 'bob', col: 1, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pb', inDungeon: true },
      { username: 'carl', col: 1, row: 0, zone: 'z', mapId: 'overworld', partyId: 'pb' },
      { username: 'buddy', col: 0, row: 0, zone: 'z', mapId: 'overworld', partyId: 'mine' },
    ],
    combatLog: [], battleCount: 0, character: null, zoneName: 'Zone', itemDefinitions: {}, serverVersion: 'x',
    social: { party: { members: [{ username: 'me' }, { username: 'buddy' }] } } as unknown as ServerStateMessage['social'],
    ...overrides,
  } as ServerStateMessage;
}

function visitQuest(id: string, name: string, tileIds: string[]): QuestDefinition {
  return {
    id, name, description: '', scope: 'solo', rewards: [],
    objectives: tileIds.map(tileId => ({ kind: 'visit' as const, tileId })),
  };
}

function activeQuest(questId: string, status: QuestProgressEntry['status'], progress: number[]): QuestProgressEntry {
  return { questId, status, progress, acceptedAt: '' };
}

function hoverRoom(container: HTMLElement, col: number, row: number): string[] {
  const home = cubeToPixel(offsetToCube({ col: 0, row: 0 }));
  const p = cubeToPixel(offsetToCube({ col, row }));
  const canvas = container.querySelector('canvas')!;
  canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: p.x - home.x, clientY: p.y - home.y, bubbles: true }));
  const tip = container.querySelector('.canvas-map-tooltip') as HTMLElement;
  return [...tip.children].map(c => c.textContent ?? '');
}

describe('ThreeWorldMap overlays', () => {
  let container: HTMLElement;
  beforeEach(() => { document.body.innerHTML = ''; container = document.createElement('div'); document.body.appendChild(container); });

  it('marks an npc with a new quest with a green pip, and a ready turn-in wins', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState({ availableQuestIds: ['q1'] }));
    expect(container.querySelectorAll('.quest-available-pip')).toHaveLength(1);
    expect(container.querySelector('.quest-ready-pip')).toBeNull();

    const marker = container.querySelector('.three-map-marker');
    map.applyServerState(makeState({ availableQuestIds: ['q1'] }));
    expect(container.querySelector('.three-map-marker')).toBe(marker);

    map.applyServerState(makeState({
      availableQuestIds: ['q1'],
      activeQuests: [activeQuest('q1', 'ready', [])],
    }));
    expect(container.querySelectorAll('.quest-ready-pip')).toHaveLength(1);
    expect(container.querySelector('.quest-available-pip')).toBeNull();
  });

  it('outlines explored quest destinations on this map, and drops them once visited', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const questDefinitions = { q9: visitQuest('q9', 'Shop Run', ['t-shop', 't-cellar']) };
    const state = makeState({ activeQuests: [activeQuest('q9', 'in_progress', [0, 0])], questDefinitions });
    map.applyServerState(state);

    const outlines = [...container.querySelectorAll<HTMLElement>('.three-map-quest-targets .three-map-quest-target')];
    expect(outlines).toHaveLength(1);
    const shop = cubeToPixel(offsetToCube({ col: 1, row: 0 }));
    expect(parseFloat(outlines[0].style.left)).toBeCloseTo(shop.x, 4);
    expect(parseFloat(outlines[0].style.top)).toBeCloseTo(shop.y, 4);

    map.applyServerState(makeState({ activeQuests: [activeQuest('q9', 'in_progress', [0, 0])], questDefinitions }));
    expect(container.querySelector('.three-map-quest-target')).toBe(outlines[0]);

    map.applyServerState(makeState({ activeQuests: [activeQuest('q9', 'in_progress', [1, 0])], questDefinitions }));
    expect(container.querySelector('.three-map-quest-target')).toBeNull();

    map.applyServerState(makeState({ activeQuests: [activeQuest('q9', 'ready', [0, 0])], questDefinitions }));
    expect(container.querySelector('.three-map-quest-target')).toBeNull();
  });

  it('leaves an unexplored destination unmarked until the room is explored', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const questDefinitions = { q9: visitQuest('q9', 'Find the Secret', ['t-fog']) };
    const activeQuests = [activeQuest('q9', 'accepted', [0])];
    map.applyServerState(makeState({ activeQuests, questDefinitions }));
    expect(container.querySelector('.three-map-quest-target')).toBeNull();
    expect(hoverRoom(container, 2, 0)).toEqual(['Zone: Unexplored Room']);

    map.applyServerState(makeState({ activeQuests, questDefinitions, unlocked: ['t-home', 't-shop', 't-fog'] }));
    const fog = cubeToPixel(offsetToCube({ col: 2, row: 0 }));
    expect(parseFloat(container.querySelector<HTMLElement>('.three-map-quest-target')!.style.left)).toBeCloseTo(fog.x, 4);
  });

  it('tooltip names the quests sending you to an explored room', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState({
      activeQuests: [activeQuest('q9', 'accepted', [0]), activeQuest('q8', 'accepted', [0])],
      questDefinitions: {
        q9: visitQuest('q9', 'Find the Secret', ['t-fog']),
        q8: visitQuest('q8', 'Shop Run', ['t-shop']),
      },
    }));
    expect(hoverRoom(container, 2, 0)).toEqual(['Zone: Unexplored Room']);
    expect(hoverRoom(container, 1, 0)).toEqual(['Zone: Market', '🪙 General Store', '📜 Shop Run', '👥 2 players here']);
  });

  it('marks explored rooms only, with a quest pip once a quest is ready', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const markers = [...container.querySelectorAll('.three-map-marker')];
    expect(markers.map(m => m.textContent)).toEqual(['🧙🗝️', '🪙']);
    expect(container.querySelector('.quest-ready-pip')).toBeNull();

    const before = markers[0];
    map.applyServerState(makeState());
    expect(container.querySelector('.three-map-marker')).toBe(before);

    map.applyServerState(makeState({ activeQuests: [{ questId: 'q1', status: 'ready', progress: [], acceptedAt: '' }] }));
    expect(container.querySelector('.three-map-marker')).not.toBe(before);
    expect(container.querySelectorAll('.quest-ready-pip')).toHaveLength(1);

    map.applyServerState(makeState({ unlocked: ['t-home', 't-shop', 't-fog'] }));
    expect(container.querySelectorAll('.three-map-marker')).toHaveLength(3);
  });

  it('counts others outside my party and keys every room a party is delving from', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    expect(map.countOthersAt(0, 0)).toBe(1);
    expect(map.countOthersAt(1, 0)).toBe(2);
    const badges = [...container.querySelectorAll<HTMLElement>('.three-map-badge')].map(b => b.textContent);
    expect(badges.sort()).toEqual(['+1', '×2']);
    expect(container.querySelectorAll('.three-map-dungeon-key')).toHaveLength(2);
  });

  it('builds the tile info for the current room', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const info = map.getTileInfo(0, 0)!;
    expect(info.isCurrentTile).toBe(true);
    expect(info.roomName).toBe('Home');
    expect(info.playersHere.map(p => p.username).sort()).toEqual(['alice', 'buddy']);
    expect(map.getTileInfo(2, 0)!.roomName).toBe('Unexplored Room');
    expect(map.getTileInfo(9, 9)).toBeNull();
  });

  it('tooltip lists actions and a player count, never names', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const canvas = container.querySelector('canvas')!;
    canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 0, clientY: 0, bubbles: true }));
    const tip = container.querySelector('.canvas-map-tooltip') as HTMLElement;
    expect(tip.style.display).toBe('block');
    expect([...tip.children].map(c => c.textContent)).toEqual(['Zone: Home', '🧙 Mira', '🗝️ Crystal Caves', '👥 1 player here']);
  });

  it('draws the route as one line ending in a pin, instead of a dot per room', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState({
      party: { col: 0, row: 0, state: 'moving', path: [{ col: 1, row: 0 }, { col: 2, row: 0 }] } as ServerStateMessage['party'],
    }));
    const line = container.querySelector('.three-map-path .three-map-route-line')!;
    expect(line.getAttribute('points')!.split(' ')).toHaveLength(3);
    const pin = container.querySelector<HTMLElement>('.three-map-path-dest')!;
    expect(parseFloat(pin.style.left)).toBeCloseTo(cubeToPixel(offsetToCube({ col: 2, row: 0 })).x, 4);
    expect(container.querySelector('.three-map-path-step')).toBeNull();

    map.applyServerState(makeState());
    expect(container.querySelector('.three-map-path')!.children).toHaveLength(0);
  });

  it('keeps the party token topmost, with its class or initials, moved by transform', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const overlay = container.querySelector('.three-map-overlay')!;
    const party = container.querySelector<HTMLElement>('.three-map-party')!;
    expect(overlay.lastElementChild).toBe(party);
    expect(party.querySelector('.three-map-party-initials')!.textContent).toBe('M');
    expect(party.dataset.snap).toBe('1');

    map.applyServerState(makeState({ character: { className: 'Knight' } as ServerStateMessage['character'] }));
    expect(party.querySelector('.three-map-party-icon')).not.toBeNull();

    map.applyServerState(makeState({ party: { col: 1, row: 0, state: 'moving', path: [] } as unknown as ServerStateMessage['party'] }));
    const shop = cubeToPixel(offsetToCube({ col: 1, row: 0 }));
    expect(party.style.transform).toBe(`translate(${shop.x}px, ${shop.y}px)`);
    expect(party.style.left).toBe('');
    expect(party.dataset.snap).toBe('0');
  });

  it('names explored zones only, away from the party and marked rooms', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState({ unlocked: [] }));
    expect(container.querySelector('.three-map-zone-label')).toBeNull();

    map.applyServerState(makeState({ unlocked: ['t-shop', 't-home'] }));
    const labels = [...container.querySelectorAll<HTMLElement>('.three-map-zone-label')];
    expect(labels.map(l => l.textContent)).toEqual(['Zone']);
    expect(labels[0].dataset.current).toBe('1');
  });

  it('never rebuilds the grid for exploring or for reopening the tab', async () => {
    const cache = await makeCache();
    const map = new ThreeWorldMap(container, cache);
    map.applyServerState(makeState());
    const getTiles = vi.spyOn(cache, 'getTiles');

    map.applyServerState(makeState({ unlocked: ['t-home', 't-shop', 't-fog'] }));
    map.applyServerState(makeState({ unlocked: ['t-home', 't-shop', 't-fog'] }), true);
    expect(getTiles).not.toHaveBeenCalled();
    expect(container.querySelectorAll('.three-map-marker')).toHaveLength(3);

    map.rebuildFromCache();
    expect(getTiles).toHaveBeenCalledOnce();
  });

  it('switching map rebuilds and recentres', async () => {
    const cache = await makeCache();
    const map = new ThreeWorldMap(container, cache);
    map.applyServerState(makeState());
    const getTiles = vi.spyOn(cache, 'getTiles');
    map.applyServerState(makeState({ currentMapId: 'cellar', party: { col: 2, row: 0, state: 'idle', path: [] } as unknown as ServerStateMessage['party'] }));
    expect(getTiles).toHaveBeenCalled();
    expect(container.querySelector('.three-map-party')!.getAttribute('data-snap')).toBe('1');
  });

  function press(canvas: Element, x: number, y: number): void {
    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: x, clientY: y, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: x, clientY: y, bubbles: true }));
  }

  function touch(canvas: Element, type: string, points: { x: number; y: number }[]): void {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'touches', { value: points.map(p => ({ clientX: p.x, clientY: p.y })) });
    canvas.dispatchEvent(event);
  }

  it('reports a room tap, and a tap on the sea or a blocked room separately', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const onTile = vi.fn();
    const onBackground = vi.fn();
    map.setOnTileClick(onTile);
    map.setOnBackgroundClick(onBackground);
    map.applyServerState(makeState());
    const canvas = container.querySelector('canvas')!;

    press(canvas, 0, 0);
    expect(onTile).toHaveBeenCalledOnce();
    expect(onTile.mock.calls[0][0].roomName).toBe('Home');
    expect(onBackground).not.toHaveBeenCalled();

    press(canvas, 5000, 5000);
    expect(onTile).toHaveBeenCalledOnce();
    expect(onBackground).toHaveBeenCalledOnce();
  });

  it('does not treat a pinch release as a tap', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const onTile = vi.fn();
    map.setOnTileClick(onTile);
    map.applyServerState(makeState());
    const canvas = container.querySelector('canvas')!;

    touch(canvas, 'touchstart', [{ x: 0, y: 0 }]);
    touch(canvas, 'touchstart', [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    touch(canvas, 'touchmove', [{ x: 0, y: 0 }, { x: 80, y: 0 }]);
    touch(canvas, 'touchend', [{ x: 0, y: 0 }]);
    touch(canvas, 'touchend', []);
    expect(onTile).not.toHaveBeenCalled();

    touch(canvas, 'touchstart', [{ x: 0, y: 0 }]);
    touch(canvas, 'touchend', []);
    expect(onTile).toHaveBeenCalledOnce();
  });

  it('writes the zoom only at the end of a pinch', async () => {
    localStorage.removeItem('mapZoom2');
    const map = new ThreeWorldMap(container, await makeCache());
    map.applyServerState(makeState());
    const canvas = container.querySelector('canvas')!;

    touch(canvas, 'touchstart', [{ x: 0, y: 0 }, { x: 40, y: 0 }]);
    touch(canvas, 'touchmove', [{ x: 0, y: 0 }, { x: 60, y: 0 }]);
    touch(canvas, 'touchmove', [{ x: 0, y: 0 }, { x: 80, y: 0 }]);
    expect(localStorage.getItem('mapZoom2')).toBeNull();
    touch(canvas, 'touchend', []);
    expect(localStorage.getItem('mapZoom2')).toBe('2');
    localStorage.removeItem('mapZoom2');
  });

  it('stops following once the player drags, until asked to recentre', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const onFollow = vi.fn();
    map.setOnFollowChange(onFollow);
    map.applyServerState(makeState());
    expect(onFollow.mock.lastCall).toEqual([true]);
    const canvas = container.querySelector('canvas')!;

    canvas.dispatchEvent(new MouseEvent('mousedown', { clientX: 0, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 30, clientY: 0, bubbles: true }));
    window.dispatchEvent(new MouseEvent('mouseup', { clientX: 30, clientY: 0, bubbles: true }));
    expect(onFollow.mock.lastCall).toEqual([false]);

    map.recenterOnPlayer();
    expect(onFollow.mock.lastCall).toEqual([true]);
  });

  it('outlines the selected room', async () => {
    const map = new ThreeWorldMap(container, await makeCache());
    const outline = container.querySelector<HTMLElement>('.three-map-selected')!;
    expect(outline.style.display).toBe('none');
    map.setSelectedRoom({ col: 1, row: 0 });
    expect(outline.style.display).toBe('');
    expect(parseFloat(outline.style.left)).toBeCloseTo(cubeToPixel(offsetToCube({ col: 1, row: 0 })).x, 4);
    map.setSelectedRoom(null);
    expect(outline.style.display).toBe('none');
  });

  describe('default zoom', () => {
    function sized(width: number): HTMLElement {
      const el = document.createElement('div');
      Object.defineProperty(el, 'clientWidth', { value: width });
      Object.defineProperty(el, 'clientHeight', { value: 600 });
      document.body.appendChild(el);
      return el;
    }

    beforeEach(() => { localStorage.removeItem('mapZoom2'); });

    it('is closer in on phones than desktop, and a stored zoom wins', async () => {
      const inner = vi.spyOn(window, 'innerWidth', 'get');
      inner.mockReturnValue(375);
      const phone = sized(375);
      new ThreeWorldMap(phone, await makeCache());
      expect(phone.querySelector<HTMLElement>('.three-map-overlay')!.style.getPropertyValue('--map-zoom')).toBe('0.65');

      inner.mockReturnValue(1280);
      const desktop = sized(1000);
      new ThreeWorldMap(desktop, await makeCache());
      expect(desktop.querySelector<HTMLElement>('.three-map-overlay')!.style.getPropertyValue('--map-zoom')).toBe('1');

      localStorage.setItem('mapZoom2', '1.5');
      const stored = sized(1000);
      new ThreeWorldMap(stored, await makeCache());
      expect(stored.querySelector<HTMLElement>('.three-map-overlay')!.style.getPropertyValue('--map-zoom')).toBe('1.5');
      inner.mockRestore();
      localStorage.removeItem('mapZoom2');
    });
  });
});
