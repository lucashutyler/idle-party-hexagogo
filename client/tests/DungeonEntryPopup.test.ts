import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  DungeonDefinition,
  DungeonEntryRequirements,
  ForecastResult,
  HiredHenchman,
  ServerErrorCode,
  ServerForecastMessage,
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
    requestForecast: () => null,
    peekForecast: () => null,
    onForecast: () => () => {},
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

const trial: DungeonDefinition = {
  id: 'trial',
  name: 'Crystal Caves Trial',
  description: 'A trial.',
  floors: [
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [] },
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [] },
    { gridShape: { cols: 3, rows: 3 }, encounterTable: [], isBoss: true, checkpoints: [0.66, 0.33], maxWipes: 3 },
  ],
  entryRequirements: { minLevel: 5 },
} as unknown as DungeonDefinition;

function result(overrides: Partial<ForecastResult> = {}): ForecastResult {
  return {
    key: 'v|1|pk1|dungeon:trial:0', partyKey: 'pk1', sims: 40, wins: 28, losses: 12, stalemates: 0,
    winPct: 70, ci: [55, 82], medianMs: 12 * 60_000, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [],
    floors: [{ floor: 1, winPct: 100 }, { floor: 2, winPct: 100 }, { floor: 3, winPct: 70, boss: true }],
    ...overrides,
  };
}

function fakeClient(cached: ServerForecastMessage | null = null, previous: ServerForecastMessage | null = null) {
  let listener: ((msg: ServerForecastMessage) => void) | null = null;
  const stateListeners = new Set<() => void>();
  return {
    lastState: { party: { col: 1, row: 2 }, social: { party: { forecastKey: 'pk1' } }, itemDefinitions: {} },
    requestForecast: vi.fn(() => cached),
    peekForecast: vi.fn(() => previous),
    sendEnterDungeon: vi.fn(() => true),
    subscribe(cb: () => void) {
      stateListeners.add(cb);
      return () => { stateListeners.delete(cb); };
    },
    onServerError: () => () => {},
    pushState() {
      for (const cb of [...stateListeners]) cb();
    },
    onForecast(cb: (msg: ServerForecastMessage) => void) {
      listener = cb;
      return () => { listener = null; };
    },
    emit(msg: ServerForecastMessage) {
      listener?.(msg);
    },
    get listening() {
      return listener !== null;
    },
  };
}

function message(r: ForecastResult | null, status: ServerForecastMessage['status'] = 'ok'): ServerForecastMessage {
  return { type: 'forecast', target: { kind: 'dungeon', dungeonId: 'trial' }, key: r?.key ?? '', result: r, status };
}

describe('DungeonEntryPopup forecast and leader rules', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
  });

  it('opens on the modal stack and releases on hide', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const overlay = document.querySelector('.dungeon-entry-overlay') as HTMLElement;
    expect(overlay.style.display).toBe('flex');
    expect(parseInt(overlay.style.zIndex, 10)).toBeGreaterThanOrEqual(1500);
    popup.hide();
    expect(overlay.style.display).toBe('none');
    expect(overlay.style.zIndex).toBe('');
    expect(client.listening).toBe(false);
  });

  it('requests the dungeon forecast and shows a loading card until it arrives', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    expect(client.requestForecast).toHaveBeenCalledWith({ kind: 'dungeon', dungeonId: 'trial' });
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('loading');
    expect(card.querySelectorAll('.dungeon-floor-pip')).toHaveLength(3);

    client.emit(message(result()));
    expect(card.dataset.state).toBe('ready');
    expect(card.querySelector('.dungeon-entry-forecast-verdict')!.textContent).toBe('Likely');
    expect(card.querySelector('.dungeon-entry-forecast-headline')!.textContent).toBe('Clears ~7 in 10 runs · ~12 min each');
    expect(card.textContent).not.toContain('first try');
    expect(card.textContent).toContain('Win chance ~70\u202f%, likely 55–82\u202f%');
    expect(card.querySelector('.forecast-foot')!.textContent).toBe('Estimate from 40 simulated runs');
    popup.hide();
  });

  it('marks the floor strip', () => {
    const client = fakeClient(message(result()));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const pips = [...document.querySelectorAll<HTMLElement>('.dungeon-floor-pip')];
    expect(pips[2].dataset.boss).toBe('true');
    expect(pips[2].dataset.checkpoint).toBeUndefined();
    expect(pips[2].getAttribute('aria-label')).toBe('Floor 3, boss: wins 70\u202f%');
    expect(pips[2].dataset.band).toBe('1');
    expect(pips.map(p => p.querySelector('.dungeon-floor-glyph')!.textContent)).toEqual(['1', '2', '♛']);
    popup.hide();
  });

  it('shows the floors the forecast lists and leaves the others plain', () => {
    const client = fakeClient(message(result({ floors: [{ floor: 3, winPct: 0, boss: true }] })));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const pips = [...document.querySelectorAll<HTMLElement>('.dungeon-floor-pip')];
    expect(pips.map(p => p.dataset.boss ?? '')).toEqual(['', '', 'true']);
    expect(pips.map(p => p.dataset.band ?? '')).toEqual(['', '', '3']);
    popup.hide();
  });

  it('never promises a resume, even from a forecast key with a later start', () => {
    const client = fakeClient(message(result({ key: 'v|1|pk1|dungeon:trial:2' })));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    expect(document.querySelector('.dungeon-entry-modal')!.textContent).not.toContain('Resume');
    expect(document.querySelector('.dungeon-floor-pip[data-resume]')).toBeNull();
    expect(document.querySelector('.dungeon-floor-pip[data-passed]')).toBeNull();
    popup.hide();
  });

  it('warns that a defeat ends the run, whatever old fields a stored floor still carries', () => {
    const warning = 'If your party is defeated on any floor, the run ends and you\'ll be sent back to this entrance.';
    const popup = new DungeonEntryPopup(fakeClient() as unknown as GameClient);
    popup.show(trial, 1, 2);
    expect(document.querySelector('.dungeon-entry-warning')!.textContent).toBe(warning);
    popup.show({ ...trial, floors: [trial.floors[0]] } as DungeonDefinition, 1, 2);
    expect(document.querySelector('.dungeon-entry-warning')!.textContent).toBe(warning);
    popup.hide();
  });

  it('is read-only for members, with a note on who can enter', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2, { canEnter: false });
    const enter = document.querySelector('.dungeon-entry-enter') as HTMLButtonElement;
    expect(enter.disabled).toBe(true);
    enter.click();
    expect(client.sendEnterDungeon).not.toHaveBeenCalled();
    expect(document.querySelector('.dungeon-entry-note')!.textContent).toBe('Only the party owner or a leader can enter.');
    expect(enter.title).toBe('Only the party owner or a leader can enter.');
    popup.hide();
  });

  it('enters for leaders', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    expect(document.querySelector('.dungeon-entry-note')).toBeNull();
    (document.querySelector('.dungeon-entry-enter') as HTMLButtonElement).click();
    expect(client.sendEnterDungeon).toHaveBeenCalledWith(1, 2, 'trial');
    popup.hide();
  });

  it('keeps Enter disabled for members across state pushes', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2, { canEnter: false });
    client.pushState();
    expect((document.querySelector('.dungeon-entry-enter') as HTMLButtonElement).disabled).toBe(true);
    popup.hide();
  });

  it('closes on Escape and stops listening for key presses', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const escape = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true });
    document.dispatchEvent(escape);
    expect(popup.isOpen).toBe(false);
    expect(escape.defaultPrevented).toBe(true);
    expect(client.listening).toBe(false);
  });

  it('applies a forecast held by a press even when a state push follows it', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;

    document.querySelector('.dungeon-entry-cancel')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    client.emit(message(result()));
    client.pushState();
    expect(card.dataset.state).toBe('loading');

    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(card.dataset.state).toBe('ready');
    popup.hide();
  });

  it('keeps showing the last estimate, dimmed, when the server cannot compute a new one', () => {
    const client = fakeClient(message(null, 'unavailable'), message(result()));
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('stale');
    expect(card.querySelector('.forecast-foot')!.textContent).toContain('updating…');
    client.emit(message(null, 'unavailable'));
    expect(card.dataset.state).toBe('stale');
    popup.hide();
  });

  it('hides the forecast when unavailable and nothing was estimated before', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    client.emit(message(null, 'unavailable'));
    expect((document.querySelector('.dungeon-entry-forecast') as HTMLElement).dataset.state).toBe('none');
    popup.hide();
  });

  it('marks results for another party as stale and hides denied forecasts', () => {
    const client = fakeClient();
    const popup = new DungeonEntryPopup(client as unknown as GameClient);
    popup.show(trial, 1, 2);
    client.emit(message(result({ partyKey: 'old' })));
    const card = document.querySelector('.dungeon-entry-forecast') as HTMLElement;
    expect(card.dataset.state).toBe('stale');
    client.emit(message(null, 'denied'));
    expect(card.dataset.state).toBe('none');
    client.emit({ ...message(result()), target: { kind: 'dungeon', dungeonId: 'other' } });
    expect(card.dataset.state).toBe('none');
    popup.hide();
  });
});
