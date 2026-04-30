import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type {
  EncounterDefinition,
  RandomMonsterEntry,
  ExplicitPlacement,
  MonsterDefinition,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal, type ModalHandle } from '../components/Modal';

export class EncountersTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const encounters = Object.values(content.encounters);
    const monsters = content.monsters;
    const readOnly = ctx.isReadOnly();

    const rows = encounters.map(enc => {
      let summary = '';
      if (enc.type === 'random') {
        summary = (enc.monsterPool ?? []).map(p => {
          const m = monsters[p.monsterId];
          return `${m?.name ?? p.monsterId} (${p.min}-${p.max})`;
        }).join(', ') || 'Empty pool';
      } else {
        summary = (enc.placements ?? []).map(p => {
          const m = monsters[p.monsterId];
          return `${m?.name ?? p.monsterId} @${p.gridPosition}`;
        }).join(', ') || 'No placements';
      }

      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm encounter-edit-btn" data-id="${enc.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger encounter-delete-btn" data-id="${enc.id}">Del</button>
        </td>
      `;
      return `<tr>
        <td>${escapeHtml(enc.name)}</td>
        <td>${enc.type}</td>
        <td>${escapeHtml(summary)}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="encounter-add-btn">+ Add Encounter</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Encounters <span class="admin-count-badge">${encounters.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Type</th><th>Summary</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#encounter-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.encounter-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const enc = ctx.getDisplayContent()?.encounters[btn.dataset.id!];
        if (enc) this.openForm(enc, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.encounter-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteEncounter(ctx, btn.dataset.id!));
    });
  }

  private openForm(encounter: EncounterDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    const isNew = !encounter;
    const enc = encounter ?? {
      id: '', name: '', type: 'random' as const, monsterPool: [], roomMax: 9, placements: [],
    };

    const bodyHtml = `
      <div class="admin-form-grid">
        <label>Name<input type="text" id="enc-name" value="${escapeHtml(enc.name)}"></label>
        <label>Type
          <select id="enc-type">
            <option value="random" ${enc.type === 'random' ? 'selected' : ''}>Random</option>
            <option value="explicit" ${enc.type === 'explicit' ? 'selected' : ''}>Explicit</option>
          </select>
        </label>
      </div>
      <input type="hidden" id="enc-id" value="${escapeHtml(enc.id)}">
      <div id="enc-body"></div>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="enc-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="enc-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Encounter' : `Edit: ${enc.name}`,
      bodyHtml,
      width: '720px',
    });
    const root = modal.body;
    this.renderBody(root, enc, ctx);

    root.querySelector('#enc-type')?.addEventListener('change', () => {
      const type = (root.querySelector('#enc-type') as HTMLSelectElement).value as 'random' | 'explicit';
      const blank: EncounterDefinition = {
        id: (root.querySelector('#enc-id') as HTMLInputElement).value,
        name: (root.querySelector('#enc-name') as HTMLInputElement).value,
        type,
        monsterPool: [],
        roomMax: 9,
        placements: [],
      };
      this.renderBody(root, blank, ctx);
    });

    root.querySelector('#enc-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#enc-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal));
  }

  private renderBody(root: HTMLElement, enc: EncounterDefinition, ctx: AdminContext): void {
    const body = root.querySelector('#enc-body') as HTMLElement;
    if (!body) return;
    const content = ctx.getDisplayContent();
    if (!content) return;
    const monsters = content.monsters;
    const type = (root.querySelector('#enc-type') as HTMLSelectElement).value;

    if (type === 'random') {
      const poolRows = (enc.monsterPool ?? []).map((p, i) => this.poolRowHtml(i, p, monsters)).join('');
      body.innerHTML = `
        <fieldset class="admin-form-fieldset">
          <legend>Monster Pool <button class="admin-btn admin-btn-sm" id="enc-add-pool" type="button">+ Monster</button></legend>
          <div id="enc-pool-list">${poolRows}</div>
          <label>Room Max <input type="number" id="enc-room-max" value="${enc.roomMax ?? 9}" min="1" max="9"></label>
        </fieldset>
      `;
      body.querySelector('#enc-add-pool')?.addEventListener('click', () => {
        const list = body.querySelector('#enc-pool-list');
        if (!list) return;
        const index = list.children.length;
        const firstMonsterId = Object.keys(monsters)[0] ?? '';
        const entry: RandomMonsterEntry = { monsterId: firstMonsterId, min: 1, max: 1 };
        list.insertAdjacentHTML('beforeend', this.poolRowHtml(index, entry, monsters));
        this.wirePoolRemovers(body);
      });
      this.wirePoolRemovers(body);
    } else {
      const cells: string[] = [];
      for (let pos = 0; pos < 9; pos++) {
        const placement = (enc.placements ?? []).find(p => p.gridPosition === pos);
        const selectedId = placement?.monsterId ?? '';
        const options = `<option value="">Empty</option>` + Object.values(monsters).map(m =>
          `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
        ).join('');
        cells.push(`
          <div class="enc-grid-cell" data-pos="${pos}">
            <div class="enc-grid-pos">${pos}</div>
            <select class="enc-grid-monster">${options}</select>
          </div>
        `);
      }
      body.innerHTML = `
        <fieldset class="admin-form-fieldset">
          <legend>Monster Placements (3x3 Grid)</legend>
          <div class="enc-grid">${cells.join('')}</div>
        </fieldset>
      `;
    }
  }

  private poolRowHtml(index: number, entry: RandomMonsterEntry, monsters: Record<string, MonsterDefinition>): string {
    const options = Object.values(monsters).map(m =>
      `<option value="${m.id}" ${m.id === entry.monsterId ? 'selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    return `
      <div class="enc-pool-row admin-form-row" data-index="${index}">
        <select class="enc-pool-monster">${options}</select>
        <label>Min<input type="number" class="enc-pool-min" value="${entry.min}" min="0" max="9"></label>
        <label>Max<input type="number" class="enc-pool-max" value="${entry.max}" min="0" max="9"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger enc-pool-remove" type="button">×</button>
      </div>
    `;
  }

  private wirePoolRemovers(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('.enc-pool-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.enc-pool-row')?.remove();
    });
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, modal: ModalHandle): Promise<void> {
    const existingId = (root.querySelector('#enc-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#enc-name') as HTMLInputElement).value.trim();
    const type = (root.querySelector('#enc-type') as HTMLSelectElement).value as 'random' | 'explicit';
    if (!name) { alert('Name is required.'); return; }
    const id = existingId || crypto.randomUUID();
    const encounter: EncounterDefinition = { id, name, type };

    if (type === 'random') {
      const pool: RandomMonsterEntry[] = [];
      root.querySelectorAll('.enc-pool-row').forEach(row => {
        const monsterId = (row.querySelector('.enc-pool-monster') as HTMLSelectElement).value;
        const min = parseInt((row.querySelector('.enc-pool-min') as HTMLInputElement).value) || 0;
        const max = parseInt((row.querySelector('.enc-pool-max') as HTMLInputElement).value) || 0;
        if (monsterId) pool.push({ monsterId, min, max });
      });
      encounter.monsterPool = pool;
      encounter.roomMax = parseInt((root.querySelector('#enc-room-max') as HTMLInputElement)?.value) || 9;
    } else {
      const placements: ExplicitPlacement[] = [];
      root.querySelectorAll('.enc-grid-cell').forEach(cell => {
        const pos = parseInt((cell as HTMLElement).dataset.pos!) as ExplicitPlacement['gridPosition'];
        const monsterId = (cell.querySelector('.enc-grid-monster') as HTMLSelectElement).value;
        if (monsterId) placements.push({ monsterId, gridPosition: pos });
      });
      encounter.placements = placements;
    }

    try {
      const data = await putAdmin<{ encounters: Record<string, EncounterDefinition> }>(
        `/api/admin/encounters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, encounter);
      ctx.patchVersionContent({ encounters: data.encounters });
      modal.close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteEncounter(ctx: AdminContext, id: string): Promise<void> {
    const enc = ctx.getDisplayContent()?.encounters[id];
    if (!enc) return;
    if (!confirm(`Delete encounter "${enc.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ encounters: Record<string, EncounterDefinition> }>(
        `/api/admin/encounters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ encounters: data.encounters });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
