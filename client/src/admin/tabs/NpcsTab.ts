import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { NpcDefinition } from '@idle-party-rpg/shared';
import { escapeHtml, putAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

const EMOJI_PALETTE = [
  '🧙', '🧝', '🧛', '🧚', '🧞', '🧟', '🧜', '🦸', '🦹', '🥷',
  '👑', '🤴', '👸', '💂', '🕵️', '🧑‍🌾', '🧑‍🍳', '🧑‍⚕️', '🧑‍🏫', '🧑‍🔬',
  '🧑‍🎨', '🧑‍🚒', '🧑‍⚖️', '🧑‍💼', '🧑‍🔧', '🧑‍🎤', '🤺', '🏴‍☠️', '🧌', '👹',
  '👺', '👻', '💀', '☠️', '👽', '🤖', '😈', '🤡', '🧓', '👴',
  '👵', '⚔️', '🛡️', '🏹', '🔮', '📜', '🗝️', '⚒️', '🐉', '🦄',
];

export class NpcsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const npcs = Object.values(content.npcs ?? {});
    const readOnly = ctx.isReadOnly();

    const placements = new Map<string, string>();
    for (const tile of content.world.tiles) {
      if (tile.npcId) placements.set(tile.npcId, `${tile.name} (${tile.col}, ${tile.row})`);
    }

    const rows = npcs.map(n => {
      const placement = placements.get(n.id) ?? '<span class="admin-form-hint">unplaced</span>';
      const actions = readOnly ? '' : `
        <td class="admin-actions-cell">
          <button class="admin-btn admin-btn-sm npc-edit-btn" data-id="${n.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger npc-delete-btn" data-id="${n.id}">Del</button>
        </td>
      `;
      return `<tr>
        <td>${escapeHtml(n.emoji)}</td>
        <td>${escapeHtml(n.name)}</td>
        <td>${placement}</td>
        ${actions}
      </tr>`;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn" id="npc-add-btn">+ Add NPC</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>NPCs <span class="admin-count-badge">${npcs.length}</span></h2>
          ${addBtn}
        </div>
        <p class="admin-form-hint">Create NPCs here, then assign them to a room from the Map tab's room editor.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th></th><th>Name</th><th>Placement</th>${actionsHeader}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#npc-add-btn')?.addEventListener('click', () => this.openForm(null, ctx));
    container.querySelectorAll<HTMLButtonElement>('.npc-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const npc = (ctx.getDisplayContent()?.npcs ?? {})[btn.dataset.id!];
        if (npc) this.openForm(npc, ctx);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.npc-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteNpc(ctx, btn.dataset.id!));
    });
  }

  private openForm(npc: NpcDefinition | null, ctx: AdminContext): void {
    const isNew = !npc;
    const n = npc ?? { id: '', name: '', emoji: '🧙', greeting: '', questIds: [] };
    const content = ctx.getDisplayContent();
    const allQuests = content ? Object.values(content.quests ?? {}) : [];
    const selectedQuests = new Set(n.questIds ?? []);

    const questCheckboxes = allQuests.length > 0
      ? allQuests.map(q => `
          <label class="admin-checkbox">
            <input type="checkbox" class="npcf-quest" value="${escapeHtml(q.id)}" ${selectedQuests.has(q.id) ? 'checked' : ''}>
            ${escapeHtml(q.name)}
          </label>
        `).join('')
      : '<div class="admin-form-hint">No quests defined yet. Create some on the Quests tab.</div>';

    const paletteButtons = EMOJI_PALETTE.map(e => `
      <button type="button" class="npcf-emoji-pick" data-emoji="${escapeHtml(e)}" title="${escapeHtml(e)}"
        style="font-size:1.3em;padding:4px 6px;background:var(--admin-panel);border:1px solid var(--admin-border);border-radius:var(--admin-radius-sm);cursor:pointer;line-height:1;">${escapeHtml(e)}</button>
    `).join('');

    const bodyHtml = `
      <input type="hidden" id="npcf-id" value="${escapeHtml(n.id)}">
      <div class="admin-form-grid">
        <label>Name<input type="text" id="npcf-name" value="${escapeHtml(n.name)}"></label>
        <label>Emoji<input type="text" id="npcf-emoji" value="${escapeHtml(n.emoji)}" maxlength="8" placeholder="🧙"></label>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:4px;margin:-8px 0 var(--admin-gap-loose) 0;">
        ${paletteButtons}
      </div>
      <label>Greeting
        <textarea id="npcf-greeting" rows="3" placeholder="What this NPC says when you talk to them.">${escapeHtml(n.greeting)}</textarea>
      </label>
      <fieldset class="admin-form-fieldset">
        <legend>Quests offered</legend>
        ${questCheckboxes}
      </fieldset>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="npcf-save" type="button">${isNew ? 'Add' : 'Save'}</button>
        <button class="admin-btn admin-btn-secondary" id="npcf-cancel" type="button">Cancel</button>
      </div>
    `;
    const modal = openModal({
      title: isNew ? 'Add NPC' : `Edit: ${n.name}`,
      bodyHtml,
      width: '480px',
    });
    const root = modal.body;

    root.querySelector('#npcf-cancel')?.addEventListener('click', modal.close);
    root.querySelector('#npcf-save')?.addEventListener('click', () => this.saveForm(root, ctx, modal.close));

    const emojiInput = root.querySelector<HTMLInputElement>('#npcf-emoji');
    root.querySelectorAll<HTMLButtonElement>('.npcf-emoji-pick').forEach(btn => {
      btn.addEventListener('click', () => {
        if (emojiInput) emojiInput.value = btn.dataset.emoji ?? '';
      });
    });
  }

  private async saveForm(root: HTMLElement, ctx: AdminContext, close: () => void): Promise<void> {
    const existingId = (root.querySelector('#npcf-id') as HTMLInputElement).value.trim();
    const name = (root.querySelector('#npcf-name') as HTMLInputElement).value.trim();
    const emoji = (root.querySelector('#npcf-emoji') as HTMLInputElement).value.trim();
    const greeting = (root.querySelector('#npcf-greeting') as HTMLTextAreaElement).value.trim();
    if (!name) { alert('Name is required.'); return; }
    if (!emoji) { alert('Emoji is required.'); return; }
    if (!greeting) { alert('Greeting is required.'); return; }
    const id = existingId || crypto.randomUUID();

    const questIds: string[] = [];
    for (const cb of root.querySelectorAll<HTMLInputElement>('.npcf-quest:checked')) {
      questIds.push(cb.value);
    }

    const npcDef: NpcDefinition = { id, name, emoji, greeting, questIds: questIds.length > 0 ? questIds : undefined };
    try {
      const data = await putAdmin<{ npcs: Record<string, NpcDefinition> }>(
        `/api/admin/npcs/${encodeURIComponent(id)}${ctx.versionQueryParam()}`, npcDef);
      ctx.patchVersionContent({ npcs: data.npcs });
      close();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteNpc(ctx: AdminContext, id: string): Promise<void> {
    const npc = (ctx.getDisplayContent()?.npcs ?? {})[id];
    if (!npc) return;
    if (!confirm(`Delete NPC "${npc.name}"?`)) return;
    try {
      const data = await deleteAdmin<{ npcs: Record<string, NpcDefinition> }>(
        `/api/admin/npcs/${encodeURIComponent(id)}${ctx.versionQueryParam()}`);
      ctx.patchVersionContent({ npcs: data.npcs });
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
