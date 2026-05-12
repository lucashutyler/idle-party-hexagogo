import { describe, it, expect } from 'vitest';
import {
  emptyCraftQueue,
  enqueueRecipe,
  cancelJobAt,
  processCompletions,
  getActiveJobProgress,
  canQueueRecipe,
  getVisibleRecipes,
  MAX_CRAFT_QUEUE,
  CRAFTING_UNLOCK_LEVEL,
  type RecipeDefinition,
} from '../src/systems/CraftingTypes';
import { MAX_STACK } from '../src/systems/ItemTypes';

const recipe: RecipeDefinition = {
  id: 'r1',
  name: 'R1',
  durationSeconds: 10,
  ingredients: [{ itemId: 'pelt', quantity: 2 }],
  result: { itemId: 'cloak', quantity: 1 },
};

const recipeFast: RecipeDefinition = {
  ...recipe,
  id: 'r2',
  name: 'R2',
  durationSeconds: 5,
};

const knightOnly: RecipeDefinition = {
  ...recipe,
  id: 'r3',
  classRestriction: ['Knight'],
};

const recipes = { r1: recipe, r2: recipeFast, r3: knightOnly };

describe('CraftingTypes — canQueueRecipe', () => {
  it('rejects when level too low', () => {
    const res = canQueueRecipe(recipe, { pelt: 5 }, emptyCraftQueue(), 'Knight', CRAFTING_UNLOCK_LEVEL - 1);
    expect(res).toEqual({ ok: false, reason: 'level_too_low' });
  });

  it('rejects when class restriction does not match', () => {
    const res = canQueueRecipe(knightOnly, { pelt: 5 }, emptyCraftQueue(), 'Mage', CRAFTING_UNLOCK_LEVEL);
    expect(res).toEqual({ ok: false, reason: 'class_restricted' });
  });

  it('rejects when ingredients missing', () => {
    const res = canQueueRecipe(recipe, { pelt: 1 }, emptyCraftQueue(), 'Knight', CRAFTING_UNLOCK_LEVEL);
    expect(res).toEqual({ ok: false, reason: 'missing_ingredients' });
  });

  it('rejects when queue full', () => {
    const queue = emptyCraftQueue();
    queue.activeStartedAtMs = 1000;
    queue.jobs = Array.from({ length: MAX_CRAFT_QUEUE }, () => ({ recipeId: 'r1' }));
    const res = canQueueRecipe(recipe, { pelt: 99 }, queue, 'Knight', CRAFTING_UNLOCK_LEVEL);
    expect(res).toEqual({ ok: false, reason: 'queue_full' });
  });

  it('accepts a valid request', () => {
    const res = canQueueRecipe(recipe, { pelt: 2 }, emptyCraftQueue(), 'Knight', CRAFTING_UNLOCK_LEVEL);
    expect(res).toEqual({ ok: true });
  });
});

describe('CraftingTypes — enqueueRecipe', () => {
  it('reserves ingredients (deducts from inventory) on enqueue', () => {
    const inv = { pelt: 5 };
    const q = emptyCraftQueue();
    const res = enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    expect(res).toEqual({ ok: true });
    expect(inv).toEqual({ pelt: 3 });
    expect(q.jobs).toEqual([{ recipeId: 'r1' }]);
    expect(q.activeStartedAtMs).toBe(1000);
  });

  it('appends FIFO without changing activeStartedAtMs', () => {
    const inv = { pelt: 10 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 5000);
    expect(q.jobs.length).toBe(2);
    expect(q.activeStartedAtMs).toBe(1000); // first job's start time preserved
    expect(inv).toEqual({ pelt: 6 });
  });

  it('does not deduct or queue on failure', () => {
    const inv = { pelt: 1 };
    const q = emptyCraftQueue();
    const res = enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    expect(res.ok).toBe(false);
    expect(inv).toEqual({ pelt: 1 });
    expect(q.jobs.length).toBe(0);
  });
});

describe('CraftingTypes — cancelJobAt', () => {
  it('refunds ingredients and removes the job', () => {
    const inv = { pelt: 3 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000); // pelt: 1
    const ok = cancelJobAt(0, recipes, inv, q, 2000);
    expect(ok).toBe(true);
    expect(inv).toEqual({ pelt: 3 });
    expect(q.jobs.length).toBe(0);
    expect(q.activeStartedAtMs).toBeNull();
  });

  it('cancelling head resets next job to start now', () => {
    const inv = { pelt: 10 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    cancelJobAt(0, recipes, inv, q, 5000);
    expect(q.jobs.length).toBe(1);
    expect(q.activeStartedAtMs).toBe(5000);
  });

  it('cancelling middle/tail does not affect head start time', () => {
    const inv = { pelt: 10 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    cancelJobAt(1, recipes, inv, q, 5000);
    expect(q.jobs.length).toBe(1);
    expect(q.activeStartedAtMs).toBe(1000);
  });

  it('returns false for invalid index', () => {
    const inv = { pelt: 3 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    expect(cancelJobAt(99, recipes, inv, q, 2000)).toBe(false);
  });

  it('caps refund at MAX_STACK (overflow lost)', () => {
    const inv: Record<string, number> = { pelt: MAX_STACK - 1 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000); // pelt: MAX_STACK - 3
    cancelJobAt(0, recipes, inv, q, 2000); // refund 2 → MAX_STACK - 1, still under cap
    expect(inv.pelt).toBe(MAX_STACK - 1);
  });
});

describe('CraftingTypes — processCompletions', () => {
  it('produces nothing before duration elapses', () => {
    const inv = { pelt: 5 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const events = processCompletions(recipes, inv, q, 5000); // only 4s passed of 10s
    expect(events).toEqual([]);
    expect(q.jobs.length).toBe(1);
  });

  it('completes one job and adds result', () => {
    const inv: Record<string, number> = { pelt: 5 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const events = processCompletions(recipes, inv, q, 11_500); // 10.5s elapsed
    expect(events.length).toBe(1);
    expect(events[0].quantityProduced).toBe(1);
    expect(events[0].quantityLost).toBe(0);
    expect(inv.cloak).toBe(1);
    expect(q.jobs.length).toBe(0);
    expect(q.activeStartedAtMs).toBeNull();
  });

  it('completes multiple chained jobs in one call (offline catch-up)', () => {
    const inv: Record<string, number> = { pelt: 6 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    // 3 jobs × 10s = 30s; advance 31s
    const events = processCompletions(recipes, inv, q, 32_000);
    expect(events.length).toBe(3);
    expect(inv.cloak).toBe(3);
    expect(q.jobs.length).toBe(0);
  });

  it('partial drain — 2 of 3 jobs complete', () => {
    const inv: Record<string, number> = { pelt: 6 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const events = processCompletions(recipes, inv, q, 22_000); // 21s elapsed
    expect(events.length).toBe(2);
    expect(q.jobs.length).toBe(1);
    expect(q.activeStartedAtMs).toBe(21_000); // 1000 + 20_000 (two jobs done)
  });

  it('drops a job whose recipe was deleted', () => {
    const inv: Record<string, number> = { pelt: 4 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    // Recipe map without r1
    const events = processCompletions({ r2: recipeFast }, inv, q, 12_000);
    expect(events).toEqual([]);
    expect(q.jobs.length).toBe(0);
  });

  it('caps result at MAX_STACK and reports loss', () => {
    const inv: Record<string, number> = { pelt: 2, cloak: MAX_STACK };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const events = processCompletions(recipes, inv, q, 12_000);
    expect(events.length).toBe(1);
    expect(events[0].quantityProduced).toBe(0);
    expect(events[0].quantityLost).toBe(1);
    expect(inv.cloak).toBe(MAX_STACK);
  });
});

describe('CraftingTypes — getActiveJobProgress', () => {
  it('returns null for empty queue', () => {
    expect(getActiveJobProgress(recipes, emptyCraftQueue(), 0)).toBeNull();
  });

  it('reports elapsed and remaining time', () => {
    const inv = { pelt: 2 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const p = getActiveJobProgress(recipes, q, 4000);
    expect(p).not.toBeNull();
    expect(p!.elapsedMs).toBe(3000);
    expect(p!.remainingMs).toBe(7000);
    expect(p!.durationMs).toBe(10_000);
  });

  it('clamps elapsed at duration', () => {
    const inv = { pelt: 2 };
    const q = emptyCraftQueue();
    enqueueRecipe(recipe, inv, q, 'Knight', CRAFTING_UNLOCK_LEVEL, 1000);
    const p = getActiveJobProgress(recipes, q, 999_999);
    expect(p!.elapsedMs).toBe(10_000);
    expect(p!.remainingMs).toBe(0);
  });
});

describe('CraftingTypes — getVisibleRecipes', () => {
  it('hides class-restricted recipes from other classes', () => {
    const visible = getVisibleRecipes(recipes, 'Mage');
    expect(visible.map(r => r.id).sort()).toEqual(['r1', 'r2']);
  });

  it('shows class-restricted recipes to matching class', () => {
    const visible = getVisibleRecipes(recipes, 'Knight');
    expect(visible.map(r => r.id).sort()).toEqual(['r1', 'r2', 'r3']);
  });

  it('hides class-restricted recipes when no class set', () => {
    const visible = getVisibleRecipes(recipes, null);
    expect(visible.map(r => r.id).sort()).toEqual(['r1', 'r2']);
  });
});
