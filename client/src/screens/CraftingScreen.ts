import type { GameClient } from '../network/GameClient';
import type { ServerStateMessage, RecipeDefinition, ItemDefinition, ClientCraftingState } from '@idle-party-rpg/shared';
import { canQueueRecipe, MAX_CRAFT_QUEUE } from '@idle-party-rpg/shared';
import type { Screen } from './ScreenManager';

function injectCraftingStyles(): void {
  if (document.getElementById('crafting-screen-styles')) return;
  const style = document.createElement('style');
  style.id = 'crafting-screen-styles';
  style.textContent = `
    .craft-screen { padding: 12px; display: flex; flex-direction: column; gap: 14px; }
    .craft-locked {
      padding: 24px; text-align: center;
      border: 1px solid var(--panel-border, rgba(255,255,255,0.15));
      border-radius: 8px; background: rgba(0,0,0,0.2);
    }
    .craft-locked h3 { margin: 0 0 8px; }
    .craft-section {
      border: 1px solid rgba(255,255,255,0.12); border-radius: 6px;
      padding: 10px; background: rgba(0,0,0,0.2);
    }
    .craft-section h3 { margin: 0 0 8px; font-size: 0.85em; letter-spacing: 1px; opacity: 0.85; }
    .craft-queue-empty { opacity: 0.6; font-size: 0.85em; }
    .craft-queue-list { display: flex; flex-direction: column; gap: 6px; }
    .craft-queue-row {
      display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
      padding: 6px 8px; background: rgba(255,255,255,0.04); border-radius: 4px;
    }
    .craft-queue-name { font-size: 0.85em; }
    .craft-queue-status { font-size: 0.7em; opacity: 0.7; }
    .craft-progress {
      grid-column: 1 / -1;
      height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden;
    }
    .craft-progress-fill { height: 100%; background: linear-gradient(90deg, #5a8, #7c8); transition: width 0.5s linear; }
    .craft-cancel-btn {
      font-size: 0.7em; padding: 3px 8px;
      background: rgba(180,80,80,0.4); border: 1px solid rgba(220,120,120,0.5);
      color: #fff; border-radius: 3px; cursor: pointer;
    }
    .craft-cancel-btn:hover { background: rgba(200,100,100,0.6); }
    .craft-recipe-list { display: flex; flex-direction: column; gap: 8px; }
    .craft-recipe-card {
      padding: 8px; background: rgba(255,255,255,0.04); border-radius: 4px;
      display: grid; grid-template-columns: 1fr auto; gap: 8px; align-items: center;
    }
    .craft-recipe-name { font-size: 0.85em; }
    .craft-recipe-meta { font-size: 0.7em; opacity: 0.75; margin-top: 2px; }
    .craft-recipe-ings { font-size: 0.7em; opacity: 0.85; }
    .craft-recipe-ing-missing { color: #f88; }
    .craft-recipe-result { font-size: 0.7em; opacity: 0.85; }
    .craft-queue-btn {
      font-size: 0.75em; padding: 5px 10px;
      background: rgba(80,140,180,0.45); border: 1px solid rgba(120,180,220,0.6);
      color: #fff; border-radius: 3px; cursor: pointer;
    }
    .craft-queue-btn:disabled { opacity: 0.4; cursor: not-allowed; }
    .craft-queue-btn:not(:disabled):hover { background: rgba(100,160,200,0.6); }
    .craft-class-tag {
      font-size: 0.65em; padding: 1px 5px; margin-left: 6px;
      background: rgba(180,140,80,0.3); border-radius: 3px;
    }
  `;
  document.head.appendChild(style);
}

function fmtSeconds(seconds: number): string {
  if (seconds < 60) return `${Math.ceil(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.ceil(seconds - m * 60);
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

export class CraftingScreen implements Screen {
  private container: HTMLElement;
  private gameClient: GameClient;
  private isActive = false;
  private unsubscribe?: () => void;
  private rafHandle?: number;

  private lastState: ClientCraftingState | null = null;
  private lastInventory: Record<string, number> = {};
  private lastItemDefs: Record<string, ItemDefinition> = {};
  private lastClassName: string | null = null;
  private lastLevel = 0;

  constructor(containerId: string, gameClient: GameClient) {
    const el = document.getElementById(containerId);
    if (!el) throw new Error(`Screen container #${containerId} not found`);
    this.container = el;
    this.gameClient = gameClient;
    injectCraftingStyles();
  }

  onActivate(): void {
    this.isActive = true;
    this.unsubscribe = this.gameClient.subscribe(state => {
      if (this.isActive) this.updateFromState(state);
    });
    const state = this.gameClient.lastState;
    if (state) this.updateFromState(state);
    this.startProgressLoop();
  }

  onDeactivate(): void {
    this.isActive = false;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (this.rafHandle !== undefined) {
      cancelAnimationFrame(this.rafHandle);
      this.rafHandle = undefined;
    }
  }

  private updateFromState(state: ServerStateMessage): void {
    this.lastState = state.crafting ?? null;
    this.lastInventory = state.character?.inventory ?? {};
    this.lastItemDefs = state.itemDefinitions ?? {};
    this.lastClassName = state.character?.className ?? null;
    this.lastLevel = state.character?.level ?? 0;
    this.render();
  }

  private startProgressLoop(): void {
    const tick = () => {
      if (!this.isActive) return;
      this.updateProgressBar();
      this.rafHandle = requestAnimationFrame(tick);
    };
    this.rafHandle = requestAnimationFrame(tick);
  }

  private updateProgressBar(): void {
    if (!this.lastState?.activeProgress) return;
    const fill = this.container.querySelector<HTMLElement>('.craft-progress-fill[data-active="1"]');
    const status = this.container.querySelector<HTMLElement>('.craft-queue-status[data-active="1"]');
    if (!fill || !status) return;
    const ap = this.lastState.activeProgress;
    const elapsed = Math.min(ap.durationMs, Date.now() - ap.startedAtMs);
    const pct = (elapsed / ap.durationMs) * 100;
    fill.style.width = `${Math.min(100, Math.max(0, pct))}%`;
    const remaining = Math.max(0, ap.durationMs - elapsed) / 1000;
    status.textContent = `${fmtSeconds(remaining)} remaining`;
  }

  private render(): void {
    const c = this.lastState;
    if (!c) {
      this.container.innerHTML = `<div class="craft-screen"><div class="craft-locked"><h3>No character</h3><p>Pick a class first.</p></div></div>`;
      return;
    }
    if (!c.unlocked) {
      this.container.innerHTML = `
        <div class="craft-screen">
          <div class="craft-locked">
            <h3>Crafting locked</h3>
            <p>Reach level ${c.unlockLevel} to begin crafting.</p>
            <p style="opacity:0.7;font-size:0.85em">You're level ${this.lastLevel}.</p>
          </div>
        </div>
      `;
      return;
    }

    this.container.innerHTML = `
      <div class="craft-screen">
        <section class="craft-section">
          <h3>Queue (${c.queue.jobs.length} / ${MAX_CRAFT_QUEUE})</h3>
          ${this.renderQueue(c)}
        </section>
        <section class="craft-section">
          <h3>Recipes</h3>
          ${this.renderRecipes(c)}
        </section>
      </div>
    `;

    this.container.querySelectorAll<HTMLButtonElement>('.craft-queue-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.recipeId;
        if (id) this.gameClient.sendCraftQueue(id);
      });
    });
    this.container.querySelectorAll<HTMLButtonElement>('.craft-cancel-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const idx = Number(btn.dataset.index);
        if (Number.isFinite(idx)) this.gameClient.sendCraftCancel(idx);
      });
    });
  }

  private renderQueue(c: ClientCraftingState): string {
    if (c.queue.jobs.length === 0) {
      return `<div class="craft-queue-empty">Queue is empty. Pick a recipe below.</div>`;
    }
    const recipesById = new Map<string, RecipeDefinition>();
    for (const r of c.recipes) recipesById.set(r.id, r);
    const rows = c.queue.jobs.map((job, idx) => {
      const recipe = recipesById.get(job.recipeId);
      const name = recipe ? recipe.name : job.recipeId;
      const isActive = idx === 0 && c.activeProgress;
      let progressBlock = '';
      let statusText = '';
      if (isActive && c.activeProgress) {
        const ap = c.activeProgress;
        const pct = ap.durationMs > 0 ? Math.min(100, (ap.elapsedMs / ap.durationMs) * 100) : 0;
        const remaining = Math.max(0, ap.remainingMs / 1000);
        statusText = `${fmtSeconds(remaining)} remaining`;
        progressBlock = `
          <div class="craft-progress">
            <div class="craft-progress-fill" data-active="1" style="width:${pct}%"></div>
          </div>
        `;
      } else if (recipe) {
        statusText = `Queued — ${fmtSeconds(recipe.durationSeconds)}`;
      } else {
        statusText = 'Queued';
      }
      return `
        <div class="craft-queue-row">
          <div>
            <div class="craft-queue-name">${escapeHtml(name)}</div>
            <div class="craft-queue-status" ${isActive ? 'data-active="1"' : ''}>${escapeHtml(statusText)}</div>
          </div>
          <button class="craft-cancel-btn" data-index="${idx}">Cancel</button>
          ${progressBlock}
        </div>
      `;
    }).join('');
    return `<div class="craft-queue-list">${rows}</div>`;
  }

  private renderRecipes(c: ClientCraftingState): string {
    if (c.recipes.length === 0) {
      return `<div class="craft-queue-empty">No recipes available.</div>`;
    }
    const cards = c.recipes.map(recipe => {
      const ings = recipe.ingredients.map(ing => {
        const def = this.lastItemDefs[ing.itemId];
        const name = def?.name ?? ing.itemId;
        const have = this.lastInventory[ing.itemId] ?? 0;
        const enough = have >= ing.quantity;
        const cls = enough ? '' : 'craft-recipe-ing-missing';
        return `<span class="${cls}">${escapeHtml(name)} ${have}/${ing.quantity}</span>`;
      }).join(', ');
      const resultDef = this.lastItemDefs[recipe.result.itemId];
      const resultName = resultDef?.name ?? recipe.result.itemId;
      const resultStr = recipe.result.quantity > 1 ? `${resultName} ×${recipe.result.quantity}` : resultName;
      const classTag = recipe.classRestriction && recipe.classRestriction.length > 0
        ? `<span class="craft-class-tag">${escapeHtml(recipe.classRestriction.join('/'))}</span>` : '';
      const check = canQueueRecipe(recipe, this.lastInventory, c.queue, this.lastClassName, this.lastLevel);
      const disabled = !check.ok;
      const reason = !check.ok ? this.reasonText(check.reason) : '';
      return `
        <div class="craft-recipe-card">
          <div>
            <div class="craft-recipe-name">${escapeHtml(recipe.name)}${classTag}</div>
            <div class="craft-recipe-meta">${fmtSeconds(recipe.durationSeconds)}</div>
            <div class="craft-recipe-ings">Cost: ${ings}</div>
            <div class="craft-recipe-result">→ ${escapeHtml(resultStr)}</div>
          </div>
          <button class="craft-queue-btn" data-recipe-id="${escapeHtml(recipe.id)}" ${disabled ? 'disabled' : ''} title="${escapeHtml(reason)}">Queue</button>
        </div>
      `;
    }).join('');
    return `<div class="craft-recipe-list">${cards}</div>`;
  }

  private reasonText(reason: string): string {
    switch (reason) {
      case 'queue_full': return 'Queue is full';
      case 'level_too_low': return 'Level too low';
      case 'class_restricted': return 'Wrong class';
      case 'missing_ingredients': return 'Missing ingredients';
      default: return '';
    }
  }
}
