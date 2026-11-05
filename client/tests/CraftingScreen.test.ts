import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClientCraftingState, RecipeDefinition, ServerStateMessage } from '@idle-party-rpg/shared';
import { MAX_CRAFT_QUEUE } from '@idle-party-rpg/shared';
import { CraftingScreen } from '../src/screens/CraftingScreen';
import { dismissTop } from '../src/ui/ModalStack';
import type { GameClient } from '../src/network/GameClient';

type StateListener = (state: ServerStateMessage) => void;

const BAR: RecipeDefinition = {
  id: 'r-bar',
  name: 'Iron Bar',
  durationSeconds: 10,
  ingredients: [{ itemId: 'ore', quantity: 2 }],
  result: { itemId: 'bar', quantity: 1 },
};

const PLATE: RecipeDefinition = {
  id: 'r-plate',
  name: 'Iron Plate',
  durationSeconds: 90,
  ingredients: [{ itemId: 'bar', quantity: 4 }],
  result: { itemId: 'plate', quantity: 1 },
};

const CROWN: RecipeDefinition = {
  id: 'r-crown',
  name: 'Iron Crown',
  requiredLevel: 30,
  durationSeconds: 5,
  ingredients: [{ itemId: 'ore', quantity: 1 }],
  result: { itemId: 'crown', quantity: 1 },
};

const WAND: RecipeDefinition = {
  id: 'r-wand',
  name: 'Iron Wand',
  classRestriction: ['Mage'],
  durationSeconds: 5,
  ingredients: [{ itemId: 'ore', quantity: 1 }],
  result: { itemId: 'wand', quantity: 1 },
};

interface StateParts {
  ore?: number;
  jobs?: string[];
  activeStartedAtMs?: number;
  recipes?: RecipeDefinition[];
}

function makeState(parts: StateParts = {}): ServerStateMessage {
  const jobs = (parts.jobs ?? []).map(recipeId => ({ recipeId }));
  const startedAtMs = parts.activeStartedAtMs ?? Date.now();
  const crafting: ClientCraftingState = {
    recipes: parts.recipes ?? [BAR],
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
      plate: { id: 'plate', name: 'Iron Plate', rarity: 'rare', equipSlot: 'chest' },
    } as ClientCraftingState['itemDefs'],
  };
  return {
    crafting,
    character: { inventory: { ore: parts.ore ?? 3 }, equipment: {}, className: 'Warrior', level: 5 },
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

  it('prebuilds while hidden with no subscription and no progress timer', () => {
    const t = setup({ ore: 3, jobs: ['r-bar'] });

    t.screen.prebuild();
    expect(t.ings()).toContain('3/2');
    expect(vi.getTimerCount()).toBe(0);

    t.push({ ore: 1, jobs: ['r-bar'] });
    expect(t.ings()).toContain('3/2');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the prebuilt nodes on the first visit when nothing changed', () => {
    const t = setup();
    t.screen.prebuild();
    const btn = t.queueBtn();

    t.screen.onActivate();

    expect(t.queueBtn()).toBe(btn);
    t.screen.onDeactivate();
  });

  it('shows the latest state on the first visit after a stale prebuild', () => {
    const t = setup({ ore: 3 });
    t.screen.prebuild();

    t.push({ ore: 1 });
    t.screen.onActivate();

    expect(t.ings()).toContain('1/2');
    t.screen.onDeactivate();
  });

  it('prebuilds nothing before the first state', () => {
    document.body.innerHTML = '<div id="craft"></div>';
    const gameClient = { lastState: null, subscribe: () => () => {} } as unknown as GameClient;
    const screen = new CraftingScreen('craft', gameClient);

    screen.prebuild();

    expect(document.querySelector('.craft-recipes-section')!.innerHTML).toBe('');
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
    expect(fill.style.transform).toBe('scaleX(0.5)');
    expect(status.textContent).toBe('5s remaining');

    t.push({ jobs: ['r-bar'], activeStartedAtMs: startedAt });
    expect(document.querySelector('.craft-progress-fill[data-active="1"]')).toBe(fill);
    expect(fill.style.transform).toBe('scaleX(0.5)');
    t.screen.onDeactivate();
  });

  it('ticks once a second while a job runs and not at all otherwise', () => {
    const t = setup({ jobs: ['r-bar'], activeStartedAtMs: Date.now() - 5_000 });
    t.screen.onActivate();
    expect(vi.getTimerCount()).toBe(1);
    const fill = document.querySelector('.craft-progress-fill[data-active="1"]') as HTMLElement;
    const status = document.querySelector('.craft-queue-status[data-active="1"]') as HTMLElement;

    vi.advanceTimersByTime(1_000);
    expect(fill.style.transform).toBe('scaleX(0.6)');
    expect(status.textContent).toBe('4s remaining');

    t.push({ jobs: [] });
    expect(vi.getTimerCount()).toBe(0);

    t.push({ jobs: ['r-bar'] });
    expect(vi.getTimerCount()).toBe(1);
    t.screen.onDeactivate();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('runs no timer on an idle screen', () => {
    const t = setup();
    t.screen.onActivate();
    expect(vi.getTimerCount()).toBe(0);
    t.screen.onDeactivate();
  });

  describe('recipe list', () => {
    const names = () => [...document.querySelectorAll('.craft-recipe-name')].map(el => el.firstChild?.textContent);
    const reason = (recipeId: string) => document
      .querySelector(`[data-recipe-id="${recipeId}"]`)!
      .closest('.craft-recipe-card')!
      .querySelector('.craft-recipe-reason')?.textContent;
    const segment = (id: string) => document.querySelector(`[data-seg="${id}"]`) as HTMLElement;

    it('sorts craftable first, then missing materials, then level, then class', () => {
      const t = setup({ ore: 3, recipes: [WAND, CROWN, PLATE, BAR] });
      t.screen.onActivate();
      expect(names()).toEqual(['Iron Bar', 'Iron Plate', 'Iron Crown', 'Iron Wand']);
      t.screen.onDeactivate();
    });

    it('prints why a recipe is blocked', () => {
      const t = setup({ ore: 3, recipes: [BAR, PLATE, CROWN, WAND] });
      t.screen.onActivate();
      expect(reason('r-bar')).toBeUndefined();
      expect(reason('r-plate')).toBe('Missing materials');
      expect(reason('r-crown')).toBe('Requires level 30');
      expect(reason('r-wand')).toBe('Mage only');
      t.screen.onDeactivate();
    });

    it('filters to craftable recipes, and still counts them with a full queue', () => {
      const jobs = Array.from({ length: MAX_CRAFT_QUEUE }, () => 'r-bar');
      const t = setup({ ore: 3, jobs, recipes: [BAR, PLATE] });
      t.screen.onActivate();
      expect(reason('r-bar')).toBe('Queue is full');
      expect(t.queueBtn().disabled).toBe(true);

      segment('craftable').click();
      expect(names()).toEqual(['Iron Bar']);
      expect(segment('craftable').querySelector('.ui-segment-badge')?.textContent).toBe('1');

      segment('all').click();
      expect(names()).toEqual(['Iron Bar', 'Iron Plate']);
      t.screen.onDeactivate();
    });

    it('explains an empty craftable list', () => {
      const t = setup({ ore: 0 });
      t.screen.onActivate();
      segment('craftable').click();
      expect(document.querySelector('.craft-recipes-section .ui-empty')?.textContent).toContain('Nothing you can craft');
      t.screen.onDeactivate();
    });

    it('keeps the segment row across a push that only changes a recipe', () => {
      const t = setup({ ore: 3 });
      t.screen.onActivate();
      const seg = segment('all');
      t.push({ ore: 4 });
      expect(segment('all')).toBe(seg);
      t.screen.onDeactivate();
    });

    it('opens the result on a tap and closes it through the modal stack', () => {
      const t = setup({ ore: 3, recipes: [PLATE] });
      t.screen.onActivate();
      (document.querySelector('.craft-recipe-media') as HTMLElement).click();
      expect(document.querySelector('.item-popup-name')?.textContent).toBe('Iron Plate');
      expect(t.sendCraftQueue).not.toHaveBeenCalled();

      expect(dismissTop()).toBe(true);
      expect(document.querySelector('.item-popup')).toBeNull();
      t.screen.onDeactivate();
    });

    it('closes an open result when the screen is left', () => {
      const t = setup({ ore: 3, recipes: [PLATE] });
      t.screen.onActivate();
      (document.querySelector('.craft-recipe-media') as HTMLElement).click();
      t.screen.onDeactivate();
      expect(document.querySelector('.item-popup')).toBeNull();
      expect(dismissTop()).toBe(false);
    });
  });
});
