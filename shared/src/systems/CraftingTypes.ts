import { MAX_STACK } from './ItemTypes.js';

export const CRAFTING_UNLOCK_LEVEL = 20;
export const MAX_CRAFT_QUEUE = 5;

export interface RecipeIngredient {
  itemId: string;
  quantity: number;
}

export interface RecipeResult {
  itemId: string;
  quantity: number;
}

export interface RecipeDefinition {
  id: string;
  name: string;
  description?: string;
  /** If present, only these classes can craft this recipe. */
  classRestriction?: string[];
  /** Defaults to CRAFTING_UNLOCK_LEVEL when omitted. */
  requiredLevel?: number;
  durationSeconds: number;
  /** Craft skill XP granted on completion. Default 0 if omitted. */
  xpReward?: number;
  ingredients: RecipeIngredient[];
  result: RecipeResult;
}

export interface CraftJob {
  recipeId: string;
}

/**
 * Per-player FIFO craft queue.
 * `activeStartedAtMs` is the wall-clock start of jobs[0]; subsequent jobs start when
 * the previous one completes. When the queue is empty, activeStartedAtMs is null.
 */
export interface CraftQueueState {
  activeStartedAtMs: number | null;
  jobs: CraftJob[];
}

export function emptyCraftQueue(): CraftQueueState {
  return { activeStartedAtMs: null, jobs: [] };
}

export type EnqueueError =
  | 'queue_full'
  | 'unknown_recipe'
  | 'level_too_low'
  | 'class_restricted'
  | 'missing_ingredients';

export function canQueueRecipe(
  recipe: RecipeDefinition,
  inventory: Record<string, number>,
  queue: CraftQueueState,
  className: string | null,
  level: number,
): { ok: true } | { ok: false; reason: EnqueueError } {
  if (queue.jobs.length >= MAX_CRAFT_QUEUE) return { ok: false, reason: 'queue_full' };
  const requiredLevel = recipe.requiredLevel ?? CRAFTING_UNLOCK_LEVEL;
  if (level < requiredLevel) return { ok: false, reason: 'level_too_low' };
  if (recipe.classRestriction && recipe.classRestriction.length > 0) {
    if (!className || !recipe.classRestriction.includes(className)) {
      return { ok: false, reason: 'class_restricted' };
    }
  }
  for (const ing of recipe.ingredients) {
    if ((inventory[ing.itemId] ?? 0) < ing.quantity) {
      return { ok: false, reason: 'missing_ingredients' };
    }
  }
  return { ok: true };
}

/**
 * Append a job to the queue and reserve ingredients from inventory.
 * Mutates inventory and queue in place. Returns ok:true on success.
 */
export function enqueueRecipe(
  recipe: RecipeDefinition,
  inventory: Record<string, number>,
  queue: CraftQueueState,
  className: string | null,
  level: number,
  now: number,
): { ok: true } | { ok: false; reason: EnqueueError } {
  const check = canQueueRecipe(recipe, inventory, queue, className, level);
  if (!check.ok) return check;
  for (const ing of recipe.ingredients) {
    const cur = inventory[ing.itemId] ?? 0;
    const next = cur - ing.quantity;
    if (next === 0) delete inventory[ing.itemId];
    else inventory[ing.itemId] = next;
  }
  if (queue.jobs.length === 0) queue.activeStartedAtMs = now;
  queue.jobs.push({ recipeId: recipe.id });
  return { ok: true };
}

/**
 * Cancel the job at `index` and refund ingredients (capped at MAX_STACK; overflow lost).
 * If the active job (index 0) is cancelled, the next job's start time becomes `now`.
 * Mutates inventory and queue in place. Returns true if a job was removed.
 */
export function cancelJobAt(
  index: number,
  recipes: Record<string, RecipeDefinition>,
  inventory: Record<string, number>,
  queue: CraftQueueState,
  now: number,
): boolean {
  if (index < 0 || index >= queue.jobs.length) return false;
  const job = queue.jobs[index];
  const recipe = recipes[job.recipeId];
  if (recipe) {
    for (const ing of recipe.ingredients) {
      const cur = inventory[ing.itemId] ?? 0;
      inventory[ing.itemId] = Math.min(MAX_STACK, cur + ing.quantity);
    }
  }
  queue.jobs.splice(index, 1);
  if (index === 0) {
    queue.activeStartedAtMs = queue.jobs.length > 0 ? now : null;
  }
  return true;
}

export interface CompletedJobEvent {
  recipeId: string;
  resultItemId: string;
  /** Actually added to inventory (capped at MAX_STACK). */
  quantityProduced: number;
  /** Lost to MAX_STACK overflow. */
  quantityLost: number;
}

/**
 * Pop completed jobs from the queue and add results to inventory.
 * Walks the queue advancing the head's start time as each completes — handles offline
 * catch-up where many jobs may complete in a single call.
 * Overflow (would exceed MAX_STACK) is lost; `quantityLost` reports it.
 */
export function processCompletions(
  recipes: Record<string, RecipeDefinition>,
  inventory: Record<string, number>,
  queue: CraftQueueState,
  now: number,
): CompletedJobEvent[] {
  const events: CompletedJobEvent[] = [];
  while (queue.jobs.length > 0 && queue.activeStartedAtMs !== null) {
    const head = queue.jobs[0];
    const recipe = recipes[head.recipeId];
    if (!recipe) {
      // Recipe was deleted out from under us — drop the job (no refund possible).
      queue.jobs.shift();
      queue.activeStartedAtMs = queue.jobs.length > 0 ? now : null;
      continue;
    }
    const completesAt = queue.activeStartedAtMs + recipe.durationSeconds * 1000;
    if (completesAt > now) break;
    const cur = inventory[recipe.result.itemId] ?? 0;
    const requested = recipe.result.quantity;
    const fits = Math.max(0, Math.min(MAX_STACK - cur, requested));
    const lost = requested - fits;
    if (fits > 0) inventory[recipe.result.itemId] = cur + fits;
    events.push({ recipeId: recipe.id, resultItemId: recipe.result.itemId, quantityProduced: fits, quantityLost: lost });
    queue.jobs.shift();
    queue.activeStartedAtMs = queue.jobs.length > 0 ? completesAt : null;
  }
  return events;
}

export interface ActiveJobProgress {
  recipeId: string;
  startedAtMs: number;
  durationMs: number;
  elapsedMs: number;
  remainingMs: number;
}

export function getActiveJobProgress(
  recipes: Record<string, RecipeDefinition>,
  queue: CraftQueueState,
  now: number,
): ActiveJobProgress | null {
  if (queue.jobs.length === 0 || queue.activeStartedAtMs === null) return null;
  const head = queue.jobs[0];
  const recipe = recipes[head.recipeId];
  if (!recipe) return null;
  const durationMs = recipe.durationSeconds * 1000;
  const elapsedMs = Math.max(0, Math.min(durationMs, now - queue.activeStartedAtMs));
  return {
    recipeId: head.recipeId,
    startedAtMs: queue.activeStartedAtMs,
    durationMs,
    elapsedMs,
    remainingMs: Math.max(0, durationMs - elapsedMs),
  };
}

/** Filter recipes to those visible to a player (class + always-show shared recipes). */
export function getVisibleRecipes(
  recipes: Record<string, RecipeDefinition>,
  className: string | null,
): RecipeDefinition[] {
  const out: RecipeDefinition[] = [];
  for (const recipe of Object.values(recipes)) {
    if (recipe.classRestriction && recipe.classRestriction.length > 0) {
      if (!className || !recipe.classRestriction.includes(className)) continue;
    }
    out.push(recipe);
  }
  return out;
}

export const SEED_RECIPES: Record<string, RecipeDefinition> = {
  reinforced_leather_vest: {
    id: 'reinforced_leather_vest',
    name: 'Reinforced Leather Vest',
    description: 'Stitch a vest from cured pelts.',
    classRestriction: ['Knight'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 60,
    xpReward: 15,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 5 }],
    result: { itemId: 'leather_vest', quantity: 1 },
  },
  shortbow_assembly: {
    id: 'shortbow_assembly',
    name: 'Shortbow Assembly',
    description: 'Carve a shortbow from sinew and bone.',
    classRestriction: ['Archer'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 60,
    xpReward: 15,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 3 }],
    result: { itemId: 'short_bow', quantity: 1 },
  },
  blessed_prayer_beads: {
    id: 'blessed_prayer_beads',
    name: 'Blessed Prayer Beads',
    description: 'String beads with a quiet blessing.',
    classRestriction: ['Priest'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 60,
    xpReward: 15,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 4 }],
    result: { itemId: 'prayer_beads', quantity: 1 },
  },
  carved_gnarled_wand: {
    id: 'carved_gnarled_wand',
    name: 'Carved Gnarled Wand',
    description: 'Whittle a focus from twisted wood.',
    classRestriction: ['Mage'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 60,
    xpReward: 15,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 4 }],
    result: { itemId: 'gnarled_wand', quantity: 1 },
  },
  // Mage Alchemy starter: brews a basic potion (consumable; not usable yet)
  brew_lesser_red_potion: {
    id: 'brew_lesser_red_potion',
    name: 'Brew Lesser Red Potion',
    description: 'Distill a basic red brew from a tattered pelt.',
    classRestriction: ['Mage'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 30,
    xpReward: 10,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 1 }],
    result: { itemId: 'lesser_red_potion', quantity: 1 },
  },
  tin_whistle_craft: {
    id: 'tin_whistle_craft',
    name: 'Tin Whistle',
    description: 'Hammer a whistle from scrap tin.',
    classRestriction: ['Bard'],
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 60,
    xpReward: 15,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 4 }],
    result: { itemId: 'tin_whistle', quantity: 1 },
  },
  patched_cloak: {
    id: 'patched_cloak',
    name: 'Patched Cloak',
    description: 'Patch together a cloak from spare hides.',
    requiredLevel: CRAFTING_UNLOCK_LEVEL,
    durationSeconds: 30,
    xpReward: 5,
    ingredients: [{ itemId: 'mangy_pelt', quantity: 2 }],
    result: { itemId: 'moth_eaten_cloak', quantity: 1 },
  },
};
