import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { getSetBonusText } from '@idle-party-rpg/shared';
import type { SetDefinition, SetBonuses } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class SetsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const sets = Object.values(content.sets ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = sets.map(s => {
      const summary = getSetBonusText(s.bonuses);
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm set-edit-btn" data-id="${s.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger set-delete-btn" data-id="${s.id}">Del</button>
        </td>
      `;
      return `
        <tr>
          <td>${escapeHtml(s.name)}</td>
          <td>${s.itemIds.length}</td>
          <td>${escapeHtml(summary)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="set-add-btn">+ Add Set</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Sets <span class="admin-count-badge">${sets.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Name</th><th>Items</th><th>Bonus Summary</th>${actionsHeader}</tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#set-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.set-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const set = (ctx.getDisplayContent()?.sets ?? {})[id];
        if (set) this.openForm(set, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.set-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        this.deleteSet(ctx, id);
      });
    });
  }

  private openForm(set: SetDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !set;
    const s = set ?? { id: '', name: '', itemIds: [], bonuses: {} };
    const items = Object.values(content.items);
    const existingItemIds = new Set(s.itemIds);
    const itemCheckboxes = items.map(item =>
      `<label class="admin-checkbox">
        <input type="checkbox" class="sf-item-check" value="${item.id}" ${existingItemIds.has(item.id) ? 'checked' : ''}>
        ${escapeHtml(item.name)}
      </label>`
    ).join('');

    const b = s.bonuses;

    const bodyHtml = `
      <input type="hidden" id="sf-id" value="${escapeHtml(s.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="sf-name" value="${escapeHtml(s.name)}"></label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Items</legend>
        <div class="admin-checklist">${itemCheckboxes}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Set Bonuses</legend>
        <div class="admin-form-grid">
          <label>CD Reduction<input type="number" id="sf-cooldownReduction" value="${b.cooldownReduction ?? 0}" min="0"></label>
          <label>Damage %<input type="number" id="sf-damagePercent" value="${b.damagePercent ?? 0}" min="0"></label>
          <label>Dmg Resist %<input type="number" id="sf-damageResistancePercent" value="${b.damageResistancePercent ?? 0}" min="0"></label>
          <label>DR Min<input type="number" id="sf-drMin" value="${b.damageReductionMin ?? 0}" min="0"></label>
          <label>DR Max<input type="number" id="sf-drMax" value="${b.damageReductionMax ?? 0}" min="0"></label>
          <label>MR Min<input type="number" id="sf-mrMin" value="${b.magicReductionMin ?? 0}" min="0"></label>
          <label>MR Max<input type="number" id="sf-mrMax" value="${b.magicReductionMax ?? 0}" min="0"></label>
          <label>Atk Min<input type="number" id="sf-atkMin" value="${b.bonusAttackMin ?? 0}" min="0"></label>
          <label>Atk Max<input type="number" id="sf-atkMax" value="${b.bonusAttackMax ?? 0}" min="0"></label>
          <label>Flat HP<input type="number" id="sf-flatHp" value="${b.flatHp ?? 0}" min="0"></label>
          <label>% HP<input type="number" id="sf-percentHp" value="${b.percentHp ?? 0}" min="0"></label>
        </div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="sf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="sf-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Set' : `Edit: ${s.name}`,
      bodyHtml,
      width: '720px',
    });
    const root = modal.body;
    root.querySelector('#sf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#sf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#sf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#sf-name') as HTMLInputElement).value.trim();
    if (!name) { alert('Name is required.'); return; }
    const id = existingId || crypto.randomUUID();

    const itemIds: string[] = [];
    root.querySelectorAll<HTMLInputElement>('.sf-item-check').forEach(cb => {
      if (cb.checked) itemIds.push(cb.value);
    });

    const num = (sel: string) => parseInt((root.querySelector(sel) as HTMLInputElement).value) || 0;
    const bonuses: SetBonuses = {};
    const cooldownReduction = num('#sf-cooldownReduction');
    const damagePercent = num('#sf-damagePercent');
    const damageResistancePercent = num('#sf-damageResistancePercent');
    const drMin = num('#sf-drMin');
    const drMax = num('#sf-drMax');
    const mrMin = num('#sf-mrMin');
    const mrMax = num('#sf-mrMax');
    const atkMin = num('#sf-atkMin');
    const atkMax = num('#sf-atkMax');
    const flatHp = num('#sf-flatHp');
    const percentHp = num('#sf-percentHp');

    if (cooldownReduction) bonuses.cooldownReduction = cooldownReduction;
    if (damagePercent) bonuses.damagePercent = damagePercent;
    if (damageResistancePercent) bonuses.damageResistancePercent = damageResistancePercent;
    if (drMin || drMax) { bonuses.damageReductionMin = drMin; bonuses.damageReductionMax = drMax; }
    if (mrMin || mrMax) { bonuses.magicReductionMin = mrMin; bonuses.magicReductionMax = mrMax; }
    if (atkMin || atkMax) { bonuses.bonusAttackMin = atkMin; bonuses.bonusAttackMax = atkMax; }
    if (flatHp) bonuses.flatHp = flatHp;
    if (percentHp) bonuses.percentHp = percentHp;

    const setDef: SetDefinition = { id, name, itemIds, bonuses };
    try {
      const data = await putAdmin<{ sets: Record<string, SetDefinition> }>(
        `/api/admin/sets/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, setDef);
      ctx.patchVersionContent({ sets: data.sets });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteSet(ctx: AdminContext, id: string): Promise<void> {
    const set = (ctx.getDisplayContent()?.sets ?? {})[id];
    if (!set) return;
    if (!confirm(`Delete set "${set.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ sets: Record<string, SetDefinition> }>(
        `/api/admin/sets/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ sets: data.sets });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
