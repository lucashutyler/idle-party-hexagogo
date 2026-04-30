import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { TileTypeDefinition } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin, postAdmin } from '../api';
import { openModal } from '../components/Modal';

export class TileTypesTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const tileTypes = Object.values(content.tileTypes ?? {});
    const items = content.items;
    const readOnly = ctx.isReadOnly();

    const cards = tileTypes.map(t => {
      const itemName = t.requiredItemId ? (items[t.requiredItemId]?.name ?? t.requiredItemId) : '';
      const ntMarker = t.traversable ? '' : '<span class="tile-type-card-blocked" title="Non-traversable">×</span>';
      const requiredItemTag = itemName
        ? `<div class="tile-type-card-tag">Requires: ${escapeHtml(itemName)}</div>`
        : '';
      const editBtn = readOnly ? '' : `<button class="admin-btn admin-btn-sm tile-type-edit-btn" data-id="${escapeHtml(t.id)}">Edit</button>`;
      const deleteBtn = readOnly ? '' : `<button class="admin-btn admin-btn-sm admin-btn-danger tile-type-delete-btn" data-id="${escapeHtml(t.id)}">Del</button>`;
      return `
        <div class="tile-type-card">
          <div class="tile-type-card-preview" style="--tile-color:${escapeHtml(t.color)}">
            <div class="tile-type-card-hex"></div>
            <div class="tile-type-card-icon">${escapeHtml(t.icon)}</div>
            ${ntMarker}
          </div>
          <div class="tile-type-card-name">${escapeHtml(t.name)}</div>
          <div class="tile-type-card-id">${escapeHtml(t.id)}</div>
          ${requiredItemTag}
          <div class="tile-type-card-actions">${editBtn}${deleteBtn}</div>
        </div>
      `;
    }).join('');

    const newBtn = readOnly ? '' : '<button class="admin-btn" id="tile-type-new-btn">+ New Tile Type</button>';
    const seedBtn = !readOnly && tileTypes.length === 0
      ? '<button class="admin-btn" id="tile-type-seed-btn">Restore Seed Data</button>'
      : '';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Tile Types <span class="admin-count-badge">${tileTypes.length}</span></h2>
          ${newBtn}${seedBtn}
        </div>
        <div class="tile-type-grid">
          ${cards || '<div class="admin-page-empty">No tile types yet.</div>'}
        </div>
      </div>
    `;

    container.querySelectorAll<HTMLButtonElement>('.tile-type-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => this.openModal(btn.dataset.id!, ctx));
    });
    container.querySelectorAll<HTMLButtonElement>('.tile-type-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteTileType(ctx, btn.dataset.id!));
    });
    container.querySelector('#tile-type-new-btn')?.addEventListener('click', () => this.openModal(null, ctx));
    container.querySelector('#tile-type-seed-btn')?.addEventListener('click', () => this.seed(ctx));
  }

  private openModal(editId: string | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    const existing = editId ? content.tileTypes?.[editId] ?? null : null;
    const items = Object.values(content.items);
    const itemOptions = items.map(i =>
      `<option value="${escapeHtml(i.id)}"${existing?.requiredItemId === i.id ? ' selected' : ''}>${escapeHtml(i.name)}</option>`
    ).join('');

    const initColor = existing?.color ?? '#888888';
    const bodyHtml = `
      <div class="tile-type-form">
        <div class="tile-type-form-preview" style="--tile-color:${escapeHtml(initColor)}">
          <div class="tile-type-card-hex"></div>
          <div class="tile-type-card-icon" id="ttf-preview-icon">${escapeHtml(existing?.icon ?? '?')}</div>
        </div>
        <div class="admin-form-grid">
          <label>ID<input id="ttf-id" value="${escapeHtml(existing?.id ?? '')}" ${existing ? 'readonly' : ''}></label>
          <label>Name<input id="ttf-name" value="${escapeHtml(existing?.name ?? '')}"></label>
          <label>Icon (emoji)<input id="ttf-icon" value="${escapeHtml(existing?.icon ?? '')}"></label>
          <label class="tile-type-color-field">
            Color
            <span class="tile-type-color-row">
              <input id="ttf-color" type="color" value="${escapeHtml(initColor)}">
              <code id="ttf-color-text" class="tile-type-color-hex">${escapeHtml(initColor)}</code>
            </span>
          </label>
          <label class="admin-form-checkbox">
            <input id="ttf-traversable" type="checkbox" ${existing?.traversable !== false ? 'checked' : ''}>
            Traversable
          </label>
          <label>Required Item
            <select id="ttf-required-item"><option value="">(none)</option>${itemOptions}</select>
          </label>
        </div>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="ttf-save" type="button">Save</button>
        <button class="admin-btn admin-btn-secondary" id="ttf-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: existing ? `Edit: ${existing.name}` : 'New Tile Type',
      bodyHtml,
      width: '520px',
    });
    const root = modal.body;

    const previewBox = root.querySelector('.tile-type-form-preview') as HTMLElement;
    const iconInput = root.querySelector<HTMLInputElement>('#ttf-icon');
    const previewIcon = root.querySelector<HTMLElement>('#ttf-preview-icon');
    const colorInput = root.querySelector<HTMLInputElement>('#ttf-color');
    const colorText = root.querySelector<HTMLElement>('#ttf-color-text');

    iconInput?.addEventListener('input', () => {
      if (previewIcon) previewIcon.textContent = iconInput.value || '?';
    });
    colorInput?.addEventListener('input', () => {
      if (previewBox) previewBox.style.setProperty('--tile-color', colorInput.value);
      if (colorText) colorText.textContent = colorInput.value;
    });

    root.querySelector('#ttf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#ttf-save')?.addEventListener('click', async () => {
      const id = (root.querySelector('#ttf-id') as HTMLInputElement).value.trim();
      const name = (root.querySelector('#ttf-name') as HTMLInputElement).value.trim();
      const icon = (root.querySelector('#ttf-icon') as HTMLInputElement).value.trim();
      const color = (root.querySelector('#ttf-color') as HTMLInputElement).value;
      const traversable = (root.querySelector('#ttf-traversable') as HTMLInputElement).checked;
      const requiredItemId = (root.querySelector('#ttf-required-item') as HTMLSelectElement).value || undefined;
      if (!id) { alert('ID is required.'); return; }
      if (!name) { alert('Name is required.'); return; }
      try {
        const data = await putAdmin<{ tileTypes: Record<string, TileTypeDefinition> }>(
          `/api/admin/tile-types/${encodeURIComponent(id)}${ctx.versionQueryParam()}`,
          { name, icon, color, traversable, requiredItemId });
        ctx.patchVersionContent({ tileTypes: data.tileTypes });
        modal.close();
        ctx.rerenderTab();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Network error');
      }
    });
  }

  private async deleteTileType(ctx: AdminContext, id: string): Promise<void> {
    const tt = ctx.getDisplayContent()?.tileTypes?.[id];
    if (!tt) return;
    if (!confirm(`Delete tile type "${tt.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ tileTypes: Record<string, TileTypeDefinition> }>(
        `/api/admin/tile-types/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ tileTypes: data.tileTypes });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async seed(ctx: AdminContext): Promise<void> {
    if (!confirm('Restore default tile types? This will add any missing seed types.')) return;
    try {
      const data = await postAdmin<{ tileTypes: Record<string, TileTypeDefinition> }>(
        `/api/admin/tile-types/seed${ctx.versionQueryParam()}`, {});
      ctx.patchVersionContent({ tileTypes: data.tileTypes });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
