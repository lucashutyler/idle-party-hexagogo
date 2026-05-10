import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type {
  DungeonDefinition,
  DungeonFloor,
  DungeonReward,
  DungeonEntryRequirements,
  EncounterTableEntry,
  ItemDefinition,
  EncounterDefinition,
  ClassName,
} from '@idle-party-rpg/shared';
import { ALL_CLASS_NAMES } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal, type ModalHandle } from '../components/Modal';

export class DungeonsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const dungeons = Object.values(content.dungeons ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = dungeons.map(d => {
      const reqs = this.summarizeEntry(d.entryRequirements);
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm dungeon-edit-btn" data-id="${d.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger dungeon-delete-btn" data-id="${d.id}">Del</button>
        </td>
      `;
      return `<tr>
        <td>${escapeHtml(d.name)}</td>
        <td>${d.floors.length}</td>
        <td>${escapeHtml(reqs)}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="dungeon-add-btn">+ Add Dungeon</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Dungeons <span class="admin-count-badge">${dungeons.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Floors</th><th>Entry</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#dungeon-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.dungeon-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const dungeon = (ctx.getDisplayContent()?.dungeons ?? {})[btn.dataset.id!];
        if (dungeon) this.openForm(dungeon, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.dungeon-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteDungeon(ctx, btn.dataset.id!));
    });
  }

  private summarizeEntry(reqs?: DungeonEntryRequirements): string {
    if (!reqs) return '—';
    const parts: string[] = [];
    if (reqs.minLevel != null) parts.push(`Lv≥${reqs.minLevel}`);
    if (reqs.maxLevel != null) parts.push(`Lv≤${reqs.maxLevel}`);
    if (reqs.requiredItemId) parts.push(`item:${reqs.requiredItemId}${reqs.consumeRequiredItem ? ' (consume)' : ''}`);
    if (reqs.requiredClasses?.length) parts.push(`class:${reqs.requiredClasses.join('/')}`);
    if (reqs.minPartySize != null) parts.push(`party≥${reqs.minPartySize}`);
    if (reqs.maxPartySize != null) parts.push(`party≤${reqs.maxPartySize}`);
    return parts.length ? parts.join(', ') : '—';
  }

  private openForm(dungeon: DungeonDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    const isNew = !dungeon;
    const d: DungeonDefinition = dungeon ?? {
      id: '',
      name: '',
      description: '',
      floors: [],
      entryRequirements: {},
      firstClearRewards: [],
    };

    const items = Object.values(content.items)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const encounters = Object.values(content.encounters)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

    const reqs = d.entryRequirements ?? {};
    const classCheckboxes = ALL_CLASS_NAMES.map(cn => `
      <label class="admin-checkbox">
        <input type="checkbox" class="df-req-class" value="${cn}" ${reqs.requiredClasses?.includes(cn) ? 'checked' : ''}>
        ${cn}
      </label>
    `).join('');

    const itemOptions = `<option value="">— none —</option>` + items.map(i =>
      `<option value="${i.id}" ${i.id === reqs.requiredItemId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
    ).join('');

    const floorRows = d.floors.map((f, i) => this.floorRowHtml(i, f, encounters, items)).join('');
    const firstClearRows = (d.firstClearRewards ?? []).map((r, i) => this.rewardRowHtml('df-first-clear', i, r, items)).join('');

    const bodyHtml = `
      <input type="hidden" id="df-id" value="${escapeHtml(d.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="df-name" value="${escapeHtml(d.name)}"></label>
      </div>
      <label>Description<textarea id="df-description" rows="2">${escapeHtml(d.description ?? '')}</textarea></label>

      <fieldset class="admin-form-fieldset">
        <legend>Floors <button class="admin-btn admin-btn-sm" id="df-add-floor" type="button">+ Floor</button></legend>
        <div id="df-floor-list">${floorRows}</div>
      </fieldset>

      <fieldset class="admin-form-fieldset">
        <legend>Entry Requirements</legend>
        <div class="admin-form-grid">
          <label>Min Level<input type="number" id="df-req-min-level" value="${reqs.minLevel ?? ''}" min="1"></label>
          <label>Max Level<input type="number" id="df-req-max-level" value="${reqs.maxLevel ?? ''}" min="1"></label>
          <label>Min Party Size<input type="number" id="df-req-min-party" value="${reqs.minPartySize ?? ''}" min="1"></label>
          <label>Max Party Size<input type="number" id="df-req-max-party" value="${reqs.maxPartySize ?? ''}" min="1"></label>
        </div>
        <div class="admin-form-grid">
          <label>Required Item
            <select id="df-req-item">${itemOptions}</select>
          </label>
          <label class="admin-checkbox">
            <input type="checkbox" id="df-req-consume" ${reqs.consumeRequiredItem ? 'checked' : ''}>
            Consume on entry
          </label>
        </div>
        <fieldset class="admin-form-fieldset">
          <legend>Allowed Classes (none checked = any)</legend>
          <div class="admin-checklist">${classCheckboxes}</div>
        </fieldset>
      </fieldset>

      <fieldset class="admin-form-fieldset">
        <legend>First-Clear Rewards <button class="admin-btn admin-btn-sm" id="df-add-first-clear" type="button">+ Reward</button></legend>
        <div id="df-first-clear-list">${firstClearRows}</div>
      </fieldset>

      <div class="admin-modal-actions">
        <button class="admin-btn" id="df-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="df-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Dungeon' : `Edit: ${d.name}`,
      bodyHtml,
      width: '880px',
    });
    const root = modal.body;

    this.wireFloorControls(root, encounters, items);
    this.wireRewardControls(root, 'df-first-clear', items);

    root.querySelector('#df-add-floor')?.addEventListener('click', () => {
      const list = root.querySelector('#df-floor-list');
      if (!list) return;
      const index = list.children.length;
      const blank: DungeonFloor = {
        floorNumber: index + 1,
        gridShape: { cols: 3, rows: 3 },
        encounterTable: [],
        rewards: [],
      };
      list.insertAdjacentHTML('beforeend', this.floorRowHtml(index, blank, encounters, items));
      this.wireFloorControls(root, encounters, items);
    });

    root.querySelector('#df-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#df-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal));
  }

  private floorRowHtml(index: number, floor: DungeonFloor, encounters: EncounterDefinition[], items: ItemDefinition[]): string {
    const rewardRows = (floor.rewards ?? []).map((r, i) => this.rewardRowHtml(`df-floor-${index}-reward`, i, r, items)).join('');
    const encounterRows = (floor.encounterTable ?? []).map((e, i) => this.encounterRowHtml(`df-floor-${index}-enc`, i, e, encounters)).join('');
    return `
      <fieldset class="admin-form-fieldset df-floor" data-floor-index="${index}">
        <legend>
          Floor ${index + 1}
          <button class="admin-btn admin-btn-sm admin-btn-danger df-floor-remove" type="button" data-floor-index="${index}">×</button>
        </legend>
        <div class="admin-form-grid">
          <label>Floor Number<input type="number" class="df-floor-number" value="${floor.floorNumber}" min="1"></label>
          <label>Grid Cols<input type="number" class="df-floor-cols" value="${floor.gridShape.cols}" min="1" max="9"></label>
          <label>Grid Rows<input type="number" class="df-floor-rows" value="${floor.gridShape.rows}" min="1" max="9"></label>
          <label class="admin-checkbox">
            <input type="checkbox" class="df-floor-boss" ${floor.isBoss ? 'checked' : ''}>
            Boss floor
          </label>
        </div>
        <fieldset class="admin-form-fieldset">
          <legend>Encounter Table <button class="admin-btn admin-btn-sm df-floor-add-enc" type="button" data-floor-index="${index}">+ Encounter</button></legend>
          <div class="df-floor-enc-list" data-floor-index="${index}">${encounterRows}</div>
        </fieldset>
        <fieldset class="admin-form-fieldset">
          <legend>Floor Rewards <button class="admin-btn admin-btn-sm df-floor-add-reward" type="button" data-floor-index="${index}">+ Reward</button></legend>
          <div class="df-floor-reward-list" data-floor-index="${index}">${rewardRows}</div>
        </fieldset>
      </fieldset>
    `;
  }

  private encounterRowHtml(prefix: string, index: number, entry: EncounterTableEntry, encounters: EncounterDefinition[]): string {
    const options = `<option value="">—</option>` + encounters.map(e =>
      `<option value="${e.id}" ${e.id === entry.encounterId ? 'selected' : ''}>${escapeHtml(e.name)}</option>`
    ).join('');
    return `
      <div class="admin-form-row df-enc-row" data-prefix="${prefix}" data-row-index="${index}">
        <select class="df-enc-id">${options}</select>
        <label>Weight<input type="number" class="df-enc-weight" value="${entry.weight}" min="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger df-enc-remove" type="button">×</button>
      </div>
    `;
  }

  private rewardRowHtml(prefix: string, index: number, reward: DungeonReward, items: ItemDefinition[]): string {
    const options = `<option value="">—</option>` + items.map(i =>
      `<option value="${i.id}" ${i.id === reward.itemId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
    ).join('');
    return `
      <div class="admin-form-row df-reward-row" data-prefix="${prefix}" data-row-index="${index}">
        <select class="df-reward-item">${options}</select>
        <label>Chance<input type="number" class="df-reward-chance" value="${reward.chance}" min="0" max="1" step="0.01"></label>
        <label>Min<input type="number" class="df-reward-min" value="${reward.minQty ?? 1}" min="1"></label>
        <label>Max<input type="number" class="df-reward-max" value="${reward.maxQty ?? 1}" min="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger df-reward-remove" type="button">×</button>
      </div>
    `;
  }

  private wireFloorControls(root: HTMLElement, encounters: EncounterDefinition[], items: ItemDefinition[]): void {
    root.querySelectorAll<HTMLButtonElement>('.df-floor-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.df-floor')?.remove();
    });
    root.querySelectorAll<HTMLButtonElement>('.df-floor-add-enc').forEach(btn => {
      btn.onclick = () => {
        const floorIndex = btn.dataset.floorIndex!;
        const list = root.querySelector(`.df-floor-enc-list[data-floor-index="${floorIndex}"]`);
        if (!list) return;
        const index = list.children.length;
        const firstId = encounters[0]?.id ?? '';
        const entry: EncounterTableEntry = { encounterId: firstId, weight: 1 };
        list.insertAdjacentHTML('beforeend', this.encounterRowHtml(`df-floor-${floorIndex}-enc`, index, entry, encounters));
        this.wireRowRemovers(root);
      };
    });
    root.querySelectorAll<HTMLButtonElement>('.df-floor-add-reward').forEach(btn => {
      btn.onclick = () => {
        const floorIndex = btn.dataset.floorIndex!;
        const list = root.querySelector(`.df-floor-reward-list[data-floor-index="${floorIndex}"]`);
        if (!list) return;
        const index = list.children.length;
        const firstId = items[0]?.id ?? '';
        const reward: DungeonReward = { itemId: firstId, chance: 1, minQty: 1, maxQty: 1 };
        list.insertAdjacentHTML('beforeend', this.rewardRowHtml(`df-floor-${floorIndex}-reward`, index, reward, items));
        this.wireRowRemovers(root);
      };
    });
    this.wireRowRemovers(root);
  }

  private wireRewardControls(root: HTMLElement, prefix: string, items: ItemDefinition[]): void {
    root.querySelector(`#${prefix === 'df-first-clear' ? 'df-add-first-clear' : ''}`)?.addEventListener('click', () => {
      const list = root.querySelector(`#${prefix}-list`);
      if (!list) return;
      const index = list.children.length;
      const firstId = items[0]?.id ?? '';
      const reward: DungeonReward = { itemId: firstId, chance: 1, minQty: 1, maxQty: 1 };
      list.insertAdjacentHTML('beforeend', this.rewardRowHtml(prefix, index, reward, items));
      this.wireRowRemovers(root);
    });
    this.wireRowRemovers(root);
  }

  private wireRowRemovers(root: HTMLElement): void {
    root.querySelectorAll<HTMLButtonElement>('.df-enc-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.df-enc-row')?.remove();
    });
    root.querySelectorAll<HTMLButtonElement>('.df-reward-remove').forEach(btn => {
      btn.onclick = () => btn.closest('.df-reward-row')?.remove();
    });
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, modal: ModalHandle): Promise<void> {
    const existingId = (root.querySelector('#df-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#df-name') as HTMLInputElement).value.trim();
    if (!name) { alert('Name is required.'); return; }
    const id = existingId || crypto.randomUUID();
    const description = (root.querySelector('#df-description') as HTMLTextAreaElement).value.trim();

    const floors: DungeonFloor[] = [];
    root.querySelectorAll<HTMLElement>('.df-floor').forEach(floorEl => {
      const floorNumber = parseInt((floorEl.querySelector('.df-floor-number') as HTMLInputElement).value) || floors.length + 1;
      const cols = parseInt((floorEl.querySelector('.df-floor-cols') as HTMLInputElement).value) || 3;
      const rows = parseInt((floorEl.querySelector('.df-floor-rows') as HTMLInputElement).value) || 3;
      const isBoss = (floorEl.querySelector('.df-floor-boss') as HTMLInputElement).checked;
      const encounterTable: EncounterTableEntry[] = [];
      floorEl.querySelectorAll<HTMLElement>('.df-enc-row').forEach(row => {
        const encounterId = (row.querySelector('.df-enc-id') as HTMLSelectElement).value;
        const weight = parseInt((row.querySelector('.df-enc-weight') as HTMLInputElement).value) || 0;
        if (encounterId && weight > 0) encounterTable.push({ encounterId, weight });
      });
      const rewards: DungeonReward[] = [];
      floorEl.querySelectorAll<HTMLElement>('.df-reward-row').forEach(row => {
        const itemId = (row.querySelector('.df-reward-item') as HTMLSelectElement).value;
        const chance = parseFloat((row.querySelector('.df-reward-chance') as HTMLInputElement).value);
        const minQty = parseInt((row.querySelector('.df-reward-min') as HTMLInputElement).value) || 1;
        const maxQty = parseInt((row.querySelector('.df-reward-max') as HTMLInputElement).value) || 1;
        if (itemId && Number.isFinite(chance)) rewards.push({ itemId, chance, minQty, maxQty });
      });
      const floor: DungeonFloor = {
        floorNumber,
        gridShape: { cols, rows },
        encounterTable,
      };
      if (isBoss) floor.isBoss = true;
      if (rewards.length) floor.rewards = rewards;
      floors.push(floor);
    });

    const reqs: DungeonEntryRequirements = {};
    const minLevel = parseInt((root.querySelector('#df-req-min-level') as HTMLInputElement).value);
    const maxLevel = parseInt((root.querySelector('#df-req-max-level') as HTMLInputElement).value);
    const minParty = parseInt((root.querySelector('#df-req-min-party') as HTMLInputElement).value);
    const maxParty = parseInt((root.querySelector('#df-req-max-party') as HTMLInputElement).value);
    if (Number.isFinite(minLevel) && minLevel > 0) reqs.minLevel = minLevel;
    if (Number.isFinite(maxLevel) && maxLevel > 0) reqs.maxLevel = maxLevel;
    if (Number.isFinite(minParty) && minParty > 0) reqs.minPartySize = minParty;
    if (Number.isFinite(maxParty) && maxParty > 0) reqs.maxPartySize = maxParty;
    const requiredItemId = (root.querySelector('#df-req-item') as HTMLSelectElement).value;
    if (requiredItemId) {
      reqs.requiredItemId = requiredItemId;
      if ((root.querySelector('#df-req-consume') as HTMLInputElement).checked) {
        reqs.consumeRequiredItem = true;
      }
    }
    const requiredClasses: ClassName[] = [];
    root.querySelectorAll<HTMLInputElement>('.df-req-class').forEach(cb => {
      if (cb.checked) requiredClasses.push(cb.value as ClassName);
    });
    if (requiredClasses.length) reqs.requiredClasses = requiredClasses;

    const firstClearRewards: DungeonReward[] = [];
    root.querySelectorAll<HTMLElement>('#df-first-clear-list .df-reward-row').forEach(row => {
      const itemId = (row.querySelector('.df-reward-item') as HTMLSelectElement).value;
      const chance = parseFloat((row.querySelector('.df-reward-chance') as HTMLInputElement).value);
      const minQty = parseInt((row.querySelector('.df-reward-min') as HTMLInputElement).value) || 1;
      const maxQty = parseInt((row.querySelector('.df-reward-max') as HTMLInputElement).value) || 1;
      if (itemId && Number.isFinite(chance)) firstClearRewards.push({ itemId, chance, minQty, maxQty });
    });

    const dungeon: DungeonDefinition = { id, name, floors };
    if (description) dungeon.description = description;
    if (Object.keys(reqs).length) dungeon.entryRequirements = reqs;
    if (firstClearRewards.length) dungeon.firstClearRewards = firstClearRewards;

    try {
      const data = await putAdmin<{ dungeons: Record<string, DungeonDefinition> }>(
        `/api/admin/dungeons/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, dungeon);
      ctx.patchVersionContent({ dungeons: data.dungeons });
      modal.close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteDungeon(ctx: AdminContext, id: string): Promise<void> {
    const dungeon = (ctx.getDisplayContent()?.dungeons ?? {})[id];
    if (!dungeon) return;
    if (!confirm(`Delete dungeon "${dungeon.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ dungeons: Record<string, DungeonDefinition> }>(
        `/api/admin/dungeons/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ dungeons: data.dungeons });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
