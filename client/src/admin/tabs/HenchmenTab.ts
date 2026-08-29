import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { ClassName, DamageType, HenchmanDefinition, SkillDefinition } from '@idle-party-rpg/shared';
import { ALL_CLASS_NAMES } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

// Curated palette for henchman portraits (sellswords, casters, beasts, oddities).
const EMOJI_PALETTE = [
  '🗡️', '⚔️', '🛡️', '🏹', '🪓', '🔨', '🔱', '🪄', '🔮', '📜',
  '🧙', '🧝', '🧛', '🧚', '🧞', '🧟', '🧜', '🦸', '🦹', '🥷',
  '💂', '🤺', '🕵️', '👮', '👷', '🤴', '👸', '👑', '🏴‍☠️', '🧌',
  '🧑‍🌾', '🧑‍🍳', '🧑‍⚕️', '🧑‍🎤', '🧑‍🔧', '🧑‍🔬', '🧑‍🎨', '🧓', '👴', '👵',
  '🐉', '🦄', '🐺', '🐻', '🦅', '🐗', '😈', '👹', '👺', '💀',
];

export class HenchmenTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const henchmen = Object.values(content.henchmen ?? {});
    const readOnly = ctx.isReadOnly();

    const rows = henchmen.map(h => {
      const actions = readOnly
        ? `<td class="admin-actions-cell"><button class="admin-btn admin-btn-sm henchman-view-btn" data-id="${h.id}">View</button></td>`
        : `<td class="admin-actions-cell">
            <button class="admin-btn admin-btn-sm henchman-edit-btn" data-id="${h.id}">Edit</button>
            <button class="admin-btn admin-btn-sm admin-btn-danger henchman-delete-btn" data-id="${h.id}">Del</button>
          </td>`;
      const damage = h.damageType
        ? `${h.baseDamage} <span class="admin-pill admin-pill-${h.damageType}">${h.damageType}</span>`
        : `${h.baseDamage}`;
      return `<tr>
        <td>${this.portraitHtml(h)}</td>
        <td>${escapeHtml(h.name)}</td>
        <td>${h.className}</td>
        <td>${h.level}</td>
        <td>${h.maxHp}</td>
        <td>${damage}</td>
        <td>${h.skillIds.length}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="henchman-add-btn">+ Add Henchman</button>';
    const actionsHeader = '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Henchmen <span class="admin-count-badge">${henchmen.length}</span></h2>
          ${addBtn}
        </div>
        <p class="admin-form-hint">Create henchmen here, then list them for hire on a shop from the Shops tab.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th></th>
                <th>Name</th>
                <th>Archetype</th>
                <th>Level</th>
                <th>HP</th>
                <th>Dmg</th>
                <th>Skills</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#henchman-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.henchman-edit-btn, .henchman-view-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const henchman = (ctx.getDisplayContent()?.henchmen ?? {})[btn.dataset.id!];
        if (henchman) this.openForm(henchman, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.henchman-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteHenchman(ctx, btn.dataset.id!));
    });
  }

  /** The photo when one is authored — the emoji is the alt text, so it shows if the URL 404s. */
  private portraitHtml(h: HenchmanDefinition): string {
    if (!h.artworkUrl) return escapeHtml(h.emoji);
    return `<img src="${escapeHtml(h.artworkUrl)}" alt="${escapeHtml(h.emoji)}"
      style="width:28px;height:28px;object-fit:cover;border-radius:var(--admin-radius-sm);vertical-align:middle;">`;
  }

  private openForm(henchman: HenchmanDefinition | null, ctx: AdminContext): void {
    const isNew = !henchman;
    const readOnly = ctx.isReadOnly();
    const h: HenchmanDefinition = henchman ?? {
      id: '', name: '', className: ALL_CLASS_NAMES[0], level: 1,
      maxHp: 50, baseDamage: 5, skillIds: [], emoji: '🗡️',
    };

    const skills = Object.values(ctx.getDisplayContent()?.skills ?? {})
      .sort((a, b) => a.className.localeCompare(b.className) || a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const equipped = new Set(h.skillIds);
    const skillRows = skills.length > 0
      ? skills.map(s => this.skillChecklistRowHtml(s, equipped.has(s.id))).join('')
      : '<div class="admin-form-hint">No skills defined yet. Create some on the Skills tab.</div>';

    const classOptions = ALL_CLASS_NAMES.map(c =>
      `<option value="${c}" ${h.className === c ? 'selected' : ''}>${c}</option>`
    ).join('');
    const damageTypeOptions = ['', 'physical', 'magical', 'holy'].map(dt =>
      `<option value="${dt}" ${(h.damageType ?? '') === dt ? 'selected' : ''}>${dt || '(archetype default)'}</option>`
    ).join('');

    const paletteButtons = EMOJI_PALETTE.map(e => `
      <button type="button" class="hf-emoji-pick" data-emoji="${escapeHtml(e)}" title="${escapeHtml(e)}"
        style="font-size:1.3em;padding:4px 6px;background:var(--admin-panel);border:1px solid var(--admin-border);border-radius:var(--admin-radius-sm);cursor:pointer;line-height:1;">${escapeHtml(e)}</button>
    `).join('');

    const bodyHtml = `
      <input type="hidden" id="hf-id" value="${escapeHtml(h.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="hf-name" value="${escapeHtml(h.name)}"></label>
        <label>Combat archetype
          <select id="hf-className">${classOptions}</select>
          <span class="admin-form-hint">Drives the engine's class checks. Never shown to players.</span>
        </label>
        <label>Level<input type="number" id="hf-level" value="${h.level}" min="1"></label>
        <label>Max HP<input type="number" id="hf-maxHp" value="${h.maxHp}" min="1"></label>
        <label>Damage<input type="number" id="hf-baseDamage" value="${h.baseDamage}" min="0"></label>
        <label>Damage Type<select id="hf-damageType">${damageTypeOptions}</select></label>
      </div>
      <label class="admin-form-fullrow">Description (optional)
        <textarea id="hf-description" rows="2" placeholder="Flavour line shown in the hire list.">${escapeHtml(h.description ?? '')}</textarea>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Portrait</legend>
        <div class="admin-form-grid">
          <label>Emoji<input type="text" id="hf-emoji" value="${escapeHtml(h.emoji)}" maxlength="8" placeholder="🗡️"></label>
          <label>Photo URL (optional)
            <input type="text" id="hf-artworkUrl" value="${escapeHtml(h.artworkUrl ?? '')}" placeholder="/henchman-artwork/${escapeHtml(h.id || 'my_henchman')}.png">
          </label>
        </div>
        <div style="display:flex;flex-wrap:wrap;gap:4px;">
          ${paletteButtons}
        </div>
      </fieldset>
      <fieldset class="admin-form-fieldset">
        <legend>Skill Loadout <span id="hf-skill-count" class="admin-form-hint"></span></legend>
        <div class="admin-form-hint">A henchman's skills are fixed at hire — there is no levelling and no equipment.</div>
        <div class="admin-checklist-toolbar">
          <input type="search" id="hf-skill-search" placeholder="Search skills…" autocomplete="off">
        </div>
        <div class="admin-checklist" id="hf-skill-list">${skillRows}</div>
      </fieldset>
    `;
    const actionsHtml = readOnly
      ? `<div class="admin-modal-actions admin-modal-actions-readonly">
          <span class="admin-form-hint admin-modal-readonly-hint">* Create a new draft to edit</span>
          <button class="admin-btn admin-btn-secondary" id="hf-cancel" type="button">Close</button>
        </div>`
      : `<div class="admin-modal-actions">
          <button class="admin-btn" id="hf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="hf-cancel" type="button">Cancel</button>
        </div>`;
    const wrappedBody = readOnly
      ? `<fieldset class="admin-form-readonly-wrap" disabled>${bodyHtml}</fieldset>${actionsHtml}`
      : `${bodyHtml}${actionsHtml}`;
    const titlePrefix = isNew ? 'Add' : (readOnly ? 'View' : 'Edit');
    const modal = openModal({
      title: isNew ? 'Add Henchman' : `${titlePrefix}: ${escapeHtml(h.name)}`,
      bodyHtml: wrappedBody,
      width: '720px',
    });
    const root = modal.body;

    root.querySelector('#hf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#hf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));

    // Emoji palette: clicking a swatch sets the emoji input.
    const emojiInput = root.querySelector<HTMLInputElement>('#hf-emoji');
    root.querySelectorAll<HTMLButtonElement>('.hf-emoji-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (emojiInput) emojiInput.value = btn.dataset.emoji ?? '';
      });
    });

    this.wireSkillFilter(root);
  }

  private skillChecklistRowHtml(skill: SkillDefinition, checked: boolean): string {
    const haystack = `${skill.name} ${skill.className} ${skill.type} ${skill.id}`.toLowerCase();
    return `
      <label class="admin-checkbox hf-skill-row" data-skill-search="${escapeHtml(haystack)}">
        <input type="checkbox" class="hf-skill-check" value="${escapeHtml(skill.id)}" ${checked ? 'checked' : ''}>
        ${escapeHtml(skill.name)}
        <span class="admin-form-hint">${skill.className} · ${skill.type}</span>
      </label>
    `;
  }

  private wireSkillFilter(root: HTMLElement): void {
    const search = root.querySelector<HTMLInputElement>('#hf-skill-search');
    const list = root.querySelector<HTMLElement>('#hf-skill-list');
    const countEl = root.querySelector<HTMLElement>('#hf-skill-count');
    if (!list) return;

    const apply = () => {
      const q = (search?.value ?? '').trim().toLowerCase();
      let shown = 0;
      let total = 0;
      list.querySelectorAll<HTMLElement>('.hf-skill-row').forEach(row => {
        total++;
        const visible = !q || (row.dataset.skillSearch ?? '').includes(q);
        row.style.display = visible ? '' : 'none';
        if (visible) shown++;
      });
      const checked = list.querySelectorAll('.hf-skill-check:checked').length;
      if (countEl) {
        countEl.textContent = shown === total
          ? `(${checked} equipped of ${total})`
          : `(${checked} equipped, ${shown} of ${total} shown)`;
      }
    };

    search?.addEventListener('input', apply);
    list.addEventListener('change', apply);
    apply();
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#hf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#hf-name') as HTMLInputElement).value.trim();
    const className = (root.querySelector('#hf-className') as HTMLSelectElement).value as ClassName;
    const level = parseInt((root.querySelector('#hf-level') as HTMLInputElement).value) || 1;
    const maxHp = parseInt((root.querySelector('#hf-maxHp') as HTMLInputElement).value) || 1;
    const baseDamage = parseInt((root.querySelector('#hf-baseDamage') as HTMLInputElement).value) || 0;
    const damageType = (root.querySelector('#hf-damageType') as HTMLSelectElement).value;
    const emoji = (root.querySelector('#hf-emoji') as HTMLInputElement).value.trim();
    const artworkUrl = (root.querySelector('#hf-artworkUrl') as HTMLInputElement).value.trim();
    const description = (root.querySelector('#hf-description') as HTMLTextAreaElement).value.trim();
    if (!name) { alert('Name is required.'); return; }
    if (!emoji) { alert('Emoji is required.'); return; }
    const id = existingId || crypto.randomUUID();

    const skillIds: string[] = [];
    root.querySelectorAll<HTMLInputElement>('.hf-skill-check').forEach(cb => {
      if (cb.checked) skillIds.push(cb.value);
    });

    const henchmanDef: HenchmanDefinition = {
      id, name, className, level, maxHp, baseDamage, skillIds, emoji,
      description: description || undefined,
      damageType: damageType ? (damageType as DamageType) : undefined,
      artworkUrl: artworkUrl || undefined,
    };
    try {
      const data = await putAdmin<{ henchmen: Record<string, HenchmanDefinition> }>(
        `/api/admin/henchmen/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, henchmanDef);
      ctx.patchVersionContent({ henchmen: data.henchmen });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteHenchman(ctx: AdminContext, id: string): Promise<void> {
    const henchman = (ctx.getDisplayContent()?.henchmen ?? {})[id];
    if (!henchman) return;
    if (!confirm(`Delete henchman "${henchman.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ henchmen: Record<string, HenchmanDefinition> }>(
        `/api/admin/henchmen/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ henchmen: data.henchmen });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
