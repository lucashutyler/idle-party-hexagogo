import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCombatAction, ClientMonsterState, CombatLogEntry, ServerStateMessage } from '@idle-party-rpg/shared';
import { CombatScreen } from '../src/screens/CombatScreen';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';

type StateListener = (state: ServerStateMessage) => void;

const GOBLIN: ClientMonsterState = { id: 'goblin', name: 'Goblin', currentHp: 5, maxHp: 5, gridPosition: 1 };

interface StateParts {
  monsters?: ClientMonsterState[];
  lastAction?: ClientCombatAction;
  log?: CombatLogEntry[];
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  return {
    username: 'alice',
    party: { col: 0, row: 0 },
    zoneName: 'Meadow',
    currentMapId: 'overworld',
    combatLog: parts.log ?? [],
    social: { party: { members: [{ username: 'alice', role: 'owner', gridPosition: 4 }], henchmen: [] } },
    battle: {
      visual: 'fighting',
      combat: {
        players: [{ username: 'alice', className: 'Warrior', currentHp: 10, maxHp: 10, gridPosition: 4 }],
        monsters: parts.monsters ?? [GOBLIN],
        tickCount: 1,
        roundCount: 1,
        lastAction: parts.lastAction,
      },
    },
  } as unknown as ServerStateMessage;
}

function setup() {
  document.body.innerHTML = '<div id="combat"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = makeState();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    sendRun: vi.fn(),
    sendLeaveDungeon: vi.fn(),
  } as unknown as GameClient;
  const worldCache = { getTileOn: () => null } as unknown as WorldCache;

  const screen = new CombatScreen('combat', gameClient, worldCache);
  screen.onActivate();

  const push = (parts: StateParts) => {
    lastState = makeState(parts);
    for (const l of listeners) l(lastState);
  };
  const playerCard = () => document.querySelector('.combat-player-side [data-grid="4"]') as HTMLElement;
  const enemyCard = (pos: number) => document.querySelector(`.combat-enemy-side [data-grid="${pos}"]`) as HTMLElement | null;

  return { screen, push, playerCard, enemyCard };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('CombatScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('plays the attack animation for the latest action', () => {
    const t = setup();
    t.push({ lastAction: { attackerSide: 'player', attackerPos: 4, targetSide: 'monster', targetPos: 1, dodged: false } });

    expect(t.playerCard().classList.contains('attacking')).toBe(true);
    expect(t.enemyCard(1)!.classList.contains('hit')).toBe(true);
  });

  it('keeps the class icon node across ticks', () => {
    const t = setup();
    t.push({});
    const icon = t.playerCard().querySelector('.combat-card-icon')!.firstElementChild;
    expect(icon).not.toBeNull();

    t.push({ lastAction: { attackerSide: 'monster', attackerPos: 1, targetSide: 'player', targetPos: 4, dodged: true } });
    expect(t.playerCard().querySelector('.combat-card-icon')!.firstElementChild).toBe(icon);
    expect(t.playerCard().classList.contains('dodged')).toBe(true);
  });

  it('holds a new-battle rebuild while a monster card is pressed', () => {
    const t = setup();
    t.push({});
    const card = t.enemyCard(1)!;

    press(card);
    t.push({ monsters: [{ ...GOBLIN, id: 'wolf', name: 'Wolf', gridPosition: 2 }] });
    expect(t.enemyCard(1)).toBe(card);
    expect(card.isConnected).toBe(true);

    card.click();
    expect(document.querySelector('.monster-popup-name')?.textContent).toBe('Goblin');

    vi.advanceTimersByTime(0);
    expect(t.enemyCard(1)).toBeNull();
    expect(t.enemyCard(2)!.querySelector('.combat-card-name')!.textContent).toBe('Wolf');
  });

  it('keeps appending and colouring the combat log while a card is pressed', () => {
    const t = setup();
    t.push({});
    press(t.enemyCard(1)!);

    t.push({
      monsters: [{ ...GOBLIN, id: 'wolf', name: 'Wolf', gridPosition: 2 }],
      log: [{ id: 1, text: 'Wolf attacks alice for 3 physical damage', type: 'damage' } as CombatLogEntry],
    });
    expect(t.enemyCard(2)).toBeNull();
    const entry = document.querySelector('.combat-log .log-entry')!;
    expect(entry.textContent).toBe('Wolf attacks You for 3 physical damage');
    expect(entry.querySelector('.log-name-enemy')?.textContent).toBe('Wolf');
  });
});
