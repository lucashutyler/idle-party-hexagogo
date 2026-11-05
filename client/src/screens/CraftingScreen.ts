import type { GameClient } from '../network/GameClient';
import type { WorldCache } from '../network/WorldCache';
import type {
  ServerStateMessage,
  RecipeDefinition,
  ItemDefinition,
  SetDefinition,
  ClientCraftingState,
  CraftQueueState,
} from '@idle-party-rpg/shared';
import { canQueueRecipe, getEquippedItemIds, getOwnedItemIds, MAX_CRAFT_QUEUE } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';
import { deferWhilePressed, setHtml } from '../ui/render';
import { RARITY_COLORS, escapeHtml, renderItemIcon, wireRoleButtons } from '../ui/ItemIcon';
import { closeItemPopup, showItemPopup } from '../ui/ItemPopup';
import { renderEquipCompareBlock } from '../ui/EquipCompare';
import { artworkUrl, renderTrackedImg } from '../ui/assets';
import { renderSegments, wireSegments } from '../ui/Segments';

const PROGRESS_TICK_MS = 1000;
const NOTHING_QUEUED: CraftQueueState = { activeStartedAtMs: null, jobs: [] };

/** Blocked recipes sink in this order: the closer to craftable, the higher. */
const BLOCK_RANK: Record<string, number> = { missing_ingredients: 1, level_too_low: 2, class_restricted: 3 };

type CraftFilter = 'all' | 'craftable';

function fmtSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export class CraftingScreen implements Screen {
  private container: HTMLElement;
  private scroller: HTMLElement;
  private headEl: HTMLElement;
  private queueEl: HTMLElement;
  private segmentsEl: HTMLElement;
  private recipesEl: HTMLElement;
  private gameClient: GameClient;
  private worldCache?: WorldCache;
  private isActive = false;
  private unsubscribe?: () => void;
  private progressTimer?: ReturnType<typeof setInterval>;
  private filter: CraftFilter = 'all';
  private detailOverlay: HTMLElement | null = null;

  private lastState: ClientCraftingState | null = null;
  private lastInventory: Record<string, number> = {};
  private lastEquipment: Record<string, string | null> = {};
  private lastItemDefs: Record<string, ItemDefinition> = {};
  private lastSetDefs: Record<string, SetDefinition> = {};
  private lastClassName: string | null = null;
  private lastLevel = 0;

  constructor(containerId: string, gameClient: GameClient, worldCache?: WorldCache) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    this.worldCache = worldCache;
    this.scroller = document.createElement('div');
    this.scroller.className = 'craft-screen';
    this.scroller.innerHTML = `
      <div class="craft-head"></div>
      <section class="craft-section craft-queue-section"></section>
      <div class="craft-segments"></div>
      <section class="craft-section craft-recipes-section"></section>
    `;
    this.headEl = this.scroller.querySelector('.craft-head')!;
    this.queueEl = this.scroller.querySelector('.craft-queue-section')!;
    this.segmentsEl = this.scroller.querySelector('.craft-segments')!;
    this.recipesEl = this.scroller.querySelector('.craft-recipes-section')!;
    this.container.replaceChildren(this.scroller);
    this.scroller.addEventListener('click', (e) => this.onClick(e));
    wireRoleButtons(this.scroller);
    wireSegments(this.segmentsEl, (id) => {
      this.filter = id === 'craftable' ? 'craftable' : 'all';
      this.render();
    });
  }

  onActivate(): void {
    this.isActive = true;
    this.unsubscribe = this.gameClient.subscribe(() => {
      deferWhilePressed(this.scroller, () => {
        const state = this.gameClient.lastState;
        if (this.isActive && state) this.updateFromState(state);
      });
    });
    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.syncProgressTimer();
    this.closeDetails();
  }

  prebuild(): void {
    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
  }

  private updateFromState(state: ServerStateMessage): void {
    this.lastState = state.crafting ?? null;
    this.lastInventory = state.character?.inventory ?? {};
    this.lastEquipment = state.character?.equipment ?? {};
    this.lastItemDefs = state.itemDefinitions ?? {};
    this.lastSetDefs = state.setDefinitions ?? {};
    this.lastClassName = state.character?.className ?? null;
    this.lastLevel = state.character?.level ?? 0;
    this.render();
    this.syncProgressTimer();
  }

  private syncProgressTimer(): void {
    const running = this.isActive && !!this.lastState?.activeProgress;
    if (running && this.progressTimer === undefined) {
      this.progressTimer = setInterval(() => this.updateProgressBar(), PROGRESS_TICK_MS);
    } else if (!running && this.progressTimer !== undefined) {
      clearInterval(this.progressTimer);
      this.progressTimer = undefined;
    }
  }

  private updateProgressBar(): void {
    if (!this.lastState?.activeProgress) return;
    const fill = this.queueEl.querySelector<HTMLElement>('.craft-progress-fill[data-active="1"]');
    const status = this.queueEl.querySelector<HTMLElement>('.craft-queue-status[data-active="1"]');
    if (!fill || !status) return;
    const ap = this.lastState.activeProgress;
    const elapsed = Math.max(0, Math.min(ap.durationMs, Date.now() - ap.startedAtMs));
    fill.style.transform = `scaleX(${elapsed / ap.durationMs})`;
    status.textContent = `${fmtSeconds((ap.durationMs - elapsed) / 1000)} remaining`;
  }

  private render(): void {
    const c = this.lastState;
    if (!c) {
      setHtml(this.headEl, `<div class="craft-locked"><h3>No character</h3><p>Pick a class first.</p></div>`);
      setHtml(this.queueEl, '');
      setHtml(this.segmentsEl, '');
      setHtml(this.recipesEl, '');
      return;
    }
    const recipes = this.sortedRecipes(c);
    const craftable = recipes.filter(r => this.ownBlock(r) === null);
    setHtml(this.headEl, this.renderSkillHeader(c));
    if (setHtml(this.queueEl, this.renderQueue(c))) this.updateProgressBar();
    setHtml(this.segmentsEl, renderSegments([
      { id: 'all', label: 'All' },
      { id: 'craftable', label: 'Craftable', badge: craftable.length },
    ], this.filter));
    setHtml(this.recipesEl, this.renderRecipes(c, this.filter === 'craftable' ? craftable : recipes));
  }

  private onClick(e: Event): void {
    const target = e.target as Element;
    const btn = target.closest<HTMLButtonElement>('button');
    if (btn) {
      if (btn.disabled) return;
      if (btn.matches('.craft-queue-btn')) {
        const id = btn.dataset.recipeId;
        if (id) this.gameClient.sendCraftQueue(id);
      } else if (btn.matches('.craft-cancel-btn')) {
        const idx = Number(btn.dataset.index);
        if (Number.isFinite(idx)) this.gameClient.sendCraftCancel(idx);
      }
      return;
    }
    const resultId = target.closest<HTMLElement>('[data-result-item]')?.dataset.resultItem;
    if (resultId) this.showDetails(resultId);
  }

  private lookupItem(id: string): ItemDefinition | undefined {
    return this.lastState?.itemDefs[id] ?? this.lastItemDefs[id];
  }

  private showDetails(itemId: string): void {
    const def = this.lookupItem(itemId);
    if (!def) return;
    this.closeDetails();
    this.detailOverlay = showItemPopup(def, {
      itemDefs: { ...this.lastItemDefs, ...this.lastState?.itemDefs },
      setDefs: this.lastSetDefs,
      ownedItemIds: getOwnedItemIds(this.lastInventory, this.lastEquipment),
      equippedItemIds: getEquippedItemIds(this.lastEquipment),
      className: this.lastClassName,
      skills: this.worldCache?.getSkillContent().skills,
      extraHtml: renderEquipCompareBlock(def, this.lastEquipment, { ...this.lastItemDefs, ...this.lastState?.itemDefs }),
    });
  }

  private closeDetails(): void {
    if (this.detailOverlay) closeItemPopup(this.detailOverlay);
    this.detailOverlay = null;
  }

  private renderSkillHeader(c: ClientCraftingState): string {
    const xpRatio = c.skillXpForNext > 0
      ? Math.min(1, Math.max(0, c.skillXp / c.skillXpForNext))
      : 0;
    return `
      <div class="craft-skill-header">
        <div class="craft-skill-row">
          <div class="craft-skill-name">${escapeHtml(c.skillName)}</div>
          <div class="craft-skill-level">Level ${c.skillLevel}</div>
          <div class="craft-skill-xptext">${c.skillXp} / ${c.skillXpForNext} XP</div>
        </div>
        <div class="craft-skill-xpbar"><div class="craft-skill-xpfill" style="transform:scaleX(${xpRatio})"></div></div>
      </div>
    `;
  }

  private renderQueue(c: ClientCraftingState): string {
    const title = `<h3>Queue (${c.queue.jobs.length} / ${MAX_CRAFT_QUEUE})</h3>`;
    if (c.queue.jobs.length === 0) {
      return `${title}<div class="craft-queue-empty">Queue is empty. Pick a recipe below.</div>`;
    }
    const recipesById = new Map<string, RecipeDefinition>();
    for (const r of c.recipes) recipesById.set(r.id, r);
    const rows = c.queue.jobs.map((job, idx) => {
      const recipe = recipesById.get(job.recipeId);
      const name = recipe ? recipe.name : job.recipeId;
      const active = idx === 0 ? c.activeProgress : null;
      let progressBlock = '';
      let statusText = '';
      if (active) {
        progressBlock = `
          <div class="craft-progress">
            <div class="craft-progress-fill" data-active="1" data-started="${active.startedAtMs}"></div>
          </div>
        `;
      } else if (recipe) {
        statusText = `Queued: ${fmtSeconds(recipe.durationSeconds)}`;
      } else {
        statusText = 'Queued';
      }
      const def = recipe ? this.lookupItem(recipe.result.itemId) : undefined;
      const icon = recipe && def ? renderItemIcon(recipe.result.itemId, def, { extraClass: 'craft-queue-icon' }) : '';
      return `
        <div class="craft-queue-row">
          ${icon}
          <div class="craft-queue-text">
            <div class="craft-queue-name">${escapeHtml(name)}</div>
            <div class="craft-queue-status" ${active ? 'data-active="1"' : ''}>${escapeHtml(statusText)}</div>
          </div>
          <button class="craft-cancel-btn" data-index="${idx}">Cancel</button>
          ${progressBlock}
        </div>
      `;
    }).join('');
    return `${title}<div class="craft-queue-list">${rows}</div>`;
  }

  /** The recipe's own blocker, ignoring how full the queue is. */
  private ownBlock(recipe: RecipeDefinition): string | null {
    const check = canQueueRecipe(recipe, this.lastInventory, NOTHING_QUEUED, this.lastClassName, this.lastLevel);
    return check.ok ? null : check.reason;
  }

  private sortedRecipes(c: ClientCraftingState): RecipeDefinition[] {
    const rank = (recipe: RecipeDefinition): number => {
      const block = this.ownBlock(recipe);
      return block === null ? 0 : BLOCK_RANK[block] ?? 4;
    };
    return [...c.recipes].sort((a, b) =>
      rank(a) - rank(b) || (a.requiredLevel ?? 0) - (b.requiredLevel ?? 0));
  }

  private renderRecipes(c: ClientCraftingState, recipes: RecipeDefinition[]): string {
    if (c.recipes.length === 0) {
      return `<div class="ui-empty">No recipes available.</div>`;
    }
    if (recipes.length === 0) {
      return `<div class="ui-empty">Nothing you can craft right now. Check All to see what each recipe needs.</div>`;
    }
    return `<div class="craft-recipe-list">${recipes.map(r => this.renderRecipeCard(c, r)).join('')}</div>`;
  }

  private renderRecipeCard(c: ClientCraftingState, recipe: RecipeDefinition): string {
    const ings = recipe.ingredients.map(ing => {
      const def = this.lookupItem(ing.itemId);
      const name = def?.name ?? ing.itemId;
      const have = this.lastInventory[ing.itemId] ?? 0;
      const cls = have >= ing.quantity ? 'craft-ing' : 'craft-ing craft-recipe-ing-missing';
      const color = RARITY_COLORS[def?.rarity ?? 'common'] ?? RARITY_COLORS.common;
      const art = renderTrackedImg(artworkUrl('item', ing.itemId), { className: 'craft-ing-img', lazy: true });
      return `<span class="${cls}"><span class="craft-ing-icon" style="--rarity:${color}">${art}</span>${escapeHtml(name)} ${have}/${ing.quantity}</span>`;
    }).join('');

    const resultDef = this.lookupItem(recipe.result.itemId);
    const resultName = resultDef?.name ?? recipe.result.itemId;
    const media = resultDef
      ? renderItemIcon(recipe.result.itemId, resultDef, { qty: recipe.result.quantity, extraClass: 'craft-recipe-icon' })
      : '<div class="item-square item-square-empty craft-recipe-icon"></div>';
    const resultLine = resultName !== recipe.name
      ? `<div class="craft-recipe-result">Makes ${escapeHtml(resultName)}${recipe.result.quantity > 1 ? ` ×${recipe.result.quantity}` : ''}</div>`
      : '';

    const meta = [
      fmtSeconds(recipe.durationSeconds),
      recipe.xpReward && recipe.xpReward > 0 ? `${recipe.xpReward} XP` : '',
      recipe.requiredLevel != null ? `Lv ${recipe.requiredLevel}` : '',
    ].filter(Boolean).join(' · ');
    const classTag = recipe.classRestriction && recipe.classRestriction.length > 0
      ? `<span class="craft-class-tag">${escapeHtml(recipe.classRestriction.join('/'))}</span>` : '';

    const check = canQueueRecipe(recipe, this.lastInventory, c.queue, this.lastClassName, this.lastLevel);
    const ownBlock = this.ownBlock(recipe);
    const block = ownBlock ?? (check.ok ? null : check.reason);
    const reason = block ? this.reasonText(block, recipe) : '';

    return `
      <div class="craft-recipe-card${ownBlock ? ' blocked' : ''}" data-result-item="${escapeHtml(recipe.result.itemId)}">
        <div class="craft-recipe-media" role="button" tabindex="0" aria-label="${escapeHtml(resultName)} details">${media}</div>
        <div class="craft-recipe-info">
          <div class="craft-recipe-name">${escapeHtml(recipe.name)}${classTag}</div>
          <div class="craft-recipe-meta">${meta}</div>
          <div class="craft-recipe-ings">${ings}</div>
          ${resultLine}
          ${reason ? `<div class="craft-recipe-reason" data-reason="${block}">${escapeHtml(reason)}</div>` : ''}
        </div>
        <button class="craft-queue-btn" data-recipe-id="${escapeHtml(recipe.id)}" ${check.ok ? '' : 'disabled'}>Queue</button>
      </div>
    `;
  }

  private reasonText(reason: string, recipe: RecipeDefinition): string {
    switch (reason) {
      case 'queue_full': return 'Queue is full';
      case 'level_too_low': return `Requires level ${recipe.requiredLevel}`;
      case 'class_restricted': return `${(recipe.classRestriction ?? []).join(', ')} only`;
      case 'missing_ingredients': return 'Missing materials';
      default: return '';
    }
  }
}
