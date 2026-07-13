import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { InviteListData } from '../types';
import { escapeHtml, fetchAdmin, postAdmin, deleteAdmin } from '../api';

export class InviteListTab implements Tab {
  private emails: string[] = [];
  private loaded = false;

  render(container: HTMLElement, ctx: AdminContext): void {
    const rows = this.emails.map(email => `
      <tr>
        <td>${escapeHtml(email)}</td>
        <td><button class="admin-btn admin-btn-sm admin-btn-danger invite-remove-btn" data-email="${escapeHtml(email)}">Remove</button></td>
      </tr>
    `).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Invite List <span class="admin-count-badge">${this.emails.length}</span></h2>
        </div>
        <p class="admin-page-subtitle">
          This server is invite-only (INVITE_ONLY=true). Emails in ADMIN_EMAILS always have access —
          add other allowed emails here to let them sign in during the beta.
        </p>
        <div class="admin-filter-bar">
          <input type="email" id="invite-email-input" placeholder="player@example.com">
          <button class="admin-btn admin-btn-primary" id="invite-add-btn">Add</button>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead><tr><th>Email</th><th></th></tr></thead>
            <tbody>${rows || '<tr><td colspan="2"><em>No emails added yet</em></td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;

    this.wire(container, ctx);

    if (!this.loaded) {
      this.refresh(ctx);
    }
  }

  private wire(container: HTMLElement, ctx: AdminContext): void {
    const input = container.querySelector<HTMLInputElement>('#invite-email-input');

    const addEmail = async () => {
      const email = input?.value.trim();
      if (!email) return;
      try {
        await postAdmin('/api/admin/invite-list', { email });
        if (input) input.value = '';
        await this.refresh(ctx);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to add email');
      }
    };

    container.querySelector('#invite-add-btn')?.addEventListener('click', addEmail);
    input?.addEventListener('keydown', e => {
      if (e.key === 'Enter') addEmail();
    });

    container.querySelectorAll<HTMLButtonElement>('.invite-remove-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const email = btn.dataset.email!;
        if (!confirm(`Remove ${email} from the invite list?`)) return;
        try {
          await deleteAdmin(`/api/admin/invite-list/${encodeURIComponent(email)}`);
          await this.refresh(ctx);
        } catch (err) {
          alert(err instanceof Error ? err.message : 'Failed to remove email');
        }
      });
    });
  }

  private async refresh(ctx: AdminContext): Promise<void> {
    try {
      const data = await fetchAdmin<InviteListData>('/api/admin/invite-list');
      this.emails = data.emails;
      this.loaded = true;
      ctx.rerenderTab();
    } catch {
      // keep stale
    }
  }
}
