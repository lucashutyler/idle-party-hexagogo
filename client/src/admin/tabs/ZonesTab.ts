import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type {
  ZoneDefinition,
  EncounterTableEntry,
  EncounterDefinition,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class ZonesTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const zones = Object.values(content.zones);
    const encounters = content.encounters;
    const readOnly = ctx.isReadOnly();

    const rows = zones.map(z => {
      const encounterDescs = z.encounterTable
        .map(e => `${encounters[e.encounterId]?.name ?? e.encounterId} (w:${e.weight})`)
        .join(', ');

      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm zone-edit-btn" data-id="${z.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger zone-delete-btn" data-id="${z.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${escapeHtml(z.displayName)}</td>
          <td>${z.levelRange[0]}-${z.levelRange[1]}</td>
          <td>${escapeHtml(encounterDescs)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="zone-add-btn">+ Add Zone</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Zones <span class="admin-count-badge">${zones.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Level Range</th>
                <th>Encounters (weight)</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#zone-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.zone-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const zone = ctx.getDisplayContent()?.zones[btn.dataset.id!];
        if (zone) this.openForm(zone, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.zone-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteZone(ctx, btn.dataset.id!));
    });
  }

  private openForm(zone: ZoneDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !zone;
    const z = zone ?? { id: '', displayName: '', levelRange: [1, 1] as [number, number], encounterTable: [] };
    const encounterDefs = Object.values(content.encounters);
    const encRows = z.encounterTable.map((e, i) => this.encounterRowHtml(i, e, encounterDefs)).join('');

    const bodyHtml = `
      <input type="hidden" id="zf-id" value="${escapeHtml(z.id)}">
      <div class="admin-form-grid">
        <label>Display Name<input type="text" id="zf-name" value="${escapeHtml(z.displayName)}"></label>
        <label>Level Min<input type="number" id="zf-levelMin" value="${z.levelRange[0]}" min="1"></label>
        <label>Level Max<input type="number" id="zf-levelMax" value="${z.levelRange[1]}" min="1"></label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Encounter Table <button class="admin-btn admin-btn-sm" id="zf-add-encounter" type="button">+ Encounter</button></legend>
        <div id="zf-encounters-list">${encRows}</div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="zf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="zf-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Zone' : `Edit: ${z.displayName}`,
      bodyHtml,
      width: '640px',
    });
    const root = modal.body;
    root.querySelector('#zf-cancel')?.addEventListener('click', modal.close);

    root.querySelector('#zf-add-encounter')?.addEventListener('click', () => {
      const list = root.querySelector('#zf-encounters-list');
      if (!list || encounterDefs.length === 0) return;
      const index = list.querySelectorAll('.zf-enc-row').length;
      list.insertAdjacentHTML('beforeend', this.encounterRowHtml(index, {
        encounterId: encounterDefs[0].id, weight: 1,
      }, encounterDefs));
      this.wireRemovers(root);
    });

    this.wireRemovers(root);
    root.querySelector('#zf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
  }

  private wireRemovers(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('.zf-enc-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.zf-enc-row')?.remove();
    });
  }

  private encounterRowHtml(index: number, entry: EncounterTableEntry, encounters: EncounterDefinition[]): string {
    const options = encounters.map(enc =>
      `<option value="${enc.id}" ${enc.id === entry.encounterId ? 'selected' : ''}>${escapeHtml(enc.name)}</option>`
    ).join('');
    return `
      <div class="zf-enc-row admin-form-row" data-index="${index}">
        <select class="zf-enc-id">${options}</select>
        <label>W <input type="number" class="zf-enc-weight" value="${entry.weight}" min="1" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger zf-enc-remove" type="button">×</button>
      </div>
    `;
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#zf-id') as HTMLInputElement).value.trim();
    const displayName = (root.querySelector('#zf-name') as HTMLInputElement).value.trim();
    const levelMin = parseInt((root.querySelector('#zf-levelMin') as HTMLInputElement).value) || 1;
    const levelMax = parseInt((root.querySelector('#zf-levelMax') as HTMLInputElement).value) || 1;
    if (!displayName) { alert('Display Name is required.'); return; }

    const content = ctx.getDisplayContent();
    if (content) {
      const dup = Object.values(content.zones).find(z => z.displayName === displayName && z.id !== existingId);
      if (dup) { alert(`A zone named "${displayName}" already exists.`); return; }
    }
    const id = existingId || crypto.randomUUID();

    const encounterTable: EncounterTableEntry[] = [];
    root.querySelectorAll('.zf-enc-row').forEach(row => {
      const encounterId = (row.querySelector('.zf-enc-id') as HTMLSelectElement).value;
      const weight = parseInt((row.querySelector('.zf-enc-weight') as HTMLInputElement).value) || 1;
      if (encounterId) encounterTable.push({ encounterId, weight });
    });

    const zone: ZoneDefinition = { id, displayName, levelRange: [levelMin, levelMax], encounterTable };
    try {
      const data = await putAdmin<{ zones: Record<string, ZoneDefinition> }>(
        `/api/admin/zones/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, zone);
      ctx.patchVersionContent({ zones: data.zones });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteZone(ctx: AdminContext, id: string): Promise<void> {
    const zone = ctx.getDisplayContent()?.zones[id];
    if (!zone) return;
    if (!confirm(`Delete zone "${zone.displayName}"?`)) return;
    try {
      const data = await deleteAdmin<{ zones: Record<string, ZoneDefinition> }>(
        `/api/admin/zones/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ zones: data.zones });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
