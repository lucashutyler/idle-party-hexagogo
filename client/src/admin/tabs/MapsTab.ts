import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { WorldData, WorldMapMeta } from '@idle-party-rpg/shared';
import { escapeHtml, postAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';
import { renderArtworkSection, wireArtworkSection } from '../components/ArtworkSection';

/**
 * Maps management tab — create / rename / delete the world's maps.
 * Editing a map's rooms (the canvas) lives in the separate "Map Editor" tab.
 */
export class MapsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) {
      container.innerHTML = '<div class="admin-page-empty">No data</div>';
      return;
    }
    const world = content.world;
    const maps = world.maps ?? [];
    const readOnly = ctx.isReadOnly();

    const roomCounts = new Map<string, number>();
    for (const t of world.tiles) roomCounts.set(t.mapId, (roomCounts.get(t.mapId) ?? 0) + 1);

    const roDisabled = readOnly ? ' disabled title="Switch to a draft version to edit"' : '';
    const addBtn = `<button class="admin-btn" id="maps-add-btn" type="button"${readOnly ? ' disabled title="Switch to a draft version to create maps"' : ''}>+ New Map</button>`;

    const rows = maps.map(m => {
      const isDefault = m.id === world.defaultMapId;
      const count = roomCounts.get(m.id) ?? 0;
      const delDisabled = isDefault
        ? ' disabled title="The default (spawn) map can\'t be deleted"'
        : roDisabled;
      return `
        <tr>
          <td>${escapeHtml(m.name)}${isDefault ? ' <span class="admin-pill admin-pill-gold">Default</span>' : ''}</td>
          <td>${escapeHtml(m.id)}</td>
          <td>${count}</td>
          <td class="admin-actions-cell">
            <button class="admin-btn admin-btn-sm maps-edit-btn" data-id="${escapeHtml(m.id)}">Edit</button>
            <button class="admin-btn admin-btn-sm admin-btn-danger maps-delete-btn" data-id="${escapeHtml(m.id)}"${delDisabled}>Del</button>
          </td>
        </tr>`;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Maps <span class="admin-count-badge">${maps.length}</span></h2>
          ${addBtn}
        </div>
        <p class="admin-form-hint">Each map is its own hex grid. Edit a map's rooms in the <strong>Map Editor</strong> tab; link rooms between maps with transitions in the room editor there.</p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Name</th><th>ID</th><th>Rooms</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;

    container.querySelector('#maps-add-btn')?.addEventListener('click', () => this.promptCreate(ctx));
    container.querySelectorAll<HTMLButtonElement>('.maps-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const map = maps.find(m => m.id === btn.dataset.id);
        if (map) this.promptEditMap(ctx, map);
      });
    });
    container.querySelectorAll<HTMLButtonElement>('.maps-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => this.deleteMap(ctx, btn.dataset.id!));
    });
  }

  private async applyWorld(ctx: AdminContext, world: WorldData): Promise<void> {
    ctx.patchVersionContent({ world });
    ctx.rerenderTab();
  }

  private promptCreate(ctx: AdminContext): void {
    if (ctx.isReadOnly()) return;
    const modal = openModal({
      title: 'New Map',
      width: '420px',
      bodyHtml: `
        <div class="admin-form-grid">
          <label>Name<input type="text" id="new-map-name" placeholder="Map name"></label>
          <label>ID (lowercase, no spaces)<input type="text" id="new-map-id" placeholder="map-id"></label>
        </div>
        <div id="new-map-error" class="admin-map-sidebar-error"></div>
        <div class="admin-modal-actions"><button class="admin-btn admin-btn-primary" id="new-map-create" type="button">Create Map</button></div>
      `,
    });
    const nameInput = modal.body.querySelector('#new-map-name') as HTMLInputElement;
    const idInput = modal.body.querySelector('#new-map-id') as HTMLInputElement;
    const errorEl = modal.body.querySelector('#new-map-error') as HTMLElement;
    nameInput?.addEventListener('input', () => {
      if (!idInput.dataset.touched) idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    });
    idInput?.addEventListener('input', () => { idInput.dataset.touched = '1'; });
    modal.body.querySelector('#new-map-create')?.addEventListener('click', async () => {
      const name = nameInput.value.trim();
      const id = idInput.value.trim();
      if (!name || !id) { errorEl.textContent = 'Name and ID are required.'; return; }
      try {
        const data = await postAdmin<{ world: WorldData }>(`/api/admin/world/map${ctx.versionQueryParam()}`, { id, name });
        modal.close();
        await this.applyWorld(ctx, data.world);
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Network error';
      }
    });
  }

  private promptEditMap(ctx: AdminContext, map: WorldMapMeta): void {
    const readOnly = ctx.isReadOnly();
    const dis = readOnly ? ' disabled' : '';
    // Renaming flows through versioning (draft only); artwork is a live global
    // asset, so the background uploader works regardless of draft mode.
    const nameActions = readOnly
      ? '<div class="admin-form-hint">Switch to a draft version to rename this map.</div>'
      : '<div class="admin-modal-actions"><button class="admin-btn admin-btn-primary" id="edit-map-save" type="button">Save name</button></div>';
    const modal = openModal({
      title: `Edit "${escapeHtml(map.name)}"`,
      width: '460px',
      bodyHtml: `
        <div class="admin-form-grid">
          <label>Name<input type="text" id="edit-map-name" value="${escapeHtml(map.name)}"${dis}></label>
        </div>
        <div id="edit-map-error" class="admin-map-sidebar-error"></div>
        ${nameActions}
        <fieldset class="admin-form-fieldset">
          <legend>Map background (parchment)</legend>
          <p class="admin-form-hint">Tiling texture drawn behind this map. Square PNG.</p>
          ${renderArtworkSection({ kind: 'parchment', id: map.id })}
        </fieldset>
      `,
    });
    wireArtworkSection(modal.body, { kind: 'parchment', id: map.id });
    if (!readOnly) {
      const nameInput = modal.body.querySelector('#edit-map-name') as HTMLInputElement;
      const errorEl = modal.body.querySelector('#edit-map-error') as HTMLElement;
      modal.body.querySelector('#edit-map-save')?.addEventListener('click', async () => {
        const name = nameInput.value.trim();
        if (!name) { errorEl.textContent = 'Name is required.'; return; }
        try {
          // Same id → server updates the name only.
          const data = await postAdmin<{ world: WorldData }>(`/api/admin/world/map${ctx.versionQueryParam()}`, { id: map.id, name });
          modal.close();
          await this.applyWorld(ctx, data.world);
        } catch (err) {
          errorEl.textContent = err instanceof Error ? err.message : 'Network error';
        }
      });
    }
  }

  private async deleteMap(ctx: AdminContext, id: string): Promise<void> {
    if (ctx.isReadOnly()) return;
    if (!confirm(`Delete map "${id}"? This can't be undone.`)) return;
    try {
      const data = await deleteAdmin<{ world: WorldData }>(`/api/admin/world/map${ctx.versionQueryParam()}`, { id });
      await this.applyWorld(ctx, data.world);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error');
    }
  }
}
