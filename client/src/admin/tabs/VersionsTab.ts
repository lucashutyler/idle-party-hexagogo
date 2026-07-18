import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { escapeHtml, postAdmin, deleteAdmin } from '../api';

export class VersionsTab implements Tab {
  render(container: HTMLElement, ctx: AdminContext): void {
    const rows = ctx.versions.map(v => {
      const statusBadge = v.isActive
        ? '<span class="version-badge version-badge-active">Active</span>'
        : v.status === 'published'
          ? '<span class="version-badge version-badge-published">Published</span>'
          : '<span class="version-badge version-badge-draft">Draft</span>';

      const date = new Date(v.createdAt).toLocaleDateString();

      let actions = '';
      if (v.status === 'draft') {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="select" data-id="${v.id}">Edit</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="publish" data-id="${v.id}">Publish</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger version-action" data-action="delete" data-id="${v.id}">Delete</button>
        `;
      } else if (v.isActive) {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="select" data-id="${v.id}">View</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="create-from" data-id="${v.id}">New Draft</button>
        `;
      } else {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="select" data-id="${v.id}">View</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="deploy" data-id="${v.id}">Deploy</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="create-from" data-id="${v.id}">New Draft</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger version-action" data-action="delete" data-id="${v.id}">Delete</button>
        `;
      }

      const selected = v.id === ctx.selectedVersionId ? ' admin-row-selected' : '';
      return `
        <tr class="${selected}">
          <td>${escapeHtml(v.name)}</td>
          <td>${statusBadge}</td>
          <td>${date}</td>
          <td class="version-actions-cell">${actions}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Versions</h2>
          <button class="admin-btn" id="version-create-new">+ New Draft</button>
        </div>
        <p class="admin-page-subtitle">
          Edits go into a draft. Publishing freezes a draft. Deploying makes a published
          version the live game content.
        </p>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="4" style="text-align:center;opacity:0.5">No versions yet</td></tr>'}</tbody>
          </table>
        </div>
        ${this.renderDesignNotes(ctx)}
      </div>
    `;

    container.querySelector('#version-create-new')?.addEventListener('click', () => {
      this.createDraftFrom(ctx, ctx.activeVersionId);
    });

    container.querySelectorAll<HTMLButtonElement>('.version-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = btn.dataset.action!;
        const id = btn.dataset.id!;
        switch (action) {
          case 'select':
            ctx.selectVersion(id);
            break;
          case 'publish':
            this.publish(ctx, id);
            break;
          case 'deploy':
            this.deploy(ctx, id);
            break;
          case 'delete':
            this.deleteVersion(ctx, id);
            break;
          case 'create-from':
            this.createDraftFrom(ctx, id);
            break;
        }
      });
    });
  }

  private renderDesignNotes(ctx: AdminContext): string {
    if (!ctx.selectedVersionId || !ctx.versionContent) return '';
    const notes = Object.values(ctx.versionContent.designNotes ?? {});
    if (notes.length === 0) return '';

    const cards = notes.map(note => {
      const date = new Date(note.updatedAt).toLocaleDateString();
      const tags = (note.tags ?? []).map(t => `<span class="design-note-tag">${escapeHtml(t)}</span>`).join('');
      return `
        <div class="admin-card design-note-card">
          <div class="admin-card-title">${escapeHtml(note.title)}</div>
          <div class="design-note-meta admin-muted">${escapeHtml(note.author)} &middot; ${date}</div>
          <div class="design-note-body">${escapeHtml(note.body)}</div>
          ${tags ? `<div class="design-note-tags">${tags}</div>` : ''}
        </div>
      `;
    }).join('');

    return `
      <div class="design-note-section">
        <h3>Design Notes</h3>
        <p class="admin-form-hint">Design context recorded alongside this draft (read-only here; authored via the MCP tools).</p>
        <div class="admin-analytics-grid">${cards}</div>
      </div>
    `;
  }

  private async createDraftFrom(ctx: AdminContext, fromId: string | null): Promise<void> {
    const seed = fromId
      ? ctx.versions.find(v => v.id === fromId)?.name ?? ''
      : '';
    const name = prompt('Draft name:', seed ? `${seed} (copy)` : '');
    if (!name) return;
    try {
      const data = await postAdmin<{ version?: { id: string } }>(
        '/api/admin/versions', { name, fromVersionId: fromId });
      await ctx.refreshVersions();
      if (data.version?.id) {
        // Auto-select the new draft so subsequent edits target it (and the UI is editable).
        await ctx.selectVersion(data.version.id);
      } else {
        ctx.refreshStatusBar();
        ctx.rerenderTab();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to create draft');
    }
  }

  private async publish(ctx: AdminContext, id: string): Promise<void> {
    if (!confirm('Publish this draft? It will become immutable.')) return;
    try {
      await postAdmin(`/api/admin/versions/${id}/publish`, {});
      await ctx.refreshVersions();
      ctx.refreshStatusBar();
      ctx.rerenderTab();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to publish');
    }
  }

  private async deploy(ctx: AdminContext, id: string): Promise<void> {
    const version = ctx.versions.find(v => v.id === id);
    if (!confirm(`Deploy "${version?.name ?? id}" to the live game? Players on removed rooms will be relocated.`)) return;
    try {
      const data = await postAdmin<{ relocated?: number }>(`/api/admin/versions/${id}/deploy`, {});
      await ctx.refreshVersions();
      ctx.refreshStatusBar();
      ctx.rerenderTab();
      alert(`Deployed! ${data.relocated ?? 0} parties relocated.`);
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to deploy');
    }
  }

  private async deleteVersion(ctx: AdminContext, id: string): Promise<void> {
    if (!confirm('Delete this version?')) return;
    try {
      await deleteAdmin(`/api/admin/versions/${id}`);
      await ctx.refreshVersions();
      if (ctx.selectedVersionId === id && ctx.activeVersionId) {
        await ctx.selectVersion(ctx.activeVersionId);
      } else {
        ctx.refreshStatusBar();
        ctx.rerenderTab();
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Failed to delete');
    }
  }
}
