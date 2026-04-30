import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import {
  ALL_CLASS_NAMES,
  getSetBonusText,
  getSetDisplayName,
  migrateLegacySet,
} from '@idle-party-rpg/shared';
import type { SetDefinition, SetBreakpoint, SetBonuses } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

export class SetsTab implements Tab {
  /** Working state for the set form's breakpoints — kept across re-renders inside one modal. */
  private setFormBreakpoints: SetBreakpoint[] = [];

  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const sets = Object.values(content.sets ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = sets.map(rawSet => {
      // Tolerate legacy snapshots — read through migrateLegacySet for display.
      const s = migrateLegacySet(rawSet);
      const bps = s.breakpoints ?? [];
      const summary = bps.length === 0
        ? '(no breakpoints)'
        : bps.map(bp => `${bp.piecesRequired}pc: ${getSetBonusText(bp.bonuses)}`).join(' · ');
      const classes = s.classRestriction && s.classRestriction.length > 0
        ? s.classRestriction.join(', ')
        : 'Any';
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm set-edit-btn" data-id="${s.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger set-delete-btn" data-id="${s.id}">Del</button>
        </td>
      `;
      return `
        <tr>
          <td>${escapeHtml(getSetDisplayName(s))}</td>
          <td>${escapeHtml(classes)}</td>
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
              <tr><th>Name</th><th>Classes</th><th>Items</th><th>Breakpoints</th>${actionsHeader}</tr>
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

  private openForm(rawSet: SetDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !rawSet;
    const s = rawSet ? migrateLegacySet(rawSet) : { id: '', name: '', itemIds: [], breakpoints: [] as SetBreakpoint[] };
    this.setFormBreakpoints = s.breakpoints.map(bp => ({
      piecesRequired: bp.piecesRequired,
      bonuses: { ...bp.bonuses },
    }));
    const items = Object.values(content.items)
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const existingItemIds = new Set(s.itemIds);
    const existingClasses = new Set(s.classRestriction ?? []);

    const itemCheckboxes = items.map(item =>
      `<label class="admin-checkbox">
        <input type="checkbox" class="sf-item-check" value="${item.id}" ${existingItemIds.has(item.id) ? 'checked' : ''}>
        ${escapeHtml(item.name)}
      </label>`
    ).join('');

    const classCheckboxes = ALL_CLASS_NAMES.map(cn =>
      `<label class="admin-checkbox">
        <input type="checkbox" class="sf-class-check" value="${cn}" ${existingClasses.has(cn) ? 'checked' : ''}>
        ${cn}
      </label>`
    ).join('');

    const bodyHtml = `
      <input type="hidden" id="sf-id" value="${escapeHtml(s.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="sf-name" value="${escapeHtml(s.name)}"></label>
      </div>
      <fieldset class="admin-form-fieldset">
        <legend>Class Restriction</legend>
        <div class="admin-form-hint">Leave all unchecked for "any class".</div>
        <div class="admin-checkbox-row">${classCheckboxes}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Items <span id="sf-item-count" class="admin-form-hint"></span></legend>
        <div class="admin-checklist">${itemCheckboxes}</div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Breakpoints <button class="admin-btn admin-btn-sm" id="sf-add-breakpoint" type="button">+ Add Breakpoint</button></legend>
        <div class="admin-form-hint">Each breakpoint unlocks at the listed piece count. Bonuses do NOT stack across tiers — the highest unlocked tier replaces lower ones.</div>
        <div id="sf-breakpoints-container"></div>
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

    const updateItemCount = () => {
      const checked = root.querySelectorAll('.sf-item-check:checked').length;
      const countEl = root.querySelector('#sf-item-count');
      if (countEl) countEl.textContent = `(${checked} selected)`;
    };
    updateItemCount();
    root.querySelectorAll<HTMLInputElement>('.sf-item-check').forEach(cb => {
      cb.addEventListener('change', updateItemCount);
    });

    root.querySelector('#sf-add-breakpoint')?.addEventListener('click', () => {
      this.captureBreakpoints(root);
      const totalItems = root.querySelectorAll<HTMLInputElement>('.sf-item-check:checked').length || 1;
      const lastBp = this.setFormBreakpoints[this.setFormBreakpoints.length - 1];
      const next = Math.min(totalItems, (lastBp?.piecesRequired ?? 0) + 1);
      this.setFormBreakpoints.push({ piecesRequired: Math.max(1, next), bonuses: {} });
      this.renderBreakpoints(root);
    });

    this.renderBreakpoints(root);
    root.querySelector('#sf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#sf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));
  }

  private renderBreakpoints(root: HTMLElement): void {
    const container = root.querySelector<HTMLElement>('#sf-breakpoints-container');
    if (!container) return;
    if (this.setFormBreakpoints.length === 0) {
      container.innerHTML = '<div class="admin-form-hint" style="padding:8px;">No breakpoints yet — click "Add Breakpoint" to create one.</div>';
      return;
    }
    container.innerHTML = this.setFormBreakpoints.map((bp, idx) => {
      const b = bp.bonuses;
      return `
        <div class="sf-breakpoint-row admin-form-fieldset" data-bp-idx="${idx}">
          <div class="sf-breakpoint-header">
            <label>Tier @ <input type="number" class="sf-bp-pieces" value="${bp.piecesRequired}" min="1"> piece(s)</label>
            <button class="admin-btn admin-btn-sm admin-btn-danger sf-bp-remove" type="button">Remove</button>
          </div>
          <div class="admin-form-grid">
            <label>CD Reduction<input type="number" class="sf-bp-cd" value="${b.cooldownReduction ?? 0}" min="0"></label>
            <label>Damage %<input type="number" class="sf-bp-dmgPct" value="${b.damagePercent ?? 0}" min="0"></label>
            <label>Dmg Resist %<input type="number" class="sf-bp-dmgResist" value="${b.damageResistancePercent ?? 0}" min="0"></label>
            <label>DR Min<input type="number" class="sf-bp-drMin" value="${b.damageReductionMin ?? 0}" min="0"></label>
            <label>DR Max<input type="number" class="sf-bp-drMax" value="${b.damageReductionMax ?? 0}" min="0"></label>
            <label>MR Min<input type="number" class="sf-bp-mrMin" value="${b.magicReductionMin ?? 0}" min="0"></label>
            <label>MR Max<input type="number" class="sf-bp-mrMax" value="${b.magicReductionMax ?? 0}" min="0"></label>
            <label>Atk Min<input type="number" class="sf-bp-atkMin" value="${b.bonusAttackMin ?? 0}" min="0"></label>
            <label>Atk Max<input type="number" class="sf-bp-atkMax" value="${b.bonusAttackMax ?? 0}" min="0"></label>
            <label>Flat HP<input type="number" class="sf-bp-flatHp" value="${b.flatHp ?? 0}" min="0"></label>
            <label>% HP<input type="number" class="sf-bp-pctHp" value="${b.percentHp ?? 0}" min="0"></label>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll<HTMLButtonElement>('.sf-bp-remove').forEach(btn => {
      btn.addEventListener('click', e => {
        const row = (e.currentTarget as HTMLElement).closest('.sf-breakpoint-row') as HTMLElement | null;
        if (!row) return;
        this.captureBreakpoints(root);
        const idx = parseInt(row.dataset.bpIdx ?? '-1', 10);
        if (idx >= 0) {
          this.setFormBreakpoints.splice(idx, 1);
          this.renderBreakpoints(root);
        }
      });
    });
  }

  private captureBreakpoints(root: HTMLElement): void {
    const rows = root.querySelectorAll<HTMLElement>('.sf-breakpoint-row');
    const captured: SetBreakpoint[] = [];
    rows.forEach(row => {
      const piecesRequired = parseInt((row.querySelector('.sf-bp-pieces') as HTMLInputElement).value, 10) || 1;
      const num = (sel: string) => parseInt((row.querySelector(sel) as HTMLInputElement)?.value || '0', 10) || 0;
      const bonuses: SetBonuses = {};
      const cd = num('.sf-bp-cd'); if (cd) bonuses.cooldownReduction = cd;
      const dmgPct = num('.sf-bp-dmgPct'); if (dmgPct) bonuses.damagePercent = dmgPct;
      const dmgResist = num('.sf-bp-dmgResist'); if (dmgResist) bonuses.damageResistancePercent = dmgResist;
      const drMin = num('.sf-bp-drMin'); const drMax = num('.sf-bp-drMax');
      if (drMin || drMax) { bonuses.damageReductionMin = drMin; bonuses.damageReductionMax = drMax; }
      const mrMin = num('.sf-bp-mrMin'); const mrMax = num('.sf-bp-mrMax');
      if (mrMin || mrMax) { bonuses.magicReductionMin = mrMin; bonuses.magicReductionMax = mrMax; }
      const atkMin = num('.sf-bp-atkMin'); const atkMax = num('.sf-bp-atkMax');
      if (atkMin || atkMax) { bonuses.bonusAttackMin = atkMin; bonuses.bonusAttackMax = atkMax; }
      const flatHp = num('.sf-bp-flatHp'); if (flatHp) bonuses.flatHp = flatHp;
      const pctHp = num('.sf-bp-pctHp'); if (pctHp) bonuses.percentHp = pctHp;
      captured.push({ piecesRequired, bonuses });
    });
    this.setFormBreakpoints = captured;
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

    const classRestriction: string[] = [];
    root.querySelectorAll<HTMLInputElement>('.sf-class-check').forEach(cb => {
      if (cb.checked) classRestriction.push(cb.value);
    });

    this.captureBreakpoints(root);
    const breakpoints = this.setFormBreakpoints.map(bp => ({
      piecesRequired: bp.piecesRequired,
      bonuses: { ...bp.bonuses },
    }));
    if (breakpoints.length === 0) {
      alert('At least one breakpoint is required.');
      return;
    }
    for (const bp of breakpoints) {
      if (bp.piecesRequired < 1 || bp.piecesRequired > Math.max(itemIds.length, 1)) {
        alert(`Breakpoint piece count ${bp.piecesRequired} is out of range (1..${itemIds.length}).`);
        return;
      }
    }
    breakpoints.sort((a, b) => a.piecesRequired - b.piecesRequired);

    const setDef: SetDefinition = {
      id,
      name,
      itemIds,
      breakpoints,
      ...(classRestriction.length > 0 ? { classRestriction } : {}),
    };

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
