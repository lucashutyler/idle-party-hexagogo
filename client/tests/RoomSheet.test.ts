import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForecastResult, RoomLockInfo } from '@idle-party-rpg/shared';
import { dismissTop } from '../src/ui/ModalStack';
import { DUNGEON_TRAVEL_LOCK_TEXT, ROOM_SHEET_FORECAST_DEBOUNCE_MS, RoomSheet, SETTING_OFF_TEXT } from '../src/ui/RoomSheet';
import type { RoomSheetHandlers, RoomSheetModel } from '../src/ui/RoomSheet';
import type { RoomForecastProvider } from '../src/ui/RoomView';
import { LOCKED_DOOR_WAY_TEXT, NO_KNOWN_WAY_TEXT } from '../src/ui/routePreview';
import type { TileClickInfo } from '../src/ui/ThreeWorldMap';

function makeInfo(overrides: Partial<TileClickInfo> = {}): TileClickInfo {
  return {
    mapId: 'here', tileId: 'room-1', col: 3, row: 4, tileType: 'Plains', zoneName: 'Hatchetmill', roomName: 'Town Square', zoneId: 'hatchetmill',
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
    paysNoXp: false,
    lock: null,
    route: null,
    routeLines: [],
    partyHasOthers: false,
    lockContext: { viewer: 'me', humans: [], viewerLevel: 2, canMove: true },
    ...overrides,
  };
}

const LEVEL_LOCK: RoomLockInfo = {
  roomId: 'room-1',
  requirements: [{ kind: 'level', minLevel: 6, members: [{ username: 'me', met: false, level: 2 }] }],
};

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
    handlers = { onGo: vi.fn(), onDetails: vi.fn(), onUserClick: vi.fn(), onDismiss: vi.fn(), onLockAction: vi.fn() };
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
    expect(q('.room-sheet-sub-zone').textContent).toBe('Hatchetmill · 2 players');
    expect(q('.room-sheet-sub-action').textContent).toBe('Talk to Mira');
    expect(q('.room-sheet-action-icon').textContent).toBe('🧙');
    expect(q('.room-sheet-action-icon').classList.contains('quest-ready-pip')).toBe(true);
  });

  it('says when a room pays no XP, after its zone and players, and only for an explored room', () => {
    sheet.show(makeModel());
    expect(parent.querySelector('.room-sheet-sub-noxp')).toBeNull();

    sheet.show(makeModel({ info: makeInfo({ col: 5 }), paysNoXp: true, othersHere: 2 }));
    expect(q('.room-sheet-sub-noxp').textContent).toBe('Fights here pay no XP');
    expect(q('.room-sheet-sub').textContent).toBe('Talk to MiraHatchetmill · 2 playersFights here pay no XP');

    const den = { kind: 'dungeon' as const, icon: 'D', name: 'Old Den', targetId: 'den' };
    sheet.show(makeModel({ info: makeInfo({ col: 7 }), actions: [den], paysNoXp: true }));
    const parts = [...q('.room-sheet-sub').children].map(child => child.textContent);
    expect(parts).toEqual(['Enter Old Den', 'Hatchetmill', 'Fights here pay no XP']);

    sheet.show(makeModel({ info: makeInfo({ col: 6, isUnlocked: false }), actions: [], paysNoXp: true }));
    expect(parent.querySelector('.room-sheet-sub-noxp')).toBeNull();
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

  describe('a room the party cannot enter', () => {
    const lockLines = () => [...parent.querySelectorAll('.room-sheet-lock-line')].map(line => line.textContent);

    it('puts a padlock on the name, says why on visible lines, and offers Details but no Go', () => {
      sheet.show(makeModel({ lock: ["Needs level 3 (you're level 1)", 'Bob needs level 6'] }));
      expect(q('.room-sheet-name').textContent).toBe('🔒Town Square');
      expect(q('.room-sheet-lock').hidden).toBe(false);
      expect(lockLines()).toEqual(["Needs level 3 (you're level 1)", 'Bob needs level 6']);
      expect(q('.room-sheet-go').hidden).toBe(true);
      expect(q('.room-sheet-details').hidden).toBe(false);
      expect(sheet.isBlocked).toBe(true);
    });

    it('shows the lock on an unexplored room too, under its unexplored name', () => {
      sheet.show(makeModel({
        info: makeInfo({ isUnlocked: false, roomName: 'Unexplored Room' }),
        actions: [],
        forecastTileId: null,
        lock: ['Opens later in the story'],
      }));
      expect(q('.room-sheet-name').textContent).toBe('🔒Unexplored Room');
      expect(lockLines()).toEqual(['Opens later in the story']);
      expect(q('.room-sheet-go').hidden).toBe(true);
      expect(q('.room-sheet-details').hidden).toBe(true);
    });

    it('says a lone player knows no way there, and holds back Go', () => {
      sheet.show(makeModel({ route: { kind: 'none' }, routeLines: [NO_KNOWN_WAY_TEXT] }));
      expect(lockLines()).toEqual([NO_KNOWN_WAY_TEXT]);
      expect(q('.room-sheet-name').textContent).toBe('Town Square');
      expect(q('.room-sheet-go').hidden).toBe(true);
      expect(sheet.isBlocked).toBe(true);
    });

    it('heads the lock lines of the only door on the way', () => {
      const lines = [LOCKED_DOOR_WAY_TEXT, "Needs level 5 (you're level 1)"];
      sheet.show(makeModel({ route: { kind: 'locked', lines: [] }, routeLines: lines }));
      expect(lockLines()).toEqual(lines);
      expect(q('.room-sheet-go').hidden).toBe(true);
    });

    it('keeps Go in a party with other players, who may know a door, and says what the viewer knows', () => {
      sheet.show(makeModel({ route: { kind: 'none' }, routeLines: [NO_KNOWN_WAY_TEXT], partyHasOthers: true }));
      expect(q('.room-sheet-lock').hidden).toBe(true);
      expect(q('.room-sheet-go').hidden).toBe(false);
      expect(q('.room-sheet-sub-route').textContent).toBe(NO_KNOWN_WAY_TEXT);
      expect(sheet.isBlocked).toBe(false);
    });

    it('gives Go back once a push says the room opened', () => {
      sheet.show(makeModel({ lock: ['Opens later in the story'] }));
      sheet.update(makeModel());
      expect(q('.room-sheet-lock').hidden).toBe(true);
      expect(q('.room-sheet-go').hidden).toBe(false);
      expect(q('.room-sheet-name').textContent).toBe('Town Square');
      expect(sheet.isBlocked).toBe(false);
    });

    it('pulses the lock block on request, and only while one is shown', () => {
      sheet.show(makeModel());
      sheet.pulseLock();
      expect(q('.room-sheet-lock').classList.contains('room-sheet-lock-pulse')).toBe(false);

      sheet.show(makeModel({ info: makeInfo({ col: 8 }), lock: ['Opens later in the story'] }));
      sheet.pulseLock();
      expect(q('.room-sheet-lock').classList.contains('room-sheet-lock-pulse')).toBe(true);
      q('.room-sheet-lock').dispatchEvent(new Event('animationend'));
      expect(q('.room-sheet-lock').classList.contains('room-sheet-lock-pulse')).toBe(false);
    });

    it('marks a locked exit among the action icons', () => {
      const door = { kind: 'travel' as const, icon: '🌀', name: 'Cellar', targetId: 'cellar', locked: true };
      sheet.show(makeModel({ actions: [door] }));
      const action = q('.room-sheet-action');
      expect(action.classList.contains('room-sheet-action-locked')).toBe(true);
      expect(action.title).toBe('Cellar · Locked');
    });
  });

  describe('the lock card', () => {
    it('replaces the preview lines and Go, and stays through every push until the sheet closes', () => {
      sheet.show(makeModel({ lock: ["Needs level 6 (you're level 2)"] }));
      sheet.setLock(LEVEL_LOCK);
      expect(el().dataset.lock).toBe('1');
      expect(q('.lock-card-title').textContent).toBe('🔒 Locked');
      expect(q('.lock-card-need-text').textContent).toBe("You need level 6 (you're level 2)");
      expect(parent.querySelector('.room-sheet-lock-line')).toBeNull();
      expect(q('.room-sheet-go').hidden).toBe(true);
      expect(sheet.isBlocked).toBe(true);

      sheet.update(makeModel({ othersHere: 2 }));
      sheet.update(makeModel());
      expect(q('.lock-card-title').textContent).toBe('🔒 Locked');
      expect(q('.room-sheet-go').hidden).toBe(true);

      sheet.hide();
      sheet.show(makeModel());
      expect(parent.querySelector('.lock-card')).toBeNull();
      expect(el().dataset.lock).toBe('0');
    });

    it('goes when another room is shown, and gives way to the preview when dropped', () => {
      sheet.show(makeModel({ lock: ['Opens later in the story'] }));
      sheet.setLock(LEVEL_LOCK);
      sheet.setLock(null);
      expect(parent.querySelector('.lock-card')).toBeNull();
      expect(q('.room-sheet-lock-line').textContent).toBe('Opens later in the story');

      sheet.setLock(LEVEL_LOCK);
      sheet.show(makeModel({ info: makeInfo({ col: 9 }) }));
      expect(parent.querySelector('.lock-card')).toBeNull();
      expect(q('.room-sheet-go').hidden).toBe(false);
    });

    it('puts the padlock on the name only when the room itself is locked', () => {
      sheet.show(makeModel());
      sheet.setLock({ ...LEVEL_LOCK, roomId: 'room-2', roomName: 'Old Gate', onRoute: true });
      expect(q('.room-sheet-name').textContent).toBe('Town Square');
      expect(q('.lock-card-title').textContent).toBe('🔒 The way there passes Old Gate, which is locked');
      sheet.setLock(LEVEL_LOCK);
      expect(q('.room-sheet-name').textContent).toBe('🔒Town Square');
    });

    it('hands its buttons to the handler', () => {
      sheet.show(makeModel());
      sheet.setLock({
        roomId: 'room-1',
        requirements: [{
          kind: 'quest', questId: 'q2', questName: 'Second Bell',
          members: [{ username: 'me', met: false, nextStep: { questId: 'q1', questName: 'First Bell', state: 'active', remaining: 2 } }],
        }],
      });
      q('[data-lock-action="quests"]').click();
      expect(handlers.onLockAction).toHaveBeenCalledWith({ kind: 'quests' });
      expect(handlers.onDetails).not.toHaveBeenCalled();
    });
  });

  describe('after Go', () => {
    it('says the party sets off and takes no second press', () => {
      sheet.show(makeModel());
      sheet.setPending(true);
      const go = q<HTMLButtonElement>('.room-sheet-go');
      expect(go.textContent).toBe(SETTING_OFF_TEXT);
      expect(go.disabled).toBe(true);
      go.click();
      expect(handlers.onGo).not.toHaveBeenCalled();

      sheet.update(makeModel({ othersHere: 1 }));
      expect(go.textContent).toBe(SETTING_OFF_TEXT);
      sheet.setPending(false);
      expect(go.textContent).toBe('Go');
    });

    it('shows a refusal in the sheet and keeps Go for another try', () => {
      sheet.show(makeModel());
      sheet.setPending(true);
      sheet.setNotice("Your party hasn't found a way there yet.");
      expect(q('.room-sheet-lock').hidden).toBe(false);
      expect(q('.room-sheet-lock-line[data-kind="notice"]').textContent).toBe("Your party hasn't found a way there yet.");
      expect(q<HTMLButtonElement>('.room-sheet-go').hidden).toBe(false);
      expect(q<HTMLButtonElement>('.room-sheet-go').textContent).toBe('Go');
      expect(sheet.isBlocked).toBe(false);
    });

    it('gives a refusal a row of its own above Go, so neither is squeezed', () => {
      sheet.show(makeModel());
      sheet.setNotice("Your party hasn't found a way there yet.");
      expect(el().dataset.notice).toBe('1');
      sheet.setPending(true);
      expect(el().dataset.notice).toBe('0');
    });

    it('announces a refusal or a card as the toast it replaces did', () => {
      sheet.show(makeModel());
      sheet.setNotice('Give your party a moment between orders, then try again.');
      expect(q('.room-sheet-lock').getAttribute('role')).toBe('status');
    });

    it('turns into the card when the refusal is a lock', () => {
      sheet.show(makeModel());
      sheet.setPending(true);
      sheet.setPending(false);
      sheet.setLock(LEVEL_LOCK);
      expect(q('.lock-card-title').textContent).toBe('🔒 Locked');
      expect(q('.room-sheet-go').hidden).toBe(true);
    });
  });

  describe('the way there', () => {
    it('names the doors on the way under the zone, with Go kept', () => {
      sheet.show(makeModel({ route: { kind: 'doors', doors: 2, otherMap: true, gated: false }, routeLines: ['Through 2 doors'] }));
      expect(q('.room-sheet-sub-route').textContent).toBe('Through 2 doors');
      expect(q('.room-sheet-go').hidden).toBe(false);
    });

    it('names them on an unexplored room too', () => {
      sheet.show(makeModel({
        info: makeInfo({ isUnlocked: false, roomName: 'Unexplored Room' }),
        actions: [],
        forecastTileId: null,
        route: { kind: 'doors', doors: 1, otherMap: false, gated: false },
        routeLines: ['Through 1 door'],
      }));
      expect(q('.room-sheet-sub').textContent).toBe('Through 1 door');
    });

    it('says nothing for a walk', () => {
      sheet.show(makeModel({ route: { kind: 'walk' } }));
      expect(parent.querySelector('.room-sheet-sub-route')).toBeNull();
    });

    it('tells the same spot on two maps apart', () => {
      sheet.show(makeModel());
      expect(sheet.isShowing('here', 3, 4)).toBe(true);
      expect(sheet.isShowing('there', 3, 4)).toBe(false);
      expect(sheet.selectedMapId).toBe('here');
    });
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
    expect(q('.room-sheet-sub-zone').textContent).toBe('Hatchetmill · 3 players');
  });

  it('says what the number means, in one word, beside the ring', () => {
    sheet.show(makeModel());
    sheet.updateForecast('room-1', { result: result() });
    expect(q('.room-sheet-forecast-word').textContent).toBe('Safe');
  });

  it('starts a forecast on a push once the room has a different target, as when it gets explored', () => {
    sheet.show(makeModel({ forecastTileId: null }));
    expect(q('.room-sheet-forecast').hidden).toBe(true);

    sheet.update(makeModel());
    expect(sheet.visibleForecastTileId).toBe('room-1');
    expect(q('.room-sheet-forecast').hidden).toBe(false);
    vi.advanceTimersByTime(ROOM_SHEET_FORECAST_DEBOUNCE_MS);
    expect(provider).toHaveBeenCalledWith('room-1');
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

  it('starts another room\'s sheet scrolled to the top', () => {
    sheet.show(makeModel());
    sheet.setLock(LEVEL_LOCK);
    el().scrollTop = 40;
    sheet.show(makeModel({ info: makeInfo({ col: 9 }) }));
    expect(el().scrollTop).toBe(0);
  });
});

describe('the lock card in the bottom sheet', () => {
  const css = readFileSync(resolve(__dirname, '../src/styles/map.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const bottom = '#screen-map:not([data-sheet="side"]) .room-sheet:is([data-lock="1"], [data-notice="1"])';

  it('scrolls the sheet as a whole, so the card\'s buttons are never hidden in a box of their own', () => {
    expect(rules.find(r => r.selector === bottom)?.body).toMatch(/overflow-y:\s*auto/);
    expect(rules.find(r => r.selector === `${bottom} .room-sheet-lock`)?.body).toMatch(/max-height:\s*none/);
  });

  it('grows with the card but leaves part of a short map in view', () => {
    expect(rules.find(r => r.selector === bottom)?.body).toMatch(/max-height:\s*min\(\d+px,\s*\d+%\)/);
  });

  it('lays a refusal out the same way, on a full row above Go', () => {
    expect(rules.find(r => r.selector === `${bottom} .room-sheet-buttons`)?.body).toMatch(/position:\s*static/);
    expect(rules.find(r => r.selector === `${bottom} .room-sheet-lock`)?.body).toMatch(/flex-basis:\s*100%/);
  });
});
