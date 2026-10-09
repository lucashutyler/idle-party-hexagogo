import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DungeonDefinition,
  DungeonEntryRequirements,
  HiredHenchman,
  ServerErrorCode,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { DungeonEntryPopup } from '../src/ui/DungeonEntryPopup';
import { OFFLINE_NOTICE, type GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;
type ErrorListener = (message: string, code?: ServerErrorCode) => void;

const ENTRANCE = { col: 4, row: 7 };

function dungeon(entryRequirements?: DungeonEntryRequirements): DungeonDefinition {
  return {
    id: 'd-crypt',
    name: 'Crypt',
    floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [] }],
    entryRequirements,
  };
}

interface StateParts {
  level?: number;
  col?: number;
  row?: number;
  henchmen?: Partial<HiredHenchman>[];
  inventory?: Record<string, number>;
  inDungeon?: boolean;
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: parts.col ?? ENTRANCE.col, row: parts.row ?? ENTRANCE.row, state: 'in_battle', path: [] },
    character: { className: 'Knight', level: parts.level ?? 10, inventory: parts.inventory ?? {}, equipment: {} },
    social: {
      party: { id: 'p1', members: [{ username: 'alice', role: 'owner', gridPosition: 4 }], henchmen: parts.henchmen ?? [] },
      allPlayers: [],
    },
    itemDefinitions: {},
    dungeon: parts.inDungeon ? { dungeonId: 'd-crypt', name: 'Crypt', floor: 1, totalFloors: 1, isBossFloor: false } : undefined,
  } as unknown as ServerStateMessage;
}

function setup(initial: ServerStateMessage) {
  const stateListeners = new Set<StateListener>();
  const errorListeners = new Set<ErrorListener>();
  let lastState: ServerStateMessage | null = initial;
  const sendEnterDungeon = vi.fn(() => true);

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onServerError: (l: ErrorListener) => { errorListeners.add(l); return () => { errorListeners.delete(l); }; },
    sendEnterDungeon,
  } as unknown as GameClient;

  const popup = new DungeonEntryPopup(gameClient);
  const push = (state: ServerStateMessage) => {
    lastState = state;
    for (const l of [...stateListeners]) l(state);
  };
  const fail = (message: string, code?: ServerErrorCode) => {
    for (const l of [...errorListeners]) l(message, code);
  };
  const overlay = () => document.querySelector('.dungeon-entry-overlay') as HTMLElement;
  const enter = () => document.querySelector('.dungeon-entry-enter') as HTMLButtonElement;
  const blocked = () => document.querySelector('.dungeon-entry-blocked') as HTMLElement | null;

  return {
    popup, push, fail, sendEnterDungeon, overlay, enter, blocked,
    listenerCount: () => stateListeners.size + errorListeners.size,
  };
}

describe('DungeonEntryPopup', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
  });

  it('disables Enter with a visible reason directly above the buttons', () => {
    const t = setup(makeState({ level: 2 }));
    t.popup.show(dungeon({ minLevel: 5 }), ENTRANCE.col, ENTRANCE.row);

    expect(t.popup.isOpen).toBe(true);
    expect(t.enter().disabled).toBe(true);
    const line = t.blocked()!;
    expect(line.textContent).toBe('⚠ alice must be at least level 5 to enter.');
    expect(t.enter().getAttribute('aria-describedby')).toBe(line.id);
    const actions = document.querySelector('.dungeon-entry-actions')!;
    expect(actions.previousElementSibling?.lastElementChild).toBe(line);
  });

  it('enables Enter live when a state push clears the block', () => {
    const t = setup(makeState({ level: 2 }));
    t.popup.show(dungeon({ minLevel: 5 }), ENTRANCE.col, ENTRANCE.row);
    const button = t.enter();

    t.push(makeState({ level: 5 }));

    expect(t.enter()).toBe(button);
    expect(button.disabled).toBe(false);
    expect(t.blocked()).toBeNull();
    expect(button.hasAttribute('aria-describedby')).toBe(false);
  });

  it('tells the player their henchmen will wait, without blocking entry', () => {
    const t = setup(makeState({ henchmen: [{ instanceId: 'h1', henchmanId: 'squire' }] }));
    t.popup.show(dungeon({ maxPartySize: 1 }), ENTRANCE.col, ENTRANCE.row);

    expect(document.querySelector('.dungeon-entry-info')?.textContent).toBe('Your henchmen will wait at the entrance until you return.');
    expect(t.enter().disabled).toBe(false);
    expect(t.blocked()).toBeNull();

    t.push(makeState());
    expect(document.querySelector('.dungeon-entry-info')).toBeNull();
  });

  it('sends enter_dungeon once and shows Entering… while waiting', () => {
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);

    t.enter().click();
    t.enter().click();

    expect(t.sendEnterDungeon).toHaveBeenCalledTimes(1);
    expect(t.sendEnterDungeon).toHaveBeenCalledWith(ENTRANCE.col, ENTRANCE.row, 'd-crypt');
    expect(t.enter().textContent).toBe('Entering…');
    expect(t.enter().disabled).toBe(true);
    expect(t.enter().getAttribute('aria-busy')).toBe('true');
    expect(t.popup.isOpen).toBe(true);

    t.push(makeState());
    expect(t.enter().textContent).toBe('Entering…');
  });

  it('says so at once when the message cannot be sent', () => {
    const t = setup(makeState());
    t.sendEnterDungeon.mockReturnValueOnce(false);
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);

    t.enter().click();

    expect(t.blocked()?.textContent).toContain(OFFLINE_NOTICE);
    expect(t.enter().textContent).toBe('Enter');
    expect(t.enter().disabled).toBe(false);
  });

  it('does not send while Enter is blocked', () => {
    const t = setup(makeState({ level: 2 }));
    t.popup.show(dungeon({ minLevel: 5 }), ENTRANCE.col, ENTRANCE.row);
    t.enter().click();
    expect(t.sendEnterDungeon).not.toHaveBeenCalled();
  });

  it('shows a refusal inline and lets the player try again', () => {
    const t = setup(makeState({ inventory: { sigil: 1 } }));
    t.popup.show(dungeon({ requiredItemId: 'sigil' }), ENTRANCE.col, ENTRANCE.row);
    t.enter().click();

    t.fail('Something unrelated.');
    t.fail('Trade changed.', 'trade_nonce_mismatch');
    expect(t.enter().textContent).toBe('Entering…');

    t.fail('bob needs a key item to enter.', 'dungeon_entry_refused');

    expect(t.blocked()?.textContent).toBe('⚠ bob needs a key item to enter.');
    expect(t.enter().textContent).toBe('Enter');
    expect(t.enter().disabled).toBe(false);
    expect(t.popup.isOpen).toBe(true);

    t.enter().click();
    expect(t.sendEnterDungeon).toHaveBeenCalledTimes(2);
    expect(t.blocked()).toBeNull();
  });

  it('keeps a refusal visible across state pushes the preview cannot explain', () => {
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);
    t.enter().click();
    t.fail('Party too large — this dungeon allows at most 1.', 'dungeon_entry_refused');

    t.push(makeState());

    expect(t.blocked()?.textContent).toBe('⚠ Party too large — this dungeon allows at most 1.');
  });

  it('reports a missing answer after five seconds', () => {
    vi.useFakeTimers();
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);
    t.enter().click();

    vi.advanceTimersByTime(4999);
    expect(t.blocked()).toBeNull();
    vi.advanceTimersByTime(1);

    expect(t.blocked()?.textContent).toBe('⚠ No answer from the server. Please try again.');
    expect(t.enter().disabled).toBe(false);
    expect(t.enter().textContent).toBe('Enter');
  });

  it('closes once the party is inside the dungeon', () => {
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);
    t.enter().click();

    t.push(makeState({ inDungeon: true }));

    expect(t.popup.isOpen).toBe(false);
    expect(t.overlay().style.display).toBe('none');
    expect(t.listenerCount()).toBe(0);
  });

  it('closes when the party leaves the entrance room', () => {
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);

    t.push(makeState({ col: ENTRANCE.col + 1 }));

    expect(t.popup.isOpen).toBe(false);
  });

  it('closes on Cancel and stops listening', () => {
    const t = setup(makeState());
    t.popup.show(dungeon(), ENTRANCE.col, ENTRANCE.row);
    expect(t.overlay().style.zIndex).not.toBe('');

    (document.querySelector('.dungeon-entry-cancel') as HTMLButtonElement).click();

    expect(t.popup.isOpen).toBe(false);
    expect(t.overlay().style.zIndex).toBe('');
    expect(t.listenerCount()).toBe(0);
  });

  it('holds a state repaint while Enter is pressed so the click still lands', () => {
    vi.useFakeTimers();
    const t = setup(makeState());
    t.popup.show(dungeon({ minLevel: 5 }), ENTRANCE.col, ENTRANCE.row);
    const button = t.enter();

    button.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    t.push(makeState({ level: 2 }));
    expect(button.disabled).toBe(false);
    button.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    button.click();
    vi.advanceTimersByTime(1);

    expect(t.sendEnterDungeon).toHaveBeenCalledTimes(1);
    expect(button.textContent).toBe('Entering…');
  });
});
