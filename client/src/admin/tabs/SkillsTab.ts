import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import {
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
  SKILL_CONDITION_VALUES,
  SKILL_OPTION_CATALOG,
  getSlotSchedule,
  validateSkillDefinition,
} from '@idle-party-rpg/shared';
import type {
  ActiveEffect,
  ClassName,
  PassiveEffect,
  SkillContent,
  SkillDefinition,
  SkillOptionDefinition,
  SkillOptionParamSpec,
  SkillSlot,
  SkillSlotType,
} from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, postAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

/**
 * Draft-aware CRUD editor for skills-as-content (issue #267): per-class skill
 * tables rendered from the displayed content snapshot, a skill modal composing
 * effect "options" from SKILL_OPTION_CATALOG, per-class slot-schedule editing,
 * and a seed-restore action. Follows the MonstersTab lifecycle
 * (list → openModal form → saveForm → delete) with draft gating.
 */
export class SkillsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const skills = Object.values(content.skills ?? {});
    const readOnly = ctx.isReadOnly();

    const nav = ALL_CLASS_NAMES
      .map(c => `<button class="admin-btn admin-btn-sm" data-skills-jump="${c}">${c}</button>`)
      .join('');
    const sections = ALL_CLASS_NAMES
      .map(c => this.renderClassSection(c, skills, this.skillContentOf(ctx), readOnly))
      .join('');

    const toolbar = readOnly ? '' : `
      <div class="skills-header-actions">
        <button class="admin-btn" id="skill-add-btn">+ Add Skill</button>
        <button class="admin-btn admin-btn-secondary" id="skill-restore-btn">Restore default skills</button>
      </div>`;

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Skills <span class="admin-count-badge">${skills.length}</span></h2>
          ${toolbar}
        </div>
        <p class="admin-page-subtitle">
          Skills are versioned content: each is composed of one or more effect options from the catalog.
          Players learn class skills at their unlock level; grant-only skills come from items/sets.
          Actives trigger every Nth attack (CD column).
        </p>
        <div class="skills-class-nav">${nav}</div>
        ${sections}
      </div>
    `;

    container.querySelectorAll<HTMLButtonElement>('[data-skills-jump]').forEach(btn => {
      btn.addEventListener('click', () => {
        container
          .querySelector(`[data-skills-class="${btn.dataset.skillsJump}"]`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    container.querySelector('#skill-add-btn')?.addEventListener('click', () => {
      this.openForm(null, ctx);
    });
    container.querySelector('#skill-restore-btn')?.addEventListener('click', () => {
      this.restoreDefaults(ctx);
    });
    container.querySelectorAll<HTMLButtonElement>('.skill-edit-btn, .skill-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const skill = (ctx.getDisplayContent()?.skills ?? {})[btn.dataset.id!];
        if (skill) this.openForm(skill, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.skill-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteSkill(ctx, btn.dataset.id!));
    });
    container.querySelectorAll<HTMLButtonElement>('.skill-slots-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        this.openSlotsForm(btn.dataset.class as ClassName, ctx);
      });
    });
  }

  // ---- List rendering ----

  private skillContentOf(ctx: AdminContext): SkillContent {
    const content = ctx.getDisplayContent();
    return {
      skills: content?.skills ?? {},
      slotSchedules: content?.skillSlotSchedules ?? {},
    };
  }

  private renderClassSection(
    className: ClassName,
    allSkills: SkillDefinition[],
    skillContent: SkillContent,
    readOnly: boolean,
  ): string {
    const def = CLASS_DEFINITIONS[className];
    const classSkills = allSkills
      .filter(s => s.className === className)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const passives = classSkills.filter(s => s.type === 'passive').length;
    const actives = classSkills.length - passives;
    // Default starting skill: the level-1 passive (tie: lowest sortOrder), matching
    // createDefaultSkillLoadout — a class with no level-1 passive starts with none equipped.
    const startId = classSkills
      .filter(s => s.type === 'passive' && s.unlockLevel !== null && s.unlockLevel <= 1)
      .sort((a, b) => (a.unlockLevel! - b.unlockLevel!) || (a.sortOrder - b.sortOrder))[0]?.id;
    const rows = classSkills.map(s => this.renderSkillRow(s, s.id === startId, readOnly)).join('');

    const schedule = getSlotSchedule(className, skillContent);
    const slotSummary = schedule
      .map(s => `${s.type === 'passive' ? 'Passive' : 'Active'} Lv${s.unlocksAtLevel}`)
      .join(' · ');

    return `
      <div class="admin-page-section" data-skills-class="${className}">
        <div class="skills-section-head">
          <h3>
            ${escapeHtml(def.displayName)}
            <span class="admin-pill admin-pill-${def.damageType}">${def.damageType}</span>
            <span class="admin-count-badge">${passives} passives &middot; ${actives} actives</span>
          </h3>
          <button class="admin-btn admin-btn-sm skill-slots-btn" data-class="${className}">
            ${readOnly ? 'View Slots' : 'Edit Slots'}
          </button>
        </div>
        <p class="skills-class-desc">
          ${escapeHtml(def.description)}
          &mdash; Slots: ${escapeHtml(slotSummary || 'none')}
        </p>
        <div class="admin-table-wrap">
          <table class="admin-table skills-table">
            <thead>
              <tr>
                <th>Lv</th>
                <th>Type</th>
                <th>Skill</th>
                <th>Description</th>
                <th>Options</th>
                <th>CD</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderSkillRow(skill: SkillDefinition, isStart: boolean, readOnly: boolean): string {
    const unlockCell = skill.unlockLevel === null
      ? '<span class="admin-pill admin-pill-grant">grant-only</span>'
      : String(skill.unlockLevel);
    const startPill = isStart ? ' <span class="admin-pill admin-pill-start">start</span>' : '';
    const typeLabel = skill.type === 'passive' ? 'Passive' : 'Active';
    const cooldown = skill.type === 'active' && skill.cooldown != null
      ? `every ${skill.cooldown}`
      : '&mdash;';
    const options = [...(skill.passiveEffects ?? []), ...(skill.activeEffects ?? [])];
    const optionsHtml = options.length > 0
      ? options.map(e => this.renderEffect(e)).join('')
      : '&mdash;';
    const actions = readOnly
      ? `<button class="admin-btn admin-btn-sm skill-view-btn" data-id="${escapeHtml(skill.id)}">View</button>`
      : `<button class="admin-btn admin-btn-sm skill-edit-btn" data-id="${escapeHtml(skill.id)}">Edit</button>
         <button class="admin-btn admin-btn-sm admin-btn-danger skill-delete-btn" data-id="${escapeHtml(skill.id)}">Del</button>`;

    return `
      <tr>
        <td>${unlockCell}</td>
        <td><span class="admin-pill admin-pill-${skill.type}">${typeLabel}</span></td>
        <td>
          <div>${escapeHtml(skill.name)}${startPill}</div>
          <div class="skills-id admin-muted">${escapeHtml(skill.id)}</div>
        </td>
        <td>${escapeHtml(skill.description)}</td>
        <td>${optionsHtml}</td>
        <td>${cooldown}</td>
        <td class="admin-actions-cell">${actions}</td>
      </tr>
    `;
  }

  private renderEffect(effect: PassiveEffect | ActiveEffect): string {
    const paramSpecs = new Map((SKILL_OPTION_CATALOG[effect.kind]?.params ?? []).map(p => [p.key, p]));
    const params = Object.entries(effect)
      .filter(([key, value]) => key !== 'kind' && value !== undefined)
      .map(([key, value]) =>
        `<span class="skills-param">${escapeHtml(key)}: ${escapeHtml(formatParamValue(value, paramSpecs.get(key)))}</span>`)
      .join('');
    return `
      <div class="skills-option-summary">
        <code class="skills-effect-kind">${escapeHtml(effect.kind)}</code>
        ${params ? `<div class="skills-params">${params}</div>` : ''}
      </div>
    `;
  }

  // ---- Skill modal ----

  private openForm(skill: SkillDefinition | null, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;

    const isNew = !skill;
    const readOnly = ctx.isReadOnly();
    const s: SkillDefinition = skill ?? {
      id: '', name: '', description: '',
      className: ALL_CLASS_NAMES[0], type: 'passive',
      unlockLevel: 1, sortOrder: 0,
    };
    const grantOnly = s.unlockLevel === null;

    const classOptions = ALL_CLASS_NAMES.map(c =>
      `<option value="${c}" ${s.className === c ? 'selected' : ''}>${c}</option>`
    ).join('');
    const typeOptions = (['passive', 'active'] as SkillSlotType[]).map(t =>
      `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`
    ).join('');

    const optionRows = [...(s.passiveEffects ?? []), ...(s.activeEffects ?? [])]
      .map(e => this.optionRowHtml(e)).join('');
    const pickerRows = Object.values(SKILL_OPTION_CATALOG)
      .map(opt => this.pickerRowHtml(opt)).join('');

    const bodyHtml = `
      <input type="hidden" id="skf-id" value="${escapeHtml(s.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="skf-name" value="${escapeHtml(s.name)}"></label>
        <label>Class<select id="skf-class">${classOptions}</select></label>
        <label>Type<select id="skf-type">${typeOptions}</select></label>
        <label>Learned at level
          <input type="number" id="skf-unlockLevel" value="${s.unlockLevel ?? 1}" min="1" max="100" step="1" ${grantOnly ? 'disabled' : ''}>
        </label>
        <label class="admin-form-checkbox">
          <input type="checkbox" id="skf-grantOnly" ${grantOnly ? 'checked' : ''}>
          Grant-only (item/set) — never learned by level
        </label>
        <label>Sort order<input type="number" id="skf-sortOrder" value="${s.sortOrder}" step="1"></label>
        <label id="skf-cooldown-wrap" ${s.type === 'active' ? '' : 'style="display:none"'}>
          Cooldown (triggers every Nth attack)
          <input type="number" id="skf-cooldown" value="${s.cooldown ?? 2}" min="1" step="1">
        </label>
      </div>
      <label class="admin-form-fullrow">Description
        <textarea id="skf-description" rows="3">${escapeHtml(s.description)}</textarea>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Options ${readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="skf-add-option" type="button">+ Add option</button>'}</legend>
        <div class="skills-option-picker" id="skf-option-picker" hidden>
          <div class="admin-checklist-toolbar">
            <input type="search" id="skf-option-search" placeholder="Search options (label, kind, description, example)…" autocomplete="off">
            <span id="skf-option-count" class="admin-form-hint"></span>
          </div>
          <div class="admin-checklist admin-checklist-tall" id="skf-option-list">${pickerRows}</div>
        </div>
        <div id="skf-options-list">${optionRows}</div>
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="skf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="skf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="skf-cancel" type="button">Cancel</button>
        </div>`;
    const wrappedBody = readOnly
      ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}`
      : `${bodyHtml}${actionsHtml}`;
    const titlePrefix = isNew ? 'Add' : (readOnly ? 'View' : 'Edit');
    const modal = openModal({
      title: isNew ? 'Add Skill' : `${titlePrefix}: ${escapeHtml(s.name)}`,
      bodyHtml: wrappedBody,
      width: '760px',
    });
    const root = modal.body;

    root.querySelector('#skf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#skf-save')?.addEventListener('click', () => {
      this.saveForm(root, ctx, modal.close);
    });

    // Grant-only checkbox disables the unlock-level input.
    const grantCheck = root.querySelector<HTMLInputElement>('#skf-grantOnly');
    const levelInput = root.querySelector<HTMLInputElement>('#skf-unlockLevel');
    grantCheck?.addEventListener('change', () => {
      if (levelInput) levelInput.disabled = grantCheck.checked;
    });

    // Type select toggles the cooldown field and re-filters the picker.
    const typeSelect = root.querySelector<HTMLSelectElement>('#skf-type');
    typeSelect?.addEventListener('change', () => {
      const wrap = root.querySelector<HTMLElement>('#skf-cooldown-wrap');
      if (wrap) wrap.style.display = typeSelect.value === 'active' ? '' : 'none';
      this.applyPickerFilter(root);
    });

    // Option picker: toggle + search filter.
    const picker = root.querySelector<HTMLElement>('#skf-option-picker');
    root.querySelector('#skf-add-option')?.addEventListener('click', () => {
      if (!picker) return;
      picker.hidden = !picker.hidden;
      if (!picker.hidden) {
        this.applyPickerFilter(root);
        root.querySelector<HTMLInputElement>('#skf-option-search')?.focus();
      }
    });
    root.querySelector('#skf-option-search')?.addEventListener('input', () => {
      this.applyPickerFilter(root);
    });
    root.querySelectorAll<HTMLButtonElement>('.skills-option-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        const opt = SKILL_OPTION_CATALOG[btn.dataset.kind!];
        if (!opt) return;
        root.querySelector('#skf-options-list')
          ?.insertAdjacentHTML('beforeend', this.optionRowHtml(this.defaultEffect(opt)));
        this.wireRowRemovers(root, '.skf-option-remove', '.skills-option-row');
        if (picker) picker.hidden = true;
        const search = root.querySelector<HTMLInputElement>('#skf-option-search');
        if (search) search.value = '';
      });
    });

    this.wireRowRemovers(root, '.skf-option-remove', '.skills-option-row');
  }

  private pickerRowHtml(opt: SkillOptionDefinition): string {
    const haystack = `${opt.label} ${opt.kind} ${opt.description} ${opt.seedExample}`.toLowerCase();
    return `
      <button type="button" class="skills-option-pick" data-kind="${escapeHtml(opt.kind)}"
              data-slot-type="${opt.slotType}" data-search="${escapeHtml(haystack)}">
        <span class="skills-option-label">${escapeHtml(opt.label)}</span>
        <span class="admin-pill admin-pill-${opt.slotType}">${opt.slotType}</span>
        <code class="skills-effect-kind">${escapeHtml(opt.kind)}</code>
        <span class="admin-form-hint">${escapeHtml(opt.targeting)}</span>
        <div class="skills-option-desc admin-form-hint">${escapeHtml(opt.description)} <em>e.g. ${escapeHtml(opt.seedExample)}</em></div>
      </button>
    `;
  }

  /** Show only catalog entries legal for the skill's current type, matching the search query. */
  private applyPickerFilter(root: HTMLElement): void {
    const type = root.querySelector<HTMLSelectElement>('#skf-type')?.value ?? 'passive';
    const q = (root.querySelector<HTMLInputElement>('#skf-option-search')?.value ?? '').trim().toLowerCase();
    let shown = 0;
    let total = 0;
    root.querySelectorAll<HTMLElement>('.skills-option-pick').forEach(row => {
      // Passive kinds fit both skill types; active kinds only fit active skills.
      const legal = row.dataset.slotType === 'passive' || type === 'active';
      const matches = !q || (row.dataset.search ?? '').includes(q);
      const visible = legal && matches;
      row.style.display = visible ? '' : 'none';
      if (legal) total++;
      if (visible) shown++;
    });
    const countEl = root.querySelector<HTMLElement>('#skf-option-count');
    if (countEl) countEl.textContent = shown === total ? `${total} options` : `${shown} of ${total}`;
  }

  /** A fresh effect for a picked catalog entry: required params get in-range defaults. */
  private defaultEffect(opt: SkillOptionDefinition): PassiveEffect | ActiveEffect {
    const effect: Record<string, unknown> = { kind: opt.kind };
    for (const spec of opt.params) {
      if (!spec.required) continue;
      if (spec.input === 'number' || spec.input === 'percent') effect[spec.key] = spec.min ?? 0;
      else if (spec.input === 'boolean') effect[spec.key] = false;
      else if (spec.input === 'class') effect[spec.key] = ALL_CLASS_NAMES[0];
      else if (spec.input === 'condition') effect[spec.key] = SKILL_CONDITION_VALUES[0];
    }
    return effect as unknown as PassiveEffect | ActiveEffect;
  }

  private optionRowHtml(effect: PassiveEffect | ActiveEffect): string {
    const opt = SKILL_OPTION_CATALOG[effect.kind];
    if (!opt) {
      return `
        <div class="skills-option-row" data-kind="${escapeHtml(effect.kind)}">
          <div class="skills-option-head">
            <span class="skills-option-label">Unknown option</span>
            <code class="skills-effect-kind">${escapeHtml(effect.kind)}</code>
            <button class="admin-btn admin-btn-sm admin-btn-danger skf-option-remove" type="button">×</button>
          </div>
        </div>
      `;
    }
    const values = effect as unknown as Record<string, unknown>;
    const params = opt.params.map(spec => this.paramInputHtml(spec, values[spec.key])).join('');
    return `
      <div class="skills-option-row" data-kind="${escapeHtml(effect.kind)}">
        <div class="skills-option-head">
          <span class="skills-option-label">${escapeHtml(opt.label)}</span>
          <code class="skills-effect-kind">${escapeHtml(opt.kind)}</code>
          <span class="admin-form-hint">${escapeHtml(opt.targeting)}</span>
          <button class="admin-btn admin-btn-sm admin-btn-danger skf-option-remove" type="button">×</button>
        </div>
        <div class="skills-option-params">${params}</div>
      </div>
    `;
  }

  private paramInputHtml(spec: SkillOptionParamSpec, value: unknown): string {
    const title = spec.help ? ` title="${escapeHtml(spec.help)}"` : '';
    const label = escapeHtml(spec.label);
    const attrs = `class="skf-param" data-key="${escapeHtml(spec.key)}" data-input="${spec.input}"`;

    if (spec.input === 'boolean') {
      return `<label${title}><input type="checkbox" ${attrs} ${value === true ? 'checked' : ''}>${label}</label>`;
    }
    if (spec.input === 'class') {
      const options = ALL_CLASS_NAMES.map(c =>
        `<option value="${c}" ${value === c ? 'selected' : ''}>${c}</option>`).join('');
      return `<label${title}>${label}<select ${attrs}>${options}</select></label>`;
    }
    if (spec.input === 'condition') {
      const options = SKILL_CONDITION_VALUES.map(c =>
        `<option value="${c}" ${value === c ? 'selected' : ''}>${c}</option>`).join('');
      return `<label${title}>${label}<select ${attrs}>${options}</select></label>`;
    }
    if (spec.input === 'percent') {
      // Stored as a 0-1 fraction; displayed ×100 (monster drop-chance precedent).
      const display = typeof value === 'number' ? String(Math.round(value * 100 * 1000) / 1000) : '';
      const min = spec.min !== undefined ? ` min="${spec.min * 100}"` : '';
      const max = spec.max !== undefined ? ` max="${spec.max * 100}"` : '';
      const step = ` step="${spec.step !== undefined ? spec.step * 100 : 1}"`;
      return `<label${title}>${label}<input type="number" ${attrs} value="${display}"${min}${max}${step}><span class="admin-form-hint">%</span></label>`;
    }
    const display = typeof value === 'number' ? String(value) : '';
    const min = spec.min !== undefined ? ` min="${spec.min}"` : '';
    const max = spec.max !== undefined ? ` max="${spec.max}"` : '';
    const step = ` step="${spec.step ?? 1}"`;
    return `<label${title}>${label}<input type="number" ${attrs} value="${display}"${min}${max}${step}></label>`;
  }

  private wireRowRemovers(root: HTMLElement, btnSel: string, rowSel: string): void {
    root.querySelectorAll<HTMLButtonElement>(btnSel).forEach(btn => {
      btn.onclick = () => btn.closest(rowSel)?.remove();
    });
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#skf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#skf-name') as HTMLInputElement).value.trim();
    const className = (root.querySelector('#skf-class') as HTMLSelectElement).value as ClassName;
    const type = (root.querySelector('#skf-type') as HTMLSelectElement).value as SkillSlotType;
    const grantOnly = (root.querySelector('#skf-grantOnly') as HTMLInputElement).checked;
    const unlockLevel = parseInt((root.querySelector('#skf-unlockLevel') as HTMLInputElement).value);
    const sortOrder = parseInt((root.querySelector('#skf-sortOrder') as HTMLInputElement).value) || 0;
    const cooldown = parseInt((root.querySelector('#skf-cooldown') as HTMLInputElement).value);
    const description = (root.querySelector('#skf-description') as HTMLTextAreaElement).value.trim();

    const id = existingId || crypto.randomUUID();

    const passiveEffects: PassiveEffect[] = [];
    const activeEffects: ActiveEffect[] = [];
    root.querySelectorAll<HTMLElement>('.skills-option-row').forEach(row => {
      const kind = row.dataset.kind ?? '';
      const opt = SKILL_OPTION_CATALOG[kind];
      const effect: Record<string, unknown> = { kind };
      for (const spec of opt?.params ?? []) {
        const el = row.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${spec.key}"]`);
        if (!el) continue;
        if (spec.input === 'boolean') {
          const checked = (el as HTMLInputElement).checked;
          if (checked || spec.required) effect[spec.key] = checked;
        } else if (spec.input === 'number' || spec.input === 'percent') {
          const raw = parseFloat(el.value);
          if (!Number.isNaN(raw)) {
            effect[spec.key] = spec.input === 'percent' ? raw / 100 : raw;
          }
        } else if (el.value) {
          effect[spec.key] = el.value;
        }
      }
      if (opt?.slotType === 'active') activeEffects.push(effect as unknown as ActiveEffect);
      else passiveEffects.push(effect as unknown as PassiveEffect);
    });

    const def: SkillDefinition = {
      id, name, description, className, type,
      unlockLevel: grantOnly ? null : unlockLevel,
      sortOrder,
    };
    if (passiveEffects.length > 0) def.passiveEffects = passiveEffects;
    if (activeEffects.length > 0) def.activeEffects = activeEffects;
    if (type === 'active' && Number.isFinite(cooldown)) def.cooldown = cooldown;

    const errors = validateSkillDefinition(def, this.skillContentOf(ctx));
    if (errors.length > 0) {
      alert(errors.join('\n'));
      return;
    }

    try {
      const data = await putAdmin<{ skills: Record<string, SkillDefinition> }>(
        `/api/admin/skills/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, def);
      ctx.patchVersionContent({ skills: data.skills });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteSkill(ctx: AdminContext, id: string): Promise<void> {
    const skill = (ctx.getDisplayContent()?.skills ?? {})[id];
    if (!skill) return;
    if (!confirm(`Delete skill "${skill.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ skills: Record<string, SkillDefinition> }>(
        `/api/admin/skills/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ skills: data.skills });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  // ---- Slots modal ----

  private openSlotsForm(className: ClassName, ctx: AdminContext): void {
    const readOnly = ctx.isReadOnly();
    const schedule = getSlotSchedule(className, this.skillContentOf(ctx));
    const rows = schedule.map(slot => this.slotRowHtml(slot)).join('');

    const formHtml = `
      <p class="admin-form-hint">
        Slots define how many skills a ${escapeHtml(className)} can equip and at which level each slot opens.
        Removing slots truncates player loadouts on deploy.
      </p>
      <fieldset class="admin-form-fieldset">
        <legend>Slots ${readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="slf-add-slot" type="button">+ Add slot</button>'}</legend>
        <div id="slf-slots-list">${rows}</div>
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="slf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="slf-save" type="button">Save</button>
          <button class="admin-btn admin-btn-secondary" id="slf-cancel" type="button">Cancel</button>
        </div>`;
    const bodyHtml = readOnly
      ? `<fieldset class="admin-form-readonly-wrap" disabled>${formHtml}</fieldset>${actionsHtml}`
      : `${formHtml}${actionsHtml}`;
    const modal = openModal({
      title: `${readOnly ? 'View' : 'Edit'} Slots: ${className}`,
      bodyHtml,
      width: '480px',
    });
    const root = modal.body;

    root.querySelector('#slf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#slf-add-slot')?.addEventListener('click', () => {
      const list = root.querySelector('#slf-slots-list');
      if (!list) return;
      const levels = [...list.querySelectorAll<HTMLInputElement>('.slf-slot-level')]
        .map(i => parseInt(i.value) || 0);
      const nextLevel = Math.min(100, Math.max(1, ...levels, 0) + 5);
      list.insertAdjacentHTML('beforeend', this.slotRowHtml({ type: 'passive', unlocksAtLevel: nextLevel }));
      this.wireRowRemovers(root, '.slf-slot-remove', '.skills-slot-row');
    });
    this.wireRowRemovers(root, '.slf-slot-remove', '.skills-slot-row');
    root.querySelector('#slf-save')?.addEventListener('click', () => {
      this.saveSlots(root, className, ctx, modal.close);
    });
  }

  private slotRowHtml(slot: SkillSlot): string {
    return `
      <div class="skills-slot-row admin-form-row">
        <select class="slf-slot-type">
          <option value="passive" ${slot.type === 'passive' ? 'selected' : ''}>Passive</option>
          <option value="active" ${slot.type === 'active' ? 'selected' : ''}>Active</option>
        </select>
        <label>Unlocks at Lv<input type="number" class="slf-slot-level" value="${slot.unlocksAtLevel}" min="1" max="100" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger slf-slot-remove" type="button">×</button>
      </div>
    `;
  }

  private async saveSlots(
    root: HTMLElement,
    className: ClassName,
    ctx: AdminContext,
    close: () => void,
  ): Promise<void> {
    const slots: SkillSlot[] = [];
    root.querySelectorAll<HTMLElement>('.skills-slot-row').forEach(row => {
      const type = (row.querySelector('.slf-slot-type') as HTMLSelectElement).value as SkillSlotType;
      const unlocksAtLevel = parseInt((row.querySelector('.slf-slot-level') as HTMLInputElement).value);
      slots.push({ type, unlocksAtLevel });
    });
    if (slots.length === 0) { alert('At least one slot is required.'); return; }
    for (const slot of slots) {
      if (!Number.isInteger(slot.unlocksAtLevel) || slot.unlocksAtLevel < 1 || slot.unlocksAtLevel > 100) {
        alert('Each slot needs an unlock level from 1 to 100.');
        return;
      }
    }

    try {
      const data = await putAdmin<{ skillSlotSchedules: Record<string, SkillSlot[]> }>(
        `/api/admin/skill-slots/${encodeURIComponent(className)}${ctx.versionQueryParam()}`, { slots });
      ctx.patchVersionContent({ skillSlotSchedules: data.skillSlotSchedules });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  // ---- Seed restore ----

  private async restoreDefaults(ctx: AdminContext): Promise<void> {
    if (!confirm('Restore the default skill catalog and slot schedules? This overwrites all current skills.')) return;
    try {
      const data = await postAdmin<{
        skills: Record<string, SkillDefinition>;
        skillSlotSchedules: Record<string, SkillSlot[]>;
      }>(`/api/admin/skills/seed${ctx.versionQueryParam()}`, {});
      ctx.patchVersionContent({ skills: data.skills, skillSlotSchedules: data.skillSlotSchedules });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}

/** Format an effect parameter for display, per the catalog's param spec (input: 'percent' → 0-1 fraction shown as a percentage). */
function formatParamValue(value: unknown, spec?: SkillOptionParamSpec): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (spec?.input === 'percent' && typeof value === 'number') {
    return `${Math.round(value * 1000) / 10}%`;
  }
  return String(value);
}
