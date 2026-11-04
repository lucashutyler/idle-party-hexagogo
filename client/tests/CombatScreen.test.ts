import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ClientCombatSnapshot,
  ClientCombatUnit,
  CombatEvent,
  CombatLogEntry,
  ServerCombatMessage,
  ServerStateMessage,
} from '@idle-party-rpg/shared';
import { CombatScreen } from '../src/screens/CombatScreen';
import { CombatLogBuffer } from '../src/combat/CombatLogBuffer';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;
type CombatListener = (msg: ServerCombatMessage, receivedAt: number) => void;

const ALICE: ClientCombatUnit = { side: 'player', pos: 4, hp: 10, maxHp: 10, actionMs: 800, actionTotalMs: 1000, name: 'alice', className: 'Knight' };
const GOBLIN: ClientCombatUnit = { side: 'monster', pos: 1, hp: 5, maxHp: 5, actionMs: 600, actionTotalMs: 1000, name: 'Goblin', id: 'goblin' };
const WOLF: ClientCombatUnit = { ...GOBLIN, pos: 2, name: 'Wolf', id: 'wolf' };
const FRAME_MS = 16;
const PLAYBACK_DUE_MS = 400;
const LOG_REPAINT_MS = 300;

function snapshot(battleId: number, monster: ClientCombatUnit, elapsedMs = 1000): ClientCombatSnapshot {
  return { battleId, elapsedMs, full: true, finished: false, result: null, units: [ALICE, monster] };
}

function makeState(battleId: number, monster: ClientCombatUnit, log: CombatLogEntry[]): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: 0, row: 0 },
    zoneName: 'Meadow',
    currentMapId: 'overworld',
    combatLog: log,
    social: { party: { members: [{ username: 'alice', role: 'owner', gridPosition: 4 }], henchmen: [] } },
    battle: { visual: 'fighting', combat: snapshot(battleId, monster) },
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '<div id="combat"></div>';
  const stateListeners = new Set<StateListener>();
  const combatListeners = new Set<CombatListener>();
  const combatLog = new CombatLogBuffer();
  let lastState: ServerStateMessage = makeState(1, GOBLIN, []);

  const gameClient = {
    get lastState() { return lastState; },
    lastCombat: null,
    lastBestiary: null,
    combatLog,
    subscribe: (l: StateListener) => { stateListeners.add(l); return () => { stateListeners.delete(l); }; },
    onCombat: (l: CombatListener) => { combatListeners.add(l); return () => { combatListeners.delete(l); }; },
    onForecast: () => () => {},
    peekForecast: () => null,
    sendCombatView: vi.fn(),
    sendRun: vi.fn(),
    sendLeaveDungeon: vi.fn(),
  } as unknown as GameClient;
  const worldCache = {
    getTileOn: () => null,
    getSkill: () => undefined,
    getSlotSchedule: () => [],
  } as unknown as WorldCache;

  const screen = new CombatScreen('combat', gameClient, worldCache);
  screen.onActivate();
  vi.advanceTimersByTime(FRAME_MS);

  const pushState = (battleId: number, monster: ClientCombatUnit, log: CombatLogEntry[] = []) => {
    lastState = makeState(battleId, monster, log);
    combatLog.ingestJournal(log);
    for (const l of stateListeners) l(lastState);
  };
  const playEvents = (events: CombatEvent[]) => {
    const msg: ServerCombatMessage = { type: 'combat', battleId: 1, events, log: [] };
    for (const l of combatListeners) l(msg, performance.now());
    vi.advanceTimersByTime(PLAYBACK_DUE_MS);
  };
  const playerCard = () => document.querySelector('.combat-player-side .combat-card[data-grid="4"]') as HTMLElement;
  const enemyCard = (pos: number) => document.querySelector(`.combat-enemy-side .combat-card[data-grid="${pos}"]`) as HTMLElement | null;

  return { screen, pushState, playEvents, playerCard, enemyCard };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('CombatScreen', () => {
  let active: CombatScreen | null = null;
  const start = () => {
    const t = setup();
    active = t.screen;
    return t;
  };

  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame', 'performance', 'Date'],
    });
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 100, 100));
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    active?.onDeactivate();
    active = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('draws a live combat event on the unit it hit', () => {
    const t = start();
    const flash = t.enemyCard(1)!.querySelector('.combat-card-flash')!;
    const animate = vi.fn();
    (flash as unknown as { animate: unknown }).animate = animate;

    t.playEvents([{ id: 1, t: 1100, kind: 'damage', src: { side: 'player', pos: 4 }, dst: { side: 'monster', pos: 1 }, amount: 3, dmgType: 'physical' }]);

    expect(animate).toHaveBeenCalled();
    expect(document.querySelector('.combat-floater.live')?.textContent).toContain('3');
  });

  it('keeps the card icon nodes across updates', () => {
    const t = start();
    const initials = t.playerCard().querySelector('.combat-card-icon')!;
    const classIcon = t.playerCard().querySelector('.combat-card-classicon')!;
    expect(classIcon.getAttribute('src')).toBe('/class-icons/Knight.png');
    const setAttr = vi.spyOn(classIcon, 'setAttribute');

    t.pushState(1, GOBLIN);
    t.playEvents([{ id: 1, t: 1100, kind: 'dodge', src: { side: 'monster', pos: 1 }, dst: { side: 'player', pos: 4 } }]);

    expect(t.playerCard().querySelector('.combat-card-icon')).toBe(initials);
    expect(t.playerCard().querySelector('.combat-card-classicon')).toBe(classIcon);
    expect(setAttr).not.toHaveBeenCalled();
    expect(document.querySelector('.combat-floater.live')?.textContent).toBe('DODGE');
  });

  it('holds a new-battle rebuild while a monster card is pressed', () => {
    const t = start();
    const card = t.enemyCard(1)!;

    press(card);
    t.pushState(2, WOLF);
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(t.enemyCard(1)).toBe(card);
    expect(card.isConnected).toBe(true);
    expect(t.enemyCard(2)).toBeNull();

    card.click();
    expect(document.querySelector('.monster-popup-name')?.textContent).toBe('Goblin');

    vi.advanceTimersByTime(FRAME_MS * 2);
    expect(t.enemyCard(1)).toBeNull();
    expect(t.enemyCard(2)!.querySelector('.combat-card-name')!.textContent).toBe('Wolf');
  });

  it('keeps appending and colouring the combat log while a card is pressed', () => {
    const t = start();
    press(t.enemyCard(1)!);

    t.pushState(2, WOLF, [{ id: 1, text: 'Wolf attacks alice for 3 physical damage', type: 'damage' } as CombatLogEntry]);
    vi.advanceTimersByTime(LOG_REPAINT_MS);

    expect(t.enemyCard(2)).toBeNull();
    const entry = document.querySelector('.combat-log-ticker .log-entry')!;
    expect(entry.textContent).toBe('Wolf attacks you for 3 physical damage');
    expect(entry.querySelector('.log-name-enemy')?.textContent).toBe('Wolf');
    expect(entry.querySelector('.log-name-self')?.textContent).toBe('you');
  });
});
