import { COMBAT_PACE } from '@idle-party-rpg/shared';
import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import {
  ALL_CLASS_NAMES,
  CLASS_DEFINITIONS,
  SKILL_CARD_TYPE_INFO,
  SKILL_CONDITION_VALUES,
  SKILL_OPTION_CATALOG,
  SKILL_TRIGGER_INFO,
  SKILL_TRIGGER_VALUES,
  getSkillCardType,
  getSkillTrigger,
  getSlotSchedule,
  isTimedSkill,
  validateSkillDefinition,
} from '@idle-party-rpg/shared';
import type {
  ActiveEffect,
  ClassName,
  PassiveEffect,
  SkillContent,
  SkillCardType,
  SkillDefinition,
  SkillOptionDefinition,
  SkillOptionParamSpec,
  SkillSlot,
  SkillSlotType,
  SkillTrigger,
  SkillType,
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
          Actives fire on the owner's action (or on their trigger, for Instants),
          then wait out their cooldown, or their recovery and charge (charge alone, for Instants). A class's Attack skill is always in use and takes no slot.
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
    const actives = classSkills.filter(s => s.type === 'active').length;
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
                <th>Card &middot; Timing</th>
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
    const typeLabel = TYPE_LABELS[skill.type];
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
        <td>${this.renderCardCell(skill)}</td>
        <td class="admin-actions-cell">${actions}</td>
      </tr>
    `;
  }

  private renderCardCell(skill: SkillDefinition): string {
    const timing: string[] = [];
    if (skill.type !== 'passive' && isTimedSkill(skill)) {
      timing.push(`charge ${formatSeconds(skill.charge ?? 0)}`);
      if (!getSkillTrigger(skill)) timing.push(`recovery ${formatSeconds(skill.recovery ?? 0)}`);
    } else if (skill.type === 'active' && skill.cooldown != null) {
      timing.push(formatSeconds(skill.cooldown));
    }
    if (skill.type === 'active') {
      if ((skill.castTime ?? 0) > 0) timing.push(`cast ${formatSeconds(skill.castTime!)}`);
      const trigger = getSkillTrigger(skill);
      if (trigger) timing.push(`on ${SKILL_TRIGGER_INFO[trigger].label.toLowerCase()}`);
    }
    const timingHtml = timing.length > 0
      ? `<div class="skills-timing">${escapeHtml(timing.join(' · '))}</div>`
      : '';
    return `${cardPillHtml(getSkillCardType(skill))}${timingHtml}`;
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
    const typeOptions = (['passive', 'active', 'attack'] as SkillType[]).map(t =>
      `<option value="${t}" ${s.type === t ? 'selected' : ''}>${t}</option>`
    ).join('');
    const triggerOptions = [
      `<option value="" ${s.trigger ? '' : 'selected'}>None — uses its action</option>`,
      ...SKILL_TRIGGER_VALUES.map(t =>
        `<option value="${t}" ${s.trigger === t ? 'selected' : ''}>${escapeHtml(SKILL_TRIGGER_INFO[t].label)}</option>`),
    ].join('');
    const activeOnlyStyle = s.type === 'active' ? '' : 'style="display:none"';
    const timedOnlyStyle = s.type === 'passive' ? 'style="display:none"' : '';
    const optionsStyle = s.type === 'attack' ? 'style="display:none"' : '';

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
        <p class="admin-form-hint admin-form-fullrow skf-timed-only" ${timedOnlyStyle}>Charge and recovery are real seconds. Charge is how long until the skill can be used again, after its recovery; recovery is how long until any skill can be used on the owner's turn. A skill with a trigger is an Instant: it has charge only, and fires during recovery. Set either and cooldown is ignored. An Attack skill needs at least one, is learned at level 1, takes no slot and has no options: it is the class's basic attack.</p>
        <label id="skf-charge-wrap" class="skf-timed-only" ${timedOnlyStyle}>
          Charge (real s)
          <input type="number" id="skf-charge" value="${s.charge ?? ''}" min="0" max="120" step="0.1" placeholder="not set">
        </label>
        <label id="skf-recovery-wrap" class="skf-timed-only" ${timedOnlyStyle}>
          Recovery (real s)
          <input type="number" id="skf-recovery" value="${s.recovery ?? ''}" min="0" max="120" step="0.1" placeholder="not set">
        </label>
        <p class="admin-form-hint admin-form-fullrow skf-active-only" ${activeOnlyStyle}>Without charge or recovery, times are authored seconds. In play, cooldown 2 on an action skill means every 2nd action, at the class's own speed; reactions run ${COMBAT_PACE.clock}x slower. Cast time is always authored. Write real times in the description.</p>
        <label id="skf-cooldown-wrap" class="skf-active-only" ${activeOnlyStyle}>
          Cooldown (seconds)
          <input type="number" id="skf-cooldown" value="${s.cooldown ?? (isTimedSkill(s) ? '' : 2)}" min="1" step="0.1">
        </label>
        <label id="skf-castTime-wrap" class="skf-active-only" ${activeOnlyStyle}>
          Cast time (s)
          <input type="number" id="skf-castTime" value="${s.castTime ?? ''}" min="0" max="10" step="0.1" placeholder="0 (no cast)">
        </label>
        <label id="skf-warmup-wrap" class="skf-timed-only" ${timedOnlyStyle}>
          Initial charge (s)
          <input type="number" id="skf-warmup" value="${s.warmup ?? ''}" min="0" max="60" step="0.1" placeholder="default">
        </label>
        <label id="skf-trigger-wrap" class="skf-active-only" ${activeOnlyStyle}>
          Trigger
          <select id="skf-trigger">${triggerOptions}</select>
        </label>
        <div class="skills-card-field">
          Card type
          <span id="skf-card-type"></span>
        </div>
      </div>
      <div id="skf-trigger-help" class="admin-form-hint skf-active-only skills-trigger-help" ${activeOnlyStyle}></div>
      <label class="admin-form-fullrow">Description
        <textarea id="skf-description" rows="3">${escapeHtml(s.description)}</textarea>
      </label>
      <fieldset class="admin-form-fieldset" id="skf-options-fieldset" ${optionsStyle}>
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

    const typeSelect = root.querySelector<HTMLSelectElement>('#skf-type');
    typeSelect?.addEventListener('change', () => {
      root.querySelectorAll<HTMLElement>('.skf-active-only').forEach(el => {
        el.style.display = typeSelect.value === 'active' ? '' : 'none';
      });
      root.querySelectorAll<HTMLElement>('.skf-timed-only').forEach(el => {
        el.style.display = typeSelect.value === 'passive' ? 'none' : '';
      });
      const options = root.querySelector<HTMLElement>('#skf-options-fieldset');
      if (options) options.style.display = typeSelect.value === 'attack' ? 'none' : '';
      this.applyPickerFilter(root);
    });

    const refreshCard = () => this.refreshCardPreview(root);
    root.addEventListener('input', refreshCard);
    root.addEventListener('change', refreshCard);

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
        this.wireRowRemovers(root, '.skf-option-remove', '.skills-option-row', refreshCard);
        if (picker) picker.hidden = true;
        const search = root.querySelector<HTMLInputElement>('#skf-option-search');
        if (search) search.value = '';
        refreshCard();
      });
    });

    this.wireRowRemovers(root, '.skf-option-remove', '.skills-option-row', refreshCard);
    refreshCard();
  }

  private refreshCardPreview(root: HTMLElement): void {
    const def = this.readForm(root);
    const chip = root.querySelector<HTMLElement>('#skf-card-type');
    if (chip) chip.innerHTML = cardPillHtml(getSkillCardType(def));

    const recoveryWrap = root.querySelector<HTMLElement>('#skf-recovery-wrap');
    if (recoveryWrap) recoveryWrap.style.display = def.type === 'passive' || getSkillTrigger(def) ? 'none' : '';

    const warmupInput = root.querySelector<HTMLInputElement>('#skf-warmup');
    if (warmupInput) {
      warmupInput.placeholder = isTimedSkill(def)
        ? 'blank = full charge, 0 = ready immediately'
        : `default (${formatSeconds(defaultWarmupSeconds(def))})`;
    }

    const help = root.querySelector<HTMLElement>('#skf-trigger-help');
    if (help) help.innerHTML = this.triggerHelpHtml(def);
  }

  private triggerHelpHtml(def: SkillDefinition): string {
    const inferenceNote = `Leave the trigger as None on skills with the ${escapeHtml(SKILL_OPTION_CATALOG.redirect_hit?.label ?? 'redirect_hit')}
      or ${escapeHtml(SKILL_OPTION_CATALOG.brace_reflect?.label ?? 'brace_reflect')} option and it is inferred
      (${escapeHtml(SKILL_TRIGGER_INFO.ally_targeted.label)} / ${escapeHtml(SKILL_TRIGGER_INFO.self_hit.label)}).`;
    const trigger = getSkillTrigger(def);
    if (!trigger) return `No trigger: the skill fires when the owner's action comes up. ${inferenceNote}`;
    const info = SKILL_TRIGGER_INFO[trigger];
    const source = def.trigger ? '' : ' (inferred from its options)';
    return `<strong>${escapeHtml(info.label)}${source}:</strong> ${escapeHtml(info.description)} ${inferenceNote}`;
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
    if (spec.input === 'text') {
      return `<label${title}>${label}<input type="text" ${attrs} value="${escapeHtml(typeof value === 'string' ? value : '')}"></label>`;
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

  private wireRowRemovers(root: HTMLElement, btnSel: string, rowSel: string, onRemove?: () => void): void {
    root.querySelectorAll<HTMLButtonElement>(btnSel).forEach(btn => {
      btn.onclick = () => {
        btn.closest(rowSel)?.remove();
        onRemove?.();
      };
    });
  }

  private readForm(root: HTMLElement): SkillDefinition {
    const existingId = (root.querySelector('#skf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#skf-name') as HTMLInputElement).value.trim();
    const className = (root.querySelector('#skf-class') as HTMLSelectElement).value as ClassName;
    const type = (root.querySelector('#skf-type') as HTMLSelectElement).value as SkillType;
    const grantOnly = (root.querySelector('#skf-grantOnly') as HTMLInputElement).checked;
    const unlockLevel = parseInt((root.querySelector('#skf-unlockLevel') as HTMLInputElement).value);
    const sortOrder = parseInt((root.querySelector('#skf-sortOrder') as HTMLInputElement).value) || 0;
    const cooldown = parseFloat((root.querySelector('#skf-cooldown') as HTMLInputElement).value);
    const charge = parseFloat((root.querySelector('#skf-charge') as HTMLInputElement).value);
    const recovery = parseFloat((root.querySelector('#skf-recovery') as HTMLInputElement).value);
    const castTime = parseFloat((root.querySelector('#skf-castTime') as HTMLInputElement).value);
    const warmup = parseFloat((root.querySelector('#skf-warmup') as HTMLInputElement).value);
    const trigger = (root.querySelector('#skf-trigger') as HTMLSelectElement).value as SkillTrigger | '';
    const description = (root.querySelector('#skf-description') as HTMLTextAreaElement).value.trim();

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
      id: existingId, name, description, className, type,
      unlockLevel: grantOnly ? null : unlockLevel,
      sortOrder,
    };
    if (type !== 'attack' && passiveEffects.length > 0) def.passiveEffects = passiveEffects;
    if (type !== 'attack' && activeEffects.length > 0) def.activeEffects = activeEffects;
    if (type !== 'passive') {
      if (Number.isFinite(charge)) def.charge = charge;
      if (Number.isFinite(recovery)) def.recovery = recovery;
      if (Number.isFinite(warmup)) def.warmup = warmup;
    }
    if (type === 'active') {
      if (trigger) def.trigger = trigger;
      if (getSkillTrigger(def)) delete def.recovery;
      if (Number.isFinite(cooldown) && !isTimedSkill(def)) def.cooldown = cooldown;
      if (Number.isFinite(castTime) && castTime !== 0) def.castTime = castTime;
    }
    return def;
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const def = this.readForm(root);
    const id = def.id || crypto.randomUUID();
    def.id = id;

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

const TYPE_LABELS: Record<SkillType, string> = { passive: 'Passive', active: 'Active', attack: 'Attack' };

function formatSeconds(seconds: number): string {
  return `${Math.round(seconds * 100) / 100}s`;
}

/** Warm-up the engine applies when `warmup` is blank, before cooldown reduction. */
function defaultWarmupSeconds(def: SkillDefinition): number {
  const trigger = getSkillTrigger(def);
  if (trigger && trigger !== 'enemy_cast') return 0;
  return Math.max(0, (def.cooldown ?? 1) - 1);
}

function cardPillHtml(cardType: SkillCardType): string {
  const info = SKILL_CARD_TYPE_INFO[cardType];
  return `<span class="admin-pill skills-card-pill skills-card-${cardType}" data-card-type="${cardType}" title="${escapeHtml(info.blurb)}">${info.icon} ${escapeHtml(info.label)}</span>`;
}

/** Format an effect parameter for display, per the catalog's param spec (input: 'percent' → 0-1 fraction shown as a percentage). */
function formatParamValue(value: unknown, spec?: SkillOptionParamSpec): string {
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (spec?.input === 'percent' && typeof value === 'number') {
    return `${Math.round(value * 1000) / 10}%`;
  }
  return String(value);
}
