import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { ShopDefinition, ShopItem } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class ShopsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const shops = Object.values(content.shops ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = shops.map(s => {
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm shop-edit-btn" data-id="${s.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger shop-delete-btn" data-id="${s.id}">Del</button>
        </td>
      `;
      return `<tr><td>${escapeHtml(s.name)}</td><td>${s.inventory.length}</td>${actions}</tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="shop-add-btn">+ Add Shop</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Shops <span class="admin-count-badge">${shops.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Items</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#shop-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.shop-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const shop = (ctx.getDisplayContent()?.shops ?? {})[btn.dataset.id!];
        if (shop) this.openForm(shop, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.shop-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteShop(ctx, btn.dataset.id!));
    });
  }

  private openForm(shop: ShopDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    const isNew = !shop;
    const s = shop ?? { id: '', name: '', inventory: [] };
    const items = Object.values(content.items);

    const priceMap = new Map<string, number>();
    const inShop = new Set<string>();
    for (const si of s.inventory) { priceMap.set(si.itemId, si.price); inShop.add(si.itemId); }

    const itemRows = items.map(item => {
      const checked = inShop.has(item.id);
      const price = priceMap.get(item.id) ?? (item.value ?? 1);
      return `
        <div class="admin-shop-row">
          <label class="admin-checkbox">
            <input type="checkbox" class="shf-item-check" value="${item.id}" ${checked ? 'checked' : ''}>
            ${escapeHtml(item.name)}
          </label>
          <label>Price <input type="number" class="shf-item-price" data-item-id="${item.id}" value="${price}" min="0"></label>
        </div>
      `;
    }).join('');

    const bodyHtml = `
      <input type="hidden" id="shf-id" value="${escapeHtml(s.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="shf-name" value="${escapeHtml(s.name)}"></label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Inventory</legend>
        <div class="admin-checklist admin-checklist-tall">${itemRows}</div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="shf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="shf-cancel" type="button">Cancel</button>
      </div>
    `;
    const modal = openModal({
      title: isNew ? 'Add Shop' : `Edit: ${s.name}`,
      bodyHtml,
      width: '720px',
    });
    const root = modal.body;
    root.querySelector('#shf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#shf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#shf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#shf-name') as HTMLInputElement).value.trim();
    if (!name) { alert('Name is required.'); return; }
    const id = existingId || crypto.randomUUID();

    const inventory: ShopItem[] = [];
    root.querySelectorAll<HTMLInputElement>('.shf-item-check').forEach(cb => {
      if (cb.checked) {
        const itemId = cb.value;
        const priceInput = root.querySelector(`.shf-item-price[data-item-id="${itemId}"]`) as HTMLInputElement;
        const price = parseInt(priceInput?.value) || 1;
        inventory.push({ itemId, price });
      }
    });

    const shopDef: ShopDefinition = { id, name, inventory };
    try {
      const data = await putAdmin<{ shops: Record<string, ShopDefinition> }>(
        `/api/admin/shops/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, shopDef);
      ctx.patchVersionContent({ shops: data.shops });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteShop(ctx: AdminContext, id: string): Promise<void> {
    const shop = (ctx.getDisplayContent()?.shops ?? {})[id];
    if (!shop) return;
    if (!confirm(`Delete shop "${shop.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ shops: Record<string, ShopDefinition> }>(
        `/api/admin/shops/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ shops: data.shops });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
