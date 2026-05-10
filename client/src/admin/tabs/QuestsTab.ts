import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type {
  QuestDefinition,
  QuestObjective,
  QuestReward,
  QuestScope,
  QuestRepeat,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class QuestsTab implements Tab {
  /** Mutable working draft inside the modal — replaced on each open. */
  private working: QuestDefinition | null = null;

  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const quests = Object.values(content.quests ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = quests.map(q => {
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm quest-edit-btn" data-id="${q.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger quest-delete-btn" data-id="${q.id}">Del</button>
        </td>
      `;
      const objectiveSummary = q.objectives.map(o => {
        if (o.kind === 'kill') return `kill ${o.count}× ${o.monsterId}`;
        if (o.kind === 'collect') return `collect ${o.count}× ${o.itemId}`;
        return `visit ${o.tileId}`;
      }).join(', ');
      const rewardSummary = q.rewards.map(r => {
        if (r.kind === 'xp') return `${r.amount} XP`;
        if (r.kind === 'gold') return `${r.amount}g`;
        return `${r.quantity}× ${r.itemId}`;
      }).join(', ');
      return `<tr>
        <td>${escapeHtml(q.name)}</td>
        <td>${q.scope}</td>
        <td>${escapeHtml(objectiveSummary)}</td>
        <td>${escapeHtml(rewardSummary)}</td>
        <td>${q.repeat ?? 'once'}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="quest-add-btn">+ Add Quest</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Quests <span class="admin-count-badge">${quests.length}</span></h2>
          ${addBtn}
        </div>
        <p class="admin-form-hint">Quests are offered by NPCs. Assign quests to an NPC from the NPCs tab.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Name</th><th>Scope</th><th>Objectives</th><th>Rewards</th><th>Repeat</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#quest-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.quest-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const quest = (ctx.getDisplayContent()?.quests ?? {})[btn.dataset.id!];
        if (quest) this.openForm(quest, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.quest-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteQuest(ctx, btn.dataset.id!));
    });
  }

  private openForm(quest: QuestDefinition | null, ctx: AdminContext): void {
    const isNew = !quest;
    const content = ctx.getDisplayContent();
    if (!content) return;
    this.working = quest
      ? JSON.parse(JSON.stringify(quest))
      : {
          id: '',
          name: '',
          description: '',
          scope: 'party_shared' as QuestScope,
          objectives: [],
          rewards: [],
          repeat: 'once' as QuestRepeat,
        };

    const modal = openModal({
      title: isNew ? 'Add Quest' : `Edit: ${quest!.name}`,
      bodyHtml: '<div id="quest-form-body"></div>',
      width: '720px',
    });
    const root = modal.body;

    this.renderForm(root, ctx);

    root.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      if (target.id === 'qf-save') this.saveForm(ctx, modal.close);
      else if (target.id === 'qf-cancel') modal.close();
      else if (target.classList.contains('qf-add-objective')) this.addObjective(target.dataset.kind as QuestObjective['kind'], root, ctx);
      else if (target.classList.contains('qf-add-reward')) this.addReward(target.dataset.kind as QuestReward['kind'], root, ctx);
      else if (target.classList.contains('qf-remove-objective')) {
        const idx = parseInt(target.dataset.idx ?? '-1', 10);
        if (idx >= 0 && this.working) {
          this.working.objectives.splice(idx, 1);
          this.renderForm(root, ctx);
        }
      } else if (target.classList.contains('qf-remove-reward')) {
        const idx = parseInt(target.dataset.idx ?? '-1', 10);
        if (idx >= 0 && this.working) {
          this.working.rewards.splice(idx, 1);
          this.renderForm(root, ctx);
        }
      }
    });

    root.addEventListener('input', (e) => this.handleFieldInput(e, ctx));
    root.addEventListener('change', (e) => this.handleFieldInput(e, ctx));
  }

  private renderForm(root: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    const w = this.working;
    if (!content || !w) return;

    const monsterOpts = Object.values(content.monsters).map(m =>
      `<option value="${escapeHtml(m.id)}">${escapeHtml(m.name)}</option>`).join('');
    const itemOpts = Object.values(content.items).map(i =>
      `<option value="${escapeHtml(i.id)}">${escapeHtml(i.name)}</option>`).join('');
    const tileOpts = content.world.tiles.map(t =>
      `<option value="${escapeHtml(t.id)}">${escapeHtml(t.name)} (${t.col},${t.row})</option>`).join('');
    const objectiveRows = w.objectives.map((obj, i) => {
      let body = '';
      if (obj.kind === 'kill') {
        body = `
          <select class="qf-obj-monster" data-idx="${i}"><option value="">(monster…)</option>${monsterOpts.replace(`value="${obj.monsterId}"`, `value="${obj.monsterId}" selected`)}</select>
          <label>Count <input type="number" class="qf-obj-count" data-idx="${i}" min="1" value="${obj.count}"></label>
        `;
      } else if (obj.kind === 'collect') {
        body = `
          <select class="qf-obj-item" data-idx="${i}"><option value="">(item…)</option>${itemOpts.replace(`value="${obj.itemId}"`, `value="${obj.itemId}" selected`)}</select>
          <label>Count <input type="number" class="qf-obj-count" data-idx="${i}" min="1" value="${obj.count}"></label>
        `;
      } else {
        body = `
          <select class="qf-obj-tile" data-idx="${i}"><option value="">(room…)</option>${tileOpts.replace(`value="${obj.tileId}"`, `value="${obj.tileId}" selected`)}</select>
        `;
      }
      return `
        <div class="admin-form-row">
          <span class="admin-form-coords">${obj.kind}</span>
          ${body}
          <button class="admin-btn admin-btn-sm admin-btn-danger qf-remove-objective" data-idx="${i}" type="button">×</button>
        </div>
      `;
    }).join('');

    const rewardRows = w.rewards.map((r, i) => {
      let body = '';
      if (r.kind === 'xp') {
        body = `<label>XP <input type="number" class="qf-rwd-amount" data-idx="${i}" min="0" value="${r.amount}"></label>`;
      } else if (r.kind === 'gold') {
        body = `<label>Gold <input type="number" class="qf-rwd-amount" data-idx="${i}" min="0" value="${r.amount}"></label>`;
      } else {
        body = `
          <select class="qf-rwd-item" data-idx="${i}"><option value="">(item…)</option>${itemOpts.replace(`value="${r.itemId}"`, `value="${r.itemId}" selected`)}</select>
          <label>Qty <input type="number" class="qf-rwd-qty" data-idx="${i}" min="1" value="${r.quantity}"></label>
        `;
      }
      return `
        <div class="admin-form-row">
          <span class="admin-form-coords">${r.kind}</span>
          ${body}
          <button class="admin-btn admin-btn-sm admin-btn-danger qf-remove-reward" data-idx="${i}" type="button">×</button>
        </div>
      `;
    }).join('');

    const prereqIds = new Set(w.prerequisiteQuestIds ?? []);
    const prereqHtml = Object.values(content.quests ?? {})
      .filter(q => q.id !== w.id)
      .map(q => `
        <label class="admin-checkbox">
          <input type="checkbox" class="qf-prereq" value="${escapeHtml(q.id)}" ${prereqIds.has(q.id) ? 'checked' : ''}>
          ${escapeHtml(q.name)}
        </label>
      `).join('');

    root.innerHTML = `
      <div id="quest-form-body">
        <div class="admin-form-grid">
          <label>Name <input type="text" id="qf-name" value="${escapeHtml(w.name)}"></label>
          <label>Scope
            <select id="qf-scope">
              <option value="party_shared" ${w.scope === 'party_shared' ? 'selected' : ''}>Party shared</option>
              <option value="solo" ${w.scope === 'solo' ? 'selected' : ''}>Solo</option>
            </select>
          </label>
          <label>Required Level <input type="number" id="qf-required-level" min="1" value="${w.requiredLevel ?? ''}" placeholder="(any)"></label>
          <label>Repeat
            <select id="qf-repeat">
              <option value="once" ${(w.repeat ?? 'once') === 'once' ? 'selected' : ''}>Once</option>
              <option value="weekly" ${w.repeat === 'weekly' ? 'selected' : ''}>Weekly</option>
            </select>
          </label>
        </div>
        <label>Description
          <textarea id="qf-description" rows="3">${escapeHtml(w.description)}</textarea>
        </label>
        <fieldset class="admin-form-fieldset">
          <legend>Objectives</legend>
          ${objectiveRows || '<div class="admin-form-hint">No objectives yet.</div>'}
          <div class="admin-form-row">
            <button class="admin-btn admin-btn-sm qf-add-objective" data-kind="kill" type="button">+ Kill</button>
            <button class="admin-btn admin-btn-sm qf-add-objective" data-kind="collect" type="button">+ Collect</button>
            <button class="admin-btn admin-btn-sm qf-add-objective" data-kind="visit" type="button">+ Visit</button>
          </div>
        </fieldset>
        <fieldset class="admin-form-fieldset">
          <legend>Rewards</legend>
          ${rewardRows || '<div class="admin-form-hint">No rewards yet.</div>'}
          <div class="admin-form-row">
            <button class="admin-btn admin-btn-sm qf-add-reward" data-kind="xp" type="button">+ XP</button>
            <button class="admin-btn admin-btn-sm qf-add-reward" data-kind="gold" type="button">+ Gold</button>
            <button class="admin-btn admin-btn-sm qf-add-reward" data-kind="item" type="button">+ Item</button>
          </div>
        </fieldset>
        <fieldset class="admin-form-fieldset">
          <legend>Prerequisite Quests</legend>
          ${prereqHtml || '<div class="admin-form-hint">(no other quests yet)</div>'}
        </fieldset>
        <div class="admin-modal-actions">
          <button class="admin-btn" id="qf-save" type="button">Save</button>
          <button class="admin-btn admin-btn-secondary" id="qf-cancel" type="button">Cancel</button>
        </div>
      </div>
    `;
  }

  private addObjective(kind: QuestObjective['kind'], root: HTMLElement, ctx: AdminContext): void {
    if (!this.working) return;
    if (kind === 'kill') this.working.objectives.push({ kind: 'kill', monsterId: '', count: 1 });
    else if (kind === 'collect') this.working.objectives.push({ kind: 'collect', itemId: '', count: 1 });
    else this.working.objectives.push({ kind: 'visit', tileId: '' });
    this.renderForm(root, ctx);
  }

  private addReward(kind: QuestReward['kind'], root: HTMLElement, ctx: AdminContext): void {
    if (!this.working) return;
    if (kind === 'xp') this.working.rewards.push({ kind: 'xp', amount: 100 });
    else if (kind === 'gold') this.working.rewards.push({ kind: 'gold', amount: 50 });
    else this.working.rewards.push({ kind: 'item', itemId: '', quantity: 1 });
    this.renderForm(root, ctx);
  }

  private handleFieldInput(e: Event, _ctx: AdminContext): void {
    if (!this.working) return;
    const target = e.target as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

    if (target.id === 'qf-name') this.working.name = target.value;
    else if (target.id === 'qf-description') this.working.description = target.value;
    else if (target.id === 'qf-scope') this.working.scope = target.value as QuestScope;
    else if (target.id === 'qf-repeat') this.working.repeat = target.value as QuestRepeat;
    else if (target.id === 'qf-required-level') {
      const v = parseInt(target.value, 10);
      this.working.requiredLevel = isNaN(v) || v <= 0 ? undefined : v;
    } else if (target.classList.contains('qf-prereq')) {
      const checkbox = target as HTMLInputElement;
      const ids = new Set(this.working.prerequisiteQuestIds ?? []);
      if (checkbox.checked) ids.add(checkbox.value);
      else ids.delete(checkbox.value);
      this.working.prerequisiteQuestIds = ids.size > 0 ? Array.from(ids) : undefined;
    } else if (target.classList.contains('qf-obj-monster')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const obj = this.working.objectives[idx];
      if (obj?.kind === 'kill') obj.monsterId = target.value;
    } else if (target.classList.contains('qf-obj-item')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const obj = this.working.objectives[idx];
      if (obj?.kind === 'collect') obj.itemId = target.value;
    } else if (target.classList.contains('qf-obj-tile')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const obj = this.working.objectives[idx];
      if (obj?.kind === 'visit') obj.tileId = target.value;
    } else if (target.classList.contains('qf-obj-count')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const obj = this.working.objectives[idx];
      if (obj && (obj.kind === 'kill' || obj.kind === 'collect')) obj.count = Math.max(1, parseInt(target.value, 10) || 1);
    } else if (target.classList.contains('qf-rwd-amount')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const r = this.working.rewards[idx];
      if (r && (r.kind === 'xp' || r.kind === 'gold')) r.amount = Math.max(0, parseInt(target.value, 10) || 0);
    } else if (target.classList.contains('qf-rwd-item')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const r = this.working.rewards[idx];
      if (r?.kind === 'item') r.itemId = target.value;
    } else if (target.classList.contains('qf-rwd-qty')) {
      const idx = parseInt(target.dataset.idx ?? '-1', 10);
      const r = this.working.rewards[idx];
      if (r?.kind === 'item') r.quantity = Math.max(1, parseInt(target.value, 10) || 1);
    }
  }

  private async saveForm(ctx: AdminContext, close: () => void): Promise<void> {
    const w = this.working;
    if (!w) return;
    if (!w.name.trim()) { alert('Name is required.'); return; }
    if (w.objectives.length === 0) { alert('At least one objective is required.'); return; }
    for (const o of w.objectives) {
      if (o.kind === 'kill' && !o.monsterId) { alert('Each kill objective needs a monster.'); return; }
      if (o.kind === 'collect' && !o.itemId) { alert('Each collect objective needs an item.'); return; }
      if (o.kind === 'visit' && !o.tileId) { alert('Each visit objective needs a room.'); return; }
    }
    for (const r of w.rewards) {
      if (r.kind === 'item' && !r.itemId) { alert('Each item reward needs an item.'); return; }
    }
    const id = w.id || crypto.randomUUID();
    const payload: QuestDefinition = { ...w, id };

    try {
      const data = await putAdmin<{ quests: Record<string, QuestDefinition> }>(
        `/api/admin/quests/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, payload);
      ctx.patchVersionContent({ quests: data.quests });
      close();
      this.working = null;
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteQuest(ctx: AdminContext, id: string): Promise<void> {
    const quest = (ctx.getDisplayContent()?.quests ?? {})[id];
    if (!quest) return;
    if (!confirm(`Delete quest "${quest.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ quests: Record<string, QuestDefinition> }>(
        `/api/admin/quests/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ quests: data.quests });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
