import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { EQUIP_SLOTS, DISPLAY_EQUIP_SLOTS, ALL_CLASS_NAMES } from '@idle-party-rpg/shared';
import type { ItemDefinition, ItemRarity, EquipSlot } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

const RARITIES: ItemRarity[] = ['janky', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'heirloom'];

export class ItemsTab implements Tab {
  private slotFilter = 'all';

  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const allItems = Object.values(content.items);
    const readOnly = ctx.isReadOnly();

    const slotOptions = ['all', ...EQUIP_SLOTS, 'twohanded', 'none'].map(slot => {
      const selected = this.slotFilter === slot ? ' selected' : '';
      const label = slot === 'none' ? 'No Slot' : slot.charAt(0).toUpperCase() + slot.slice(1);
      return `<option value="${slot}"${selected}>${label}</option>`;
    }).join('');

    const items = allItems.filter(i => {
      if (this.slotFilter === 'all') return true;
      if (this.slotFilter === 'none') return !i.equipSlot;
      if (this.slotFilter === 'twohanded') return i.equipSlot === 'twohanded';
      return i.equipSlot === this.slotFilter;
    });

    const itemSetMap = new Map<string, string>();
    if (content.sets) {
      for (const set of Object.values(content.sets)) {
        for (const itemId of set.itemIds) itemSetMap.set(itemId, set.name);
      }
    }

    const rows = items.map(i => {
      const effects: string[] = [];
      if (i.bonusAttackMin != null && i.bonusAttackMax != null && i.bonusAttackMax > 0) {
        effects.push(`+${i.bonusAttackMin}-${i.bonusAttackMax} Atk`);
      }
      if (i.damageReductionMin != null && i.damageReductionMax != null && i.damageReductionMax > 0) {
        effects.push(`${i.damageReductionMin}-${i.damageReductionMax} DR`);
      }
      if (i.magicReductionMin != null && i.magicReductionMax != null && i.magicReductionMax > 0) {
        effects.push(`${i.magicReductionMin}-${i.magicReductionMax} MR`);
      }
      const setName = itemSetMap.get(i.id) ?? '—';

      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm item-edit-btn" data-id="${i.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger item-delete-btn" data-id="${i.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td><img src="/item-artwork/${i.id}.png" class="admin-thumb" onerror="this.style.display='none'">${escapeHtml(i.name)}</td>
          <td><span class="rarity-${i.rarity}">${i.rarity}</span></td>
          <td>${i.equipSlot ?? '—'}</td>
          <td>${effects.length > 0 ? effects.join(', ') : 'Material'}</td>
          <td>${i.value ?? 1}</td>
          <td>${escapeHtml(setName)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="item-add-btn">+ Add Item</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Items <span class="admin-count-badge">${items.length} of ${allItems.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-filter-bar">
          <label class="admin-inline-field">Slot <select id="item-slot-filter">${slotOptions}</select></label>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Rarity</th>
                <th>Slot</th>
                <th>Effects</th>
                <th>Value</th>
                <th>Set</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#item-slot-filter')?.addEventListener('change', e => {
      this.slotFilter = (e.target as HTMLSelectElement).value;
      ctx.rerenderTab();
    });
    container.querySelector('#item-add-btn')?.addEventListener('click', () => {
      this.openForm(null, ctx);
    });
    container.querySelectorAll<HTMLButtonElement>('.item-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const item = ctx.getDisplayContent()?.items[id];
        if (item) this.openForm(item, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.item-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        this.deleteItem(ctx, id);
      });
    });
  }

  private openForm(item: ItemDefinition | null, ctx: AdminContext): void {
    const isNew = !item;
    const i = item ?? { id: '', name: '', rarity: 'common' as const };

    const rarityOptions = RARITIES.map(r =>
      `<option value="${r}" ${i.rarity === r ? 'selected' : ''}>${r}</option>`
    ).join('');

    const slotOptions = ['', ...DISPLAY_EQUIP_SLOTS, 'twohanded'].map(s =>
      `<option value="${s}" ${(i.equipSlot ?? '') === s ? 'selected' : ''}>${s || '(none — material)'}</option>`
    ).join('');

    const classRestrictions = Array.isArray(i.classRestriction) ? i.classRestriction : [];
    const classCheckboxes = ALL_CLASS_NAMES.map(c =>
      `<label class="admin-checkbox">
        <input type="checkbox" class="if-class-check" value="${c}" ${classRestrictions.includes(c) ? 'checked' : ''}>
        ${c}
      </label>`
    ).join('');

    const artworkPreview = i.id
      ? `<img src="/item-artwork/${i.id}.png" class="admin-art-preview" onerror="this.style.display='none'">`
      : '';

    const bodyHtml = `
      <input type="hidden" id="if-id" value="${escapeHtml(i.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="if-name" value="${escapeHtml(i.name)}"></label>
        <label>Rarity<select id="if-rarity">${rarityOptions}</select></label>
        <label>Equip Slot<select id="if-equipSlot">${slotOptions}</select></label>
        <label>Attack Min<input type="number" id="if-atkMin" value="${i.bonusAttackMin ?? 0}" min="0"></label>
        <label>Attack Max<input type="number" id="if-atkMax" value="${i.bonusAttackMax ?? 0}" min="0"></label>
        <label>DR Min<input type="number" id="if-drMin" value="${i.damageReductionMin ?? 0}" min="0"></label>
        <label>DR Max<input type="number" id="if-drMax" value="${i.damageReductionMax ?? 0}" min="0"></label>
        <label>MR Min<input type="number" id="if-mrMin" value="${i.magicReductionMin ?? 0}" min="0"></label>
        <label>MR Max<input type="number" id="if-mrMax" value="${i.magicReductionMax ?? 0}" min="0"></label>
        <label>Value<input type="number" id="if-value" value="${i.value ?? 1}" min="0"></label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Class Restriction</legend>
        <div class="admin-checkbox-row">${classCheckboxes}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Artwork</legend>
        ${artworkPreview}
        <input type="file" id="if-artwork-file" accept="image/png">
        <div class="admin-modal-actions">
          <button class="admin-btn admin-btn-sm" id="if-artwork-upload" type="button">Upload</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger" id="if-artwork-remove" type="button">Remove Artwork</button>
        </div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="if-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="if-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Item' : `Edit: ${i.name}`,
      bodyHtml,
      width: '720px',
    });
    const root = modal.body;

    root.querySelector('#if-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#if-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
    root.querySelector('#if-artwork-upload')?.addEventListener('click', () => this.uploadArtwork(root));
    root.querySelector('#if-artwork-remove')?.addEventListener('click', () => this.removeArtwork(root));
  }

  private async uploadArtwork(root: HTMLElement): Promise<void> {
    const id = (root.querySelector('#if-id') as HTMLInputElement).value.trim();
    if (!id) { alert('Save the item first before uploading artwork.'); return; }
    const fileInput = root.querySelector('#if-artwork-file') as HTMLInputElement;
    if (!fileInput?.files?.length) { alert('Select a PNG file first.'); return; }
    const formData = new FormData();
    formData.append('artwork', fileInput.files[0]);
    try {
      const res = await fetch(`/api/admin/items/${encodeURIComponent(id)}/artwork`, {
        method: 'POST', credentials: 'include', body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to upload artwork');
        return;
      }
      alert('Artwork uploaded successfully.');
    } catch {
      alert('Network error uploading artwork.');
    }
  }

  private async removeArtwork(root: HTMLElement): Promise<void> {
    const id = (root.querySelector('#if-id') as HTMLInputElement).value.trim();
    if (!id) return;
    if (!confirm('Remove artwork for this item?')) return;
    try {
      const res = await fetch(`/api/admin/items/${encodeURIComponent(id)}/artwork`, {
        method: 'DELETE', credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to remove artwork');
        return;
      }
      alert('Artwork removed.');
    } catch {
      alert('Network error removing artwork.');
    }
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#if-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#if-name') as HTMLInputElement).value.trim();
    const rarity = (root.querySelector('#if-rarity') as HTMLSelectElement).value as ItemRarity;
    const equipSlot = (root.querySelector('#if-equipSlot') as HTMLSelectElement).value || undefined;
    const bonusAttackMin = parseInt((root.querySelector('#if-atkMin') as HTMLInputElement).value) || 0;
    const bonusAttackMax = parseInt((root.querySelector('#if-atkMax') as HTMLInputElement).value) || 0;
    const damageReductionMin = parseInt((root.querySelector('#if-drMin') as HTMLInputElement).value) || 0;
    const damageReductionMax = parseInt((root.querySelector('#if-drMax') as HTMLInputElement).value) || 0;
    const magicReductionMin = parseInt((root.querySelector('#if-mrMin') as HTMLInputElement).value) || 0;
    const magicReductionMax = parseInt((root.querySelector('#if-mrMax') as HTMLInputElement).value) || 0;
    const value = parseInt((root.querySelector('#if-value') as HTMLInputElement).value) || 1;

    if (!name) { alert('Name is required.'); return; }
    const content = ctx.getDisplayContent();
    if (content) {
      const dup = Object.values(content.items).find(it => it.name === name && it.id !== existingId);
      if (dup) { alert(`An item named "${name}" already exists.`); return; }
    }
    const id = existingId || crypto.randomUUID();
    const item: ItemDefinition = { id, name, rarity };
    if (equipSlot) item.equipSlot = equipSlot as EquipSlot;

    const classRestriction: string[] = [];
    root.querySelectorAll<HTMLInputElement>('.if-class-check').forEach(cb => {
      if (cb.checked) classRestriction.push(cb.value);
    });
    if (classRestriction.length > 0) item.classRestriction = classRestriction;

    if (bonusAttackMin > 0 || bonusAttackMax > 0) { item.bonusAttackMin = bonusAttackMin; item.bonusAttackMax = bonusAttackMax; }
    if (damageReductionMin > 0 || damageReductionMax > 0) { item.damageReductionMin = damageReductionMin; item.damageReductionMax = damageReductionMax; }
    if (magicReductionMin > 0 || magicReductionMax > 0) { item.magicReductionMin = magicReductionMin; item.magicReductionMax = magicReductionMax; }
    if (value !== 1) item.value = value;

    try {
      const data = await putAdmin<{ items: Record<string, ItemDefinition> }>(
        `/api/admin/items/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, item);
      ctx.patchVersionContent({ items: data.items });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteItem(ctx: AdminContext, id: string): Promise<void> {
    const item = ctx.getDisplayContent()?.items[id];
    if (!item) return;
    if (!confirm(`Delete item "${item.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ items: Record<string, ItemDefinition> }>(
        `/api/admin/items/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ items: data.items });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
