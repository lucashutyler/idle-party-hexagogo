import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { MONSTER_SKILL_CATALOG } from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  ItemDefinition,
  Resistance,
  MonsterSkillEntry,
  DamageType,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class MonstersTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const monsters = Object.values(content.monsters);
    const items = content.items;
    const readOnly = ctx.isReadOnly();

    const rows = monsters.map(m => {
      const drops = m.drops?.map(d => {
        const item = items[d.itemId];
        return `${item?.name ?? d.itemId} (${(d.chance * 100).toFixed(3)}%)`;
      }).join(', ') ?? 'None';

      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm monster-edit-btn" data-id="${m.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger monster-delete-btn" data-id="${m.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${escapeHtml(m.name)}${m.passive ? ' <span class="admin-pill">passive</span>' : ''}</td>
          <td>${m.hp}</td>
          <td>${m.damage}</td>
          <td>${m.damageType}</td>
          <td>${m.xp}</td>
          <td>${m.goldMin}-${m.goldMax}</td>
          <td>${escapeHtml(drops)}</td>
          <td>${m.resistances?.length ?? 0} res, ${m.skills?.length ?? 0} skills</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="monster-add-btn">+ Add Monster</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Monsters <span class="admin-count-badge">${monsters.length}</span></h2>
          ${addBtn}
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>HP</th>
                <th>Dmg</th>
                <th>Type</th>
                <th>XP</th>
                <th>Gold</th>
                <th>Drops</th>
                <th>Mods</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#monster-add-btn')?.addEventListener('click', () => {
      this.openForm(null, ctx);
    });
    container.querySelectorAll<HTMLButtonElement>('.monster-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        const monster = ctx.getDisplayContent()?.monsters[id];
        if (monster) this.openForm(monster, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.monster-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.id!;
        this.deleteMonster(ctx, id);
      });
    });
  }

  private openForm(monster: MonsterDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !monster;
    const m: MonsterDefinition = monster ?? {
      id: '', name: '', hp: 10, damage: 3, damageType: 'physical',
      xp: 5, goldMin: 1, goldMax: 2, drops: [],
    };
    const items = Object.values(content.items);

    const dropRows = (m.drops ?? []).map((d, i) => this.dropRowHtml(i, d.itemId, d.chance, items)).join('');
    const resistanceRows = (m.resistances ?? []).map((r, i) => this.resistanceRowHtml(i, r)).join('');
    const skillRows = (m.skills ?? []).map((s, i) => this.skillRowHtml(i, s)).join('');

    const bodyHtml = `
      <input type="hidden" id="mf-id" value="${escapeHtml(m.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="mf-name" value="${escapeHtml(m.name)}"></label>
        <label>HP<input type="number" id="mf-hp" value="${m.hp}" min="1"></label>
        <label>Damage<input type="number" id="mf-damage" value="${m.damage}" min="0"></label>
        <label>Type
          <select id="mf-damageType">
            <option value="physical" ${m.damageType === 'physical' ? 'selected' : ''}>Physical</option>
            <option value="magical" ${m.damageType === 'magical' ? 'selected' : ''}>Magical</option>
          </select>
        </label>
        <label>XP<input type="number" id="mf-xp" value="${m.xp}" min="0"></label>
        <label>Gold Min<input type="number" id="mf-goldMin" value="${m.goldMin}" min="0"></label>
        <label>Gold Max<input type="number" id="mf-goldMax" value="${m.goldMax}" min="0"></label>
        <label class="admin-form-checkbox">
          <input type="checkbox" id="mf-passive" ${m.passive ? 'checked' : ''}>
          Passive (wall — never attacks, doesn't count toward victory)
        </label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Drops <button class="admin-btn admin-btn-sm" id="mf-add-drop" type="button">+ Drop</button></legend>
        <div id="mf-drops-list">${dropRows}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Resistances <button class="admin-btn admin-btn-sm" id="mf-add-resistance" type="button">+ Resistance</button></legend>
        <div id="mf-resistances-list">${resistanceRows}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Skills <button class="admin-btn admin-btn-sm" id="mf-add-skill" type="button">+ Skill</button></legend>
        <div id="mf-skills-list">${skillRows}</div>
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="mf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="mf-cancel" type="button">Cancel</button>
      </div>
    `;

    const modal = openModal({
      title: isNew ? 'Add Monster' : `Edit: ${m.name}`,
      bodyHtml,
      width: '720px',
    });
    const root = modal.body;

    root.querySelector('#mf-cancel')?.addEventListener('click', modal.close);

    root.querySelector('#mf-add-drop')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-drops-list');
      if (!list || items.length === 0) return;
      const index = list.querySelectorAll('.monster-drop-row').length;
      list.insertAdjacentHTML('beforeend', this.dropRowHtml(index, items[0].id, 0.1, items));
      this.wireRowRemovers(root, '.mf-drop-remove', '.monster-drop-row');
    });

    root.querySelector('#mf-add-resistance')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-resistances-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-resistance-row').length;
      list.insertAdjacentHTML('beforeend', this.resistanceRowHtml(index, {
        damageType: 'physical', flatReduction: 0, percentReduction: 0,
      }));
      this.wireRowRemovers(root, '.mf-res-remove', '.monster-resistance-row');
    });

    root.querySelector('#mf-add-skill')?.addEventListener('click', () => {
      const list = root.querySelector('#mf-skills-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-skill-row').length;
      const firstSkillId = Object.keys(MONSTER_SKILL_CATALOG)[0];
      const defaultCd = MONSTER_SKILL_CATALOG[firstSkillId]?.cooldown ?? 3;
      list.insertAdjacentHTML('beforeend', this.skillRowHtml(index, {
        skillId: firstSkillId, value: 1, cooldown: defaultCd,
      }));
      this.wireRowRemovers(root, '.mf-skill-remove', '.monster-skill-row');
    });

    this.wireRowRemovers(root, '.mf-drop-remove', '.monster-drop-row');
    this.wireRowRemovers(root, '.mf-res-remove', '.monster-resistance-row');
    this.wireRowRemovers(root, '.mf-skill-remove', '.monster-skill-row');

    root.querySelector('#mf-save')?.addEventListener('click', () => {
      this.saveForm(root, ctx, modal.close);
    });
  }

  private wireRowRemovers(root: HTMLElement, btnSel: string, rowSel: string): void {
    root.querySelectorAll<HTMLButtonElement>(btnSel).forEach(btn => {
      btn.onclick = () => btn.closest(rowSel)?.remove();
    });
  }

  private dropRowHtml(index: number, itemId: string, chance: number, items: ItemDefinition[]): string {
    const options = items.map(i =>
      `<option value="${i.id}" ${i.id === itemId ? 'selected' : ''}>${escapeHtml(i.name)}</option>`
    ).join('');
    const rateHint = chance > 0 ? `<span class="admin-form-hint">~${Math.round(1 / chance)} per kill</span>` : '';
    return `
      <div class="monster-drop-row admin-form-row" data-index="${index}">
        <select class="mf-drop-item">${options}</select>
        <input type="number" class="mf-drop-chance" value="${(chance * 100).toFixed(3)}" min="0.001" max="100" step="0.001">
        <span>%</span>
        ${rateHint}
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-drop-remove" type="button">×</button>
      </div>
    `;
  }

  private resistanceRowHtml(index: number, resistance: Resistance): string {
    return `
      <div class="monster-resistance-row admin-form-row" data-index="${index}">
        <select class="mf-res-type">
          <option value="physical" ${resistance.damageType === 'physical' ? 'selected' : ''}>Physical</option>
          <option value="magical" ${resistance.damageType === 'magical' ? 'selected' : ''}>Magical</option>
          <option value="holy" ${resistance.damageType === 'holy' ? 'selected' : ''}>Holy</option>
        </select>
        <label>Flat<input type="number" class="mf-res-flat" value="${resistance.flatReduction}" step="1"></label>
        <label>%<input type="number" class="mf-res-percent" value="${resistance.percentReduction}" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-res-remove" type="button">×</button>
      </div>
    `;
  }

  private skillRowHtml(index: number, entry: MonsterSkillEntry): string {
    const options = Object.values(MONSTER_SKILL_CATALOG).map(s =>
      `<option value="${s.id}" ${s.id === entry.skillId ? 'selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    const skillDef = MONSTER_SKILL_CATALOG[entry.skillId];
    const info = skillDef ? `${skillDef.targeting} / ${skillDef.effect}` : '';
    return `
      <div class="monster-skill-row admin-form-row" data-index="${index}">
        <select class="mf-skill-id">${options}</select>
        <label>Value<input type="number" class="mf-skill-value" value="${entry.value}" min="1"></label>
        <label>CD<input type="number" class="mf-skill-cd" value="${entry.cooldown}" min="1"></label>
        <span class="admin-form-hint">${escapeHtml(info)}</span>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-skill-remove" type="button">×</button>
      </div>
    `;
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#mf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#mf-name') as HTMLInputElement).value.trim();
    const hp = parseInt((root.querySelector('#mf-hp') as HTMLInputElement).value);
    const damage = parseInt((root.querySelector('#mf-damage') as HTMLInputElement).value);
    const damageType = (root.querySelector('#mf-damageType') as HTMLSelectElement).value as DamageType;
    const xp = parseInt((root.querySelector('#mf-xp') as HTMLInputElement).value);
    const goldMin = parseInt((root.querySelector('#mf-goldMin') as HTMLInputElement).value);
    const goldMax = parseInt((root.querySelector('#mf-goldMax') as HTMLInputElement).value);

    if (!name) { alert('Name is required.'); return; }

    const content = ctx.getDisplayContent();
    if (content) {
      const dup = Object.values(content.monsters).find(m => m.name === name && m.id !== existingId);
      if (dup) { alert(`A monster named "${name}" already exists.`); return; }
    }
    const id = existingId || crypto.randomUUID();

    const drops: { itemId: string; chance: number }[] = [];
    root.querySelectorAll('.monster-drop-row').forEach(row => {
      const itemId = (row.querySelector('.mf-drop-item') as HTMLSelectElement).value;
      const chance = parseFloat((row.querySelector('.mf-drop-chance') as HTMLInputElement).value) / 100;
      if (itemId && chance > 0) drops.push({ itemId, chance });
    });

    const resistances: Resistance[] = [];
    root.querySelectorAll('.monster-resistance-row').forEach(row => {
      const dt = (row.querySelector('.mf-res-type') as HTMLSelectElement).value as DamageType;
      const flatReduction = parseInt((row.querySelector('.mf-res-flat') as HTMLInputElement).value) || 0;
      const percentReduction = parseInt((row.querySelector('.mf-res-percent') as HTMLInputElement).value) || 0;
      resistances.push({ damageType: dt, flatReduction, percentReduction });
    });

    const skills: MonsterSkillEntry[] = [];
    root.querySelectorAll('.monster-skill-row').forEach(row => {
      const skillId = (row.querySelector('.mf-skill-id') as HTMLSelectElement).value;
      const value = parseInt((row.querySelector('.mf-skill-value') as HTMLInputElement).value) || 1;
      const cooldown = parseInt((row.querySelector('.mf-skill-cd') as HTMLInputElement).value) || 3;
      if (skillId) skills.push({ skillId, value, cooldown });
    });

    const passive = (root.querySelector('#mf-passive') as HTMLInputElement).checked;

    const monster: MonsterDefinition = {
      id, name, hp, damage, damageType, xp, goldMin, goldMax,
      drops: drops.length > 0 ? drops : undefined,
      resistances: resistances.length > 0 ? resistances : undefined,
      skills: skills.length > 0 ? skills : undefined,
      passive: passive ? true : undefined,
    };

    try {
      const data = await putAdmin<{ monsters: Record<string, MonsterDefinition> }>(
        `/api/admin/monsters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, monster);
      ctx.patchVersionContent({ monsters: data.monsters });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteMonster(ctx: AdminContext, id: string): Promise<void> {
    const monster = ctx.getDisplayContent()?.monsters[id];
    if (!monster) return;
    if (!confirm(`Delete monster "${monster.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ monsters: Record<string, MonsterDefinition> }>(
        `/api/admin/monsters/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ monsters: data.monsters });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
