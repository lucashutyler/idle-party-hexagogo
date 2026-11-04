import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForecastResult } from '@idle-party-rpg/shared';
import { dismissTop } from '../src/ui/ModalStack';
import { DUNGEON_TRAVEL_LOCK_TEXT, ROOM_SHEET_FORECAST_DEBOUNCE_MS, RoomSheet } from '../src/ui/RoomSheet';
import type { RoomSheetHandlers, RoomSheetModel } from '../src/ui/RoomSheet';
import type { RoomForecastProvider } from '../src/ui/RoomView';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';

function makeInfo(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    col: 3, row: 4, tileType: 'Plains', zoneName: 'Hatchetmill', roomName: 'Town Square', zoneId: 'hatchetmill',
    isTraversable: true, isUnlocked: true, isSameZone: true, isCurrentTile: false, playersHere: [], partyMemberUsernames: [],
    ...overrides,
  };
}

function makeModel(overrides: Partial<RoomSheetModel> = {}): RoomSheetModel {
  return {
    info: makeInfo(),
    actions: [{ kind: 'npc', icon: '🧙', name: 'Mira', targetId: 'mira', questReady: true }],
    othersHere: 0,
    roomId: 'room-1',
    typeId: 'plains',
    forecastTileId: 'room-1',
    inDungeon: false,
    ...overrides,
  };
}

function result(): ForecastResult {
  return {
    key: 'k', partyKey: 'pk', sims: 200, wins: 184, losses: 16, stalemates: 0, winPct: 92, ci: [88, 95],
    medianMs: 12_000, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [],
  } as ForecastResult;
}

describe('RoomSheet', () => {
  let parent: HTMLElement;
  let handlers: { [K in keyof RoomSheetHandlers]: ReturnType<typeof vi.fn> };
  let provider: ReturnType<typeof vi.fn<RoomForecastProvider>>;
  let sheet: RoomSheet;

  const el = () => parent.querySelector('.room-sheet') as HTMLElement;
  const q = <T extends HTMLElement = HTMLElement>(selector: string) => parent.querySelector<T>(selector)!;

  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    parent = document.createElement('div');
    document.body.appendChild(parent);
    handlers = { onGo: vi.fn(), onDetails: vi.fn(), onUserClick: vi.fn(), onDismiss: vi.fn() };
    provider = vi.fn<RoomForecastProvider>(() => 'loading');
    sheet = new RoomSheet(parent, handlers as unknown as RoomSheetHandlers, provider);
  });

  afterEach(() => {
    sheet.hide();
    vi.useRealTimers();
  });

  it('starts hidden and shows name, zone, player count and action pips', () => {
    expect(el().hidden).toBe(true);
    sheet.show(makeModel({ othersHere: 2 }));

    expect(el().hidden).toBe(false);
    expect(q('.room-sheet-name').textContent).toBe('Town Square');
    expect(q('.room-sheet-sub').textContent).toBe('Hatchetmill · 2 players');
    expect(q('.room-sheet-action-icon').textContent).toBe('🧙');
    expect(q('.room-sheet-action-icon').classList.contains('quest-ready-pip')).toBe(true);
  });

  it('shows only the name and Go for an unexplored room', () => {
    sheet.show(makeModel({
      info: makeInfo({ isUnlocked: false, roomName: 'Unexplored Room' }),
      actions: [],
      forecastTileId: null,
    }));

    expect(q('.room-sheet-name').textContent).toBe('Unexplored Room');
    expect(parent.querySelector('.room-sheet-sub')).toBeNull();
    expect(parent.querySelector('.room-sheet-action')).toBeNull();
    expect(q('.room-sheet-forecast').hidden).toBe(true);
    expect(q('.room-sheet-details').hidden).toBe(true);
    expect(q<HTMLButtonElement>('.room-sheet-go').disabled).toBe(false);
    expect(provider).not.toHaveBeenCalled();
  });

  it('routes Go and Details to its handlers', () => {
    sheet.show(makeModel());
    q('.room-sheet-go').click();
    expect(handlers.onGo).toHaveBeenCalledOnce();
    q('.room-sheet-details').click();
    expect(handlers.onDetails).toHaveBeenCalledOnce();
  });

  it('replaces Go with the dungeon lock', () => {
    sheet.show(makeModel({ inDungeon: true }));
    const go = q<HTMLButtonElement>('.room-sheet-go');
    expect(go.textContent).toBe(DUNGEON_TRAVEL_LOCK_TEXT);
    expect(go.disabled).toBe(true);
    go.click();
    expect(handlers.onGo).not.toHaveBeenCalled();
  });

  it('asks for a forecast only after the debounce, and only for the room still selected', () => {
    sheet.show(makeModel({ forecastTileId: 'first' }));
    expect(provider).not.toHaveBeenCalled();
    expect(q('.forecast-chip').dataset.state).toBe('loading');

    vi.advanceTimersByTime(ROOM_SHEET_FORECAST_DEBOUNCE_MS - 1);
    sheet.show(makeModel({ info: makeInfo({ col: 9 }), forecastTileId: 'second' }));
    vi.advanceTimersByTime(ROOM_SHEET_FORECAST_DEBOUNCE_MS);

    expect(provider.mock.calls.map(c => c[0])).toEqual(['second']);
  });

  it('patches in a forecast for the shown room and ignores others', () => {
    sheet.show(makeModel());
    sheet.updateForecast('other-room', { result: result() });
    expect(q('.forecast-chip').dataset.state).toBe('loading');

    sheet.updateForecast('room-1', { result: result() });
    expect(q('.forecast-chip').dataset.state).toBe('ready');
    expect(q('.room-sheet-forecast-text').textContent).not.toBe('');

    sheet.updateForecast('room-1', null);
    expect(q('.room-sheet-forecast').hidden).toBe(true);
  });

  it('keeps the forecast when a state push repaints the same room', () => {
    sheet.show(makeModel());
    sheet.updateForecast('room-1', { result: result() });
    sheet.show(makeModel({ othersHere: 1 }));
    sheet.update(makeModel({ othersHere: 3 }));
    expect(q('.forecast-chip').dataset.state).toBe('ready');
    expect(q('.room-sheet-sub').textContent).toBe('Hatchetmill · 3 players');
  });

  it('lists players and passes a real anchor when one is clicked', () => {
    sheet.show(makeModel({ info: makeInfo({ playersHere: [{ username: 'alice' }] }) }));
    const player = q('[data-username="alice"]');
    player.click();
    expect(handlers.onUserClick).toHaveBeenCalledWith('alice', player, 3, 4);
  });

  it('dismisses through X and through Back or Escape, and leaves the stack when hidden', () => {
    sheet.show(makeModel());
    q('.room-sheet-close').click();
    expect(handlers.onDismiss).toHaveBeenCalledTimes(1);

    expect(dismissTop()).toBe(true);
    expect(handlers.onDismiss).toHaveBeenCalledTimes(2);

    sheet.hide();
    expect(dismissTop()).toBe(false);
    expect(sheet.isOpen).toBe(false);
  });

  it('keeps presses away from the map but lets a drag released over it end', () => {
    sheet.show(makeModel());
    const reached = vi.fn();
    parent.addEventListener('mousedown', reached);
    parent.addEventListener('mouseup', reached);
    el().dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    expect(reached).not.toHaveBeenCalled();
    el().dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    expect(reached).toHaveBeenCalledOnce();
  });

  it('escapes authored text', () => {
    sheet.show(makeModel({ info: makeInfo({ roomName: '<b>Room</b>', zoneName: 'A&B' }), actions: [] }));
    expect(q('.room-sheet-name').querySelector('b')).toBeNull();
    expect(q('.room-sheet-name').textContent).toBe('<b>Room</b>');
    expect(q('.room-sheet-sub').textContent).toBe('A&B');
  });
});
