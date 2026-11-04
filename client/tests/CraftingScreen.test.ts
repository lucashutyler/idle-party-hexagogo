import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCraftingState, RecipeDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { CraftingScreen } from '../src/screens/CraftingScreen';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;

const BAR: RecipeDefinition = {
  id: 'r-bar',
  name: 'Iron Bar',
  durationSeconds: 10,
  ingredients: [{ itemId: 'ore', quantity: 2 }],
  result: { itemId: 'bar', quantity: 1 },
};

interface StateParts {
  ore?: number;
  jobs?: string[];
  activeStartedAtMs?: number;
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  const jobs = (parts.jobs ?? []).map(recipeId => ({ recipeId }));
  const startedAtMs = parts.activeStartedAtMs ?? Date.now();
  const crafting: ClientCraftingState = {
    recipes: [BAR],
    queue: { activeStartedAtMs: jobs.length > 0 ? startedAtMs : null, jobs },
    activeProgress: jobs.length > 0
      ? { recipeId: jobs[0].recipeId, startedAtMs, durationMs: 10_000, elapsedMs: 0, remainingMs: 10_000 }
      : null,
    skillName: 'Smithing',
    skillLevel: 1,
    skillXp: 0,
    skillXpForNext: 100,
    itemDefs: {
      ore: { id: 'ore', name: 'Ore', rarity: 'common' },
      bar: { id: 'bar', name: 'Bar', rarity: 'common' },
    } as ClientCraftingState['itemDefs'],
  };
  return {
    crafting,
    character: { inventory: { ore: parts.ore ?? 3 }, className: 'Warrior', level: 5 },
    itemDefinitions: {},
  } as unknown as ServerStateMessage;
}

function setup(initial: StateParts = {}) {
  document.body.innerHTML = '<div id="craft"></div>';
  const listeners = new Set<StateListener>();
  let lastState: ServerStateMessage | null = makeState(initial);
  const sendCraftQueue = vi.fn();
  const sendCraftCancel = vi.fn();

  const gameClient = {
    get lastState() { return lastState; },
    subscribe: (l: StateListener) => { listeners.add(l); return () => { listeners.delete(l); }; },
    sendCraftQueue,
    sendCraftCancel,
  } as unknown as GameClient;

  const screen = new CraftingScreen('craft', gameClient);

  const push = (parts: StateParts) => {
    lastState = makeState(parts);
    for (const l of listeners) l(lastState);
  };

  const queueBtn = () => document.querySelector('.craft-queue-btn') as HTMLButtonElement;
  const cancelBtn = () => document.querySelector('.craft-cancel-btn') as HTMLButtonElement | null;
  const ings = () => document.querySelector('.craft-recipe-ings')!.textContent;

  return { screen, push, queueBtn, cancelBtn, ings, sendCraftQueue, sendCraftCancel };
}

function press(target: Element): void {
  target.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
}

describe('CraftingScreen', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    document.dispatchEvent(new PointerEvent('pointercancel'));
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('keeps button nodes across an identical state push', () => {
    const t = setup();
    t.screen.onActivate();
    const btn = t.queueBtn();

    t.push({});
    expect(t.queueBtn()).toBe(btn);
    t.screen.onDeactivate();
  });

  it('queues and cancels through the delegated listener', () => {
    const t = setup({ ore: 3, jobs: ['r-bar'] });
    t.screen.onActivate();

    t.queueBtn().click();
    expect(t.sendCraftQueue).toHaveBeenCalledWith('r-bar');

    t.cancelBtn()!.click();
    expect(t.sendCraftCancel).toHaveBeenCalledWith(0);
    t.screen.onDeactivate();
  });

  it('ignores clicks on a disabled Queue button', () => {
    const t = setup({ ore: 1 });
    t.screen.onActivate();
    expect(t.queueBtn().disabled).toBe(true);

    t.queueBtn().click();
    expect(t.sendCraftQueue).not.toHaveBeenCalled();
    t.screen.onDeactivate();
  });

  it('holds a changed push while Queue is pressed, then applies it after the click', () => {
    const t = setup({ ore: 3 });
    t.screen.onActivate();
    const btn = t.queueBtn();
    expect(t.ings()).toContain('Ore 3/2');

    press(btn);
    t.push({ ore: 5 });
    expect(t.queueBtn()).toBe(btn);
    expect(btn.isConnected).toBe(true);
    expect(t.ings()).toContain('Ore 3/2');

    btn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    btn.click();
    expect(t.sendCraftQueue).toHaveBeenCalledWith('r-bar');

    vi.advanceTimersByTime(0);
    expect(t.ings()).toContain('Ore 5/2');
    t.screen.onDeactivate();
  });

  it('does not paint a held push after the screen is deactivated', () => {
    const t = setup({ ore: 3 });
    t.screen.onActivate();
    press(t.queueBtn());
    t.push({ ore: 5 });
    t.screen.onDeactivate();

    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(t.ings()).toContain('Ore 3/2');
  });

  it('fills the active job progress in place and keeps it across identical pushes', () => {
    const startedAt = Date.now() - 5_000;
    const t = setup({ jobs: ['r-bar'], activeStartedAtMs: startedAt });
    t.screen.onActivate();
    const fill = document.querySelector('.craft-progress-fill[data-active="1"]') as HTMLElement;
    const status = document.querySelector('.craft-queue-status[data-active="1"]') as HTMLElement;
    expect(fill.style.width).toBe('50%');
    expect(status.textContent).toBe('5s remaining');

    t.push({ jobs: ['r-bar'], activeStartedAtMs: startedAt });
    expect(document.querySelector('.craft-progress-fill[data-active="1"]')).toBe(fill);
    expect(fill.style.width).toBe('50%');
    t.screen.onDeactivate();
  });
});
