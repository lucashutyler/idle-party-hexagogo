import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { RecipeDefinition, RecipeIngredient } from '@idle-party-rpg/shared';
import { ALL_CLASS_NAMES, CRAFTING_UNLOCK_LEVEL } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class RecipesTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const recipes = Object.values(content.recipes ?? {});
    const items = content.items ?? {};
    const readOnly = ctx.isReadOnly();

    const rows = recipes.map(r => {
      const resultName = items[r.result.itemId]?.name ?? r.result.itemId;
      const cls = r.classRestriction && r.classRestriction.length > 0
        ? r.classRestriction.join(', ') : '<span class="admin-form-hint">any</span>';
      const ings = r.ingredients.map(i => {
        const name = items[i.itemId]?.name ?? i.itemId;
        return `${escapeHtml(name)} ×${i.quantity}`;
      }).join(', ');
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm recipe-edit-btn" data-id="${r.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger recipe-delete-btn" data-id="${r.id}">Del</button>
        </td>
      `;
      return `<tr>
        <td>${escapeHtml(r.name)}</td>
        <td>${cls}</td>
        <td>${escapeHtml(resultName)} ×${r.result.quantity}</td>
        <td>${ings}</td>
        <td>${r.durationSeconds}s</td>
        <td>${r.xpReward ?? 0}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="recipe-add-btn">+ Add Recipe</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Recipes <span class="admin-count-badge">${recipes.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Class</th><th>Result</th><th>Ingredients</th><th>Duration</th><th>XP</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#recipe-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.recipe-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const recipe = (ctx.getDisplayContent()?.recipes ?? {})[btn.dataset.id!];
        if (recipe) this.openForm(recipe, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.recipe-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteRecipe(ctx, btn.dataset.id!));
    });
  }

  private openForm(recipe: RecipeDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    const isNew = !recipe;
    const r: RecipeDefinition = recipe ?? {
      id: '',
      name: '',
      description: '',
      classRestriction: [],
      requiredLevel: CRAFTING_UNLOCK_LEVEL,
      durationSeconds: 60,
      xpReward: 10,
      ingredients: [{ itemId: '', quantity: 1 }],
      result: { itemId: '', quantity: 1 },
    };

    const items = Object.values(content.items)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const itemOption = (selectedId: string) => items.map(item =>
      `<option value="${escapeHtml(item.id)}" ${item.id === selectedId ? 'selected' : ''}>${escapeHtml(item.name)}</option>`
    ).join('');

    const classChecks = ALL_CLASS_NAMES.map(c => {
      const checked = (r.classRestriction ?? []).includes(c) ? 'checked' : '';
      return `<label class="admin-checkbox"><input type="checkbox" class="rcf-class" value="${c}" ${checked}> ${c}</label>`;
    }).join('');

    const ingredientRow = (idx: number, ing: RecipeIngredient) => `
      <div class="admin-form-row rcf-ing-row" data-idx="${idx}">
        <select class="rcf-ing-item" style="flex:1">${itemOption(ing.itemId)}</select>
        <label>Qty <input type="number" class="rcf-ing-qty" value="${ing.quantity}" min="1" style="width:70px"></label>
        <button type="button" class="admin-btn admin-btn-sm admin-btn-danger rcf-ing-remove">×</button>
      </div>
    `;

    const ingredientsHtml = r.ingredients.map((ing, i) => ingredientRow(i, ing)).join('');

    const bodyHtml = `
      <input type="hidden" id="rcf-id" value="${escapeHtml(r.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="rcf-name" value="${escapeHtml(r.name)}"></label>
        <label>Duration (sec)<input type="number" id="rcf-duration" value="${r.durationSeconds}" min="1"></label>
        <label>Required Level<input type="number" id="rcf-required-level" value="${r.requiredLevel ?? CRAFTING_UNLOCK_LEVEL}" min="1"></label>
        <label>XP Reward<input type="number" id="rcf-xp" value="${r.xpReward ?? 0}" min="0"></label>
      </div>
      <label>Description<textarea id="rcf-description" rows="2" placeholder="Flavor text shown on the recipe card.">${escapeHtml(r.description ?? '')}</textarea></label>
      <fieldset class="admin-form-fieldset">
        <legend>Class restriction <span class="admin-form-hint">(none = anyone can craft)</span></legend>
        <div class="admin-checkbox-row">${classChecks}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Ingredients</legend>
        <div id="rcf-ings">${ingredientsHtml}</div>
        <button type="button" class="admin-btn admin-btn-sm" id="rcf-ing-add">+ Add ingredient</button>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Result</legend>
        <div class="admin-form-row">
          <select id="rcf-result-item" style="flex:1">${itemOption(r.result.itemId)}</select>
          <label>Qty <input type="number" id="rcf-result-qty" value="${r.result.quantity}" min="1" style="width:70px"></label>
        </div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="rcf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="rcf-cancel" type="button">Cancel</button>
      </div>
    `;
    const modal = openModal({
      title: isNew ? 'Add Recipe' : `Edit: ${r.name}`,
      bodyHtml,
      width: '640px',
    });
    const root = modal.body;

    const ingsContainer = root.querySelector<HTMLElement>('#rcf-ings')!;
    const renumber = () => {
      ingsContainer.querySelectorAll<HTMLElement>('.rcf-ing-row').forEach((el, i) => { el.dataset.idx = String(i); });
    };
    const wireRowRemove = (row: HTMLElement) => {
      row.querySelector<HTMLButtonElement>('.rcf-ing-remove')?.addEventListener('click', () => {
        if (ingsContainer.querySelectorAll('.rcf-ing-row').length <= 1) {
          alert('At least one ingredient is required.');
          return;
        }
        row.remove();
        renumber();
      });
    };
    ingsContainer.querySelectorAll<HTMLElement>('.rcf-ing-row').forEach(wireRowRemove);

    root.querySelector<HTMLButtonElement>('#rcf-ing-add')?.addEventListener('click', () => {
      const idx = ingsContainer.querySelectorAll('.rcf-ing-row').length;
      const wrapper = document.createElement('div');
      wrapper.innerHTML = ingredientRow(idx, { itemId: items[0]?.id ?? '', quantity: 1 });
      const newRow = wrapper.firstElementChild as HTMLElement;
      ingsContainer.appendChild(newRow);
      wireRowRemove(newRow);
    });

    root.querySelector('#rcf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#rcf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#rcf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#rcf-name') as HTMLInputElement).value.trim();
    const description = (root.querySelector('#rcf-description') as HTMLTextAreaElement).value.trim();
    const durationSeconds = parseInt((root.querySelector('#rcf-duration') as HTMLInputElement).value);
    const requiredLevel = parseInt((root.querySelector('#rcf-required-level') as HTMLInputElement).value);
    const xpReward = parseInt((root.querySelector('#rcf-xp') as HTMLInputElement).value) || 0;
    const resultItemId = (root.querySelector('#rcf-result-item') as HTMLSelectElement).value;
    const resultQty = parseInt((root.querySelector('#rcf-result-qty') as HTMLInputElement).value);

    if (!name) { alert('Name is required.'); return; }
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) { alert('Duration must be > 0.'); return; }
    if (!resultItemId) { alert('Result item is required.'); return; }
    if (!Number.isFinite(resultQty) || resultQty <= 0) { alert('Result quantity must be > 0.'); return; }

    const ingredients: RecipeIngredient[] = [];
    root.querySelectorAll<HTMLElement>('.rcf-ing-row').forEach(row => {
      const itemId = (row.querySelector('.rcf-ing-item') as HTMLSelectElement).value;
      const qty = parseInt((row.querySelector('.rcf-ing-qty') as HTMLInputElement).value);
      if (itemId && Number.isFinite(qty) && qty > 0) {
        ingredients.push({ itemId, quantity: qty });
      }
    });
    if (ingredients.length === 0) { alert('At least one ingredient is required.'); return; }

    const classRestriction: string[] = [];
    root.querySelectorAll<HTMLInputElement>('.rcf-class:checked').forEach(cb => classRestriction.push(cb.value));

    const id = existingId || crypto.randomUUID();
    const recipeDef: RecipeDefinition = {
      id,
      name,
      description: description || undefined,
      classRestriction: classRestriction.length > 0 ? classRestriction : undefined,
      requiredLevel: Number.isFinite(requiredLevel) ? requiredLevel : CRAFTING_UNLOCK_LEVEL,
      durationSeconds,
      xpReward,
      ingredients,
      result: { itemId: resultItemId, quantity: resultQty },
    };

    try {
      const data = await putAdmin<{ recipes: Record<string, RecipeDefinition> }>(
        `/api/admin/recipes/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, recipeDef);
      ctx.patchVersionContent({ recipes: data.recipes });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteRecipe(ctx: AdminContext, id: string): Promise<void> {
    const recipe = (ctx.getDisplayContent()?.recipes ?? {})[id];
    if (!recipe) return;
    if (!confirm(`Delete recipe "${recipe.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ recipes: Record<string, RecipeDefinition> }>(
        `/api/admin/recipes/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ recipes: data.recipes });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
