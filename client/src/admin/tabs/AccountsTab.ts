import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { AccountData, AccountSortColumn, SortDirection } from '../types';
import { escapeHtml, fetchAdmin, formatRelativeTime, postAdmin } from '../api';
import { openModal } from '../components/Modal';

const CLASSES = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];

export class AccountsTab implements Tab {
  // Filters & sort persist across tab switches.
  private sortColumn: AccountSortColumn = 'created';
  private sortDir: SortDirection = 'desc';
  private filterShowNoChar = false;
  private filterShowBanned = false;
  private filterActiveDays = '';
  private filterCreatedDays = '';
  private duplicateTokens: Record<string, string[]> = {};

  render(container: HTMLElement, ctx: AdminContext): void {
    const sorted = this.getSortedAccounts(ctx.accounts);
    const filteredCount = sorted.length;
    const totalCount = ctx.accounts.length;

    const rows = sorted.map(a => {
      const classCell = a.username && a.className
        ? `<select class="account-class-select" data-username="${escapeHtml(a.username)}">
            ${CLASSES.map(c => `<option value="${c}"${c === a.className ? ' selected' : ''}>${c}</option>`).join('')}
           </select>`
        : (a.className ?? '—');

      const usernameCell = a.username
        ? `<a href="#" class="account-detail-link" data-email="${escapeHtml(a.email)}">${escapeHtml(a.username)}</a>`
        : '<em>none</em>';

      const statusBadges: string[] = [];
      statusBadges.push(a.isOnline
        ? '<span class="status-online">Online</span>'
        : '<span class="status-offline">Offline</span>');
      if (a.deactivated) {
        const appealIcon = a.hasReactivationRequest
          ? ' <span class="status-appeal" title="Has reactivation request">!</span>'
          : '';
        statusBadges.push(`<span class="status-banned" title="Suspended">BAN${appealIcon}</span>`);
      }

      return `
        <tr${a.deactivated ? ' class="admin-row-disabled"' : ''}>
          <td>${usernameCell}</td>
          <td>${escapeHtml(a.email)}</td>
          <td>${statusBadges.join(' ')}</td>
          <td>${a.level ?? '—'}</td>
          <td>${classCell}</td>
          <td>${new Date(a.createdAt).toLocaleDateString()}</td>
          <td title="${a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString() : ''}">${formatRelativeTime(a.lastActiveAt)}</td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Accounts <span class="admin-count-badge">${filteredCount} of ${totalCount}</span></h2>
        </div>
        <div class="admin-filter-bar">
          <label class="admin-checkbox">
            <input type="checkbox" id="filter-show-no-char" ${this.filterShowNoChar ? 'checked' : ''}>
            Show no character
          </label>
          <label class="admin-checkbox">
            <input type="checkbox" id="filter-show-banned" ${this.filterShowBanned ? 'checked' : ''}>
            Show banned
          </label>
          <label class="admin-inline-field">
            Active in last
            <input type="number" id="filter-active-days" value="${this.filterActiveDays}" min="1" placeholder="–">
            days
          </label>
          <label class="admin-inline-field">
            Created in last
            <input type="number" id="filter-created-days" value="${this.filterCreatedDays}" min="1" placeholder="–">
            days
          </label>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table admin-table-sortable">
            <thead>
              <tr>
                <th data-sort="username">Username${this.sortIndicator('username')}</th>
                <th data-sort="email">Email${this.sortIndicator('email')}</th>
                <th data-sort="status">Status${this.sortIndicator('status')}</th>
                <th data-sort="level">Lv${this.sortIndicator('level')}</th>
                <th data-sort="class">Class${this.sortIndicator('class')}</th>
                <th data-sort="created">Created${this.sortIndicator('created')}</th>
                <th data-sort="lastActive">Last Active${this.sortIndicator('lastActive')}</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>

        <div class="admin-danger-zone">
          <h3>Danger Zone</h3>
          <p>Reset ALL players to Level 1, 0 XP, starting room. Classes are kept.</p>
          <button id="master-reset-btn" class="admin-btn admin-btn-danger">Master Reset</button>
        </div>
      </div>
    `;

    this.wire(container, ctx);

    // Lazy-load duplicate tokens for the detail modal.
    fetchAdmin<{ duplicates: Record<string, string[]> }>('/api/admin/duplicate-tokens')
      .then(data => { this.duplicateTokens = data.duplicates; })
      .catch(() => { /* ignore */ });
  }

  private wire(container: HTMLElement, ctx: AdminContext): void {
    container.querySelector('#filter-show-no-char')?.addEventListener('change', e => {
      this.filterShowNoChar = (e.target as HTMLInputElement).checked;
      ctx.rerenderTab();
    });
    container.querySelector('#filter-show-banned')?.addEventListener('change', e => {
      this.filterShowBanned = (e.target as HTMLInputElement).checked;
      ctx.rerenderTab();
    });
    container.querySelector('#filter-active-days')?.addEventListener('input', e => {
      this.filterActiveDays = (e.target as HTMLInputElement).value;
      ctx.rerenderTab();
    });
    container.querySelector('#filter-created-days')?.addEventListener('input', e => {
      this.filterCreatedDays = (e.target as HTMLInputElement).value;
      ctx.rerenderTab();
    });

    container.querySelectorAll<HTMLElement>('.admin-table-sortable th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.sort as AccountSortColumn;
        if (this.sortColumn === col) {
          this.sortDir = this.sortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.sortColumn = col;
          this.sortDir = 'asc';
        }
        ctx.rerenderTab();
      });
    });

    container.querySelectorAll<HTMLAnchorElement>('.account-detail-link').forEach(link => {
      link.addEventListener('click', e => {
        e.preventDefault();
        const email = link.dataset.email!;
        const account = ctx.accounts.find(a => a.email === email);
        if (account) this.showDetailModal(account, ctx);
      });
    });

    container.querySelectorAll<HTMLSelectElement>('.account-class-select').forEach(sel => {
      sel.addEventListener('change', () => {
        this.changeClass(sel, ctx);
      });
    });

    container.querySelector('#master-reset-btn')?.addEventListener('click', async () => {
      const input = prompt('Type "IT ALL MUST END" to confirm master reset:');
      if (input !== 'IT ALL MUST END') return;
      try {
        const data = await postAdmin<{ playersReset: number }>('/api/admin/master-reset', { confirmation: input });
        alert(`Master reset complete: ${data.playersReset} players reset`);
        await ctx.refresh();
      } catch (err) {
        alert('Master reset failed: ' + (err instanceof Error ? err.message : err));
      }
    });
  }

  private async changeClass(sel: HTMLSelectElement, ctx: AdminContext): Promise<void> {
    const username = sel.dataset.username!;
    const className = sel.value;
    const account = ctx.accounts.find(a => a.username === username);
    if (!confirm(`Change ${username}'s class to ${className}? Their equipment will be unequipped.`)) {
      if (account?.className) sel.value = account.className;
      return;
    }
    try {
      await postAdmin(`/api/admin/players/${encodeURIComponent(username)}/class`, { className });
      await ctx.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : 'Network error — could not change class');
      if (account?.className) sel.value = account.className;
    }
  }

  private getFiltered(accounts: AccountData[]): AccountData[] {
    let filtered = [...accounts];
    if (!this.filterShowNoChar) {
      filtered = filtered.filter(a => a.username && a.className);
    }
    if (!this.filterShowBanned) {
      filtered = filtered.filter(a => !a.deactivated);
    }
    const activeDays = parseInt(this.filterActiveDays);
    if (!isNaN(activeDays) && activeDays > 0) {
      const cutoff = Date.now() - activeDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(a => a.lastActiveAt && new Date(a.lastActiveAt).getTime() >= cutoff);
    }
    const createdDays = parseInt(this.filterCreatedDays);
    if (!isNaN(createdDays) && createdDays > 0) {
      const cutoff = Date.now() - createdDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(a => new Date(a.createdAt).getTime() >= cutoff);
    }
    return filtered;
  }

  private getSortedAccounts(accounts: AccountData[]): AccountData[] {
    const sorted = this.getFiltered(accounts);
    const dir = this.sortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (this.sortColumn) {
        case 'username':
          cmp = (a.username ?? '').localeCompare(b.username ?? '');
          break;
        case 'email':
          cmp = a.email.localeCompare(b.email);
          break;
        case 'status':
          cmp = (a.isOnline ? 1 : 0) - (b.isOnline ? 1 : 0);
          break;
        case 'level':
          cmp = (a.level ?? 0) - (b.level ?? 0);
          break;
        case 'class':
          cmp = (a.className ?? '').localeCompare(b.className ?? '');
          break;
        case 'created':
          cmp = (a.createdAt ?? '').localeCompare(b.createdAt ?? '');
          break;
        case 'lastActive':
          cmp = (a.lastActiveAt ?? '').localeCompare(b.lastActiveAt ?? '');
          break;
      }
      return cmp * dir;
    });
    return sorted;
  }

  private sortIndicator(col: AccountSortColumn): string {
    if (this.sortColumn !== col) return '';
    return this.sortDir === 'asc' ? ' ▲' : ' ▼';
  }

  private showDetailModal(account: AccountData, ctx: AdminContext): void {
    const accountDuplicateTokens = new Set<string>();
    for (const [token, emails] of Object.entries(this.duplicateTokens)) {
      if (emails.includes(account.email)) accountDuplicateTokens.add(token);
    }
    const linkedAccounts = new Set<string>();
    for (const token of accountDuplicateTokens) {
      for (const email of this.duplicateTokens[token]) {
        if (email !== account.email) linkedAccounts.add(email);
      }
    }

    const sessionRows = (account.sessionHistory ?? []).map(s => {
      const isDuplicate = accountDuplicateTokens.has(s.deviceToken);
      return `
        <tr${isDuplicate ? ' class="account-row-duplicate"' : ''}>
          <td title="${escapeHtml(s.deviceToken)}">${escapeHtml(s.deviceToken.slice(0, 8))}…${isDuplicate ? ' <span class="status-banned" title="Shared with other accounts">DUP</span>' : ''}</td>
          <td>${escapeHtml(s.ip)}</td>
          <td title="${escapeHtml(s.userAgent)}">${escapeHtml(s.userAgent.slice(0, 40))}${s.userAgent.length > 40 ? '…' : ''}</td>
          <td>${new Date(s.timestamp).toLocaleString()}</td>
        </tr>
      `;
    }).join('');

    const linkedSection = linkedAccounts.size > 0
      ? `<div class="admin-warn-box">
          <strong>Shared device token with:</strong>
          <ul>${Array.from(linkedAccounts).map(email => {
            const linked = ctx.accounts.find(a => a.email === email);
            return `<li>${linked?.username ?? '<em>no username</em>'} (${escapeHtml(email)})</li>`;
          }).join('')}</ul>
        </div>`
      : '';

    const reactivationSection = account.reactivationRequest
      ? `<div class="admin-info-box">
          <strong>Reactivation Request:</strong>
          <p>${escapeHtml(account.reactivationRequest)}</p>
        </div>`
      : '';

    const actionBtn = account.deactivated
      ? `<button class="admin-btn" id="account-reactivate-btn">Reactivate Account</button>`
      : account.username
        ? `<button class="admin-btn admin-btn-danger" id="account-deactivate-btn">Suspend Account</button>`
        : '';

    const bodyHtml = `
      <dl class="admin-detail-list">
        <div><dt>Email</dt><dd>${escapeHtml(account.email)}</dd></div>
        <div><dt>Created</dt><dd>${new Date(account.createdAt).toLocaleString()}</dd></div>
        <div><dt>Last Active</dt><dd>${account.lastActiveAt ? new Date(account.lastActiveAt).toLocaleString() : '—'}</dd></div>
        <div><dt>Status</dt><dd>${account.isOnline ? '<span class="status-online">Online</span>' : '<span class="status-offline">Offline</span>'}${account.deactivated ? ' <span class="status-banned">SUSPENDED</span>' : ''}</dd></div>
        <div><dt>Class / Level</dt><dd>${account.className ?? '—'} Lv${account.level ?? '—'}</dd></div>
      </dl>
      <div class="admin-modal-actions">${actionBtn}</div>
      ${reactivationSection}
      ${linkedSection}
      <h4>Session History (last ${account.sessionHistory?.length ?? 0})</h4>
      ${sessionRows
        ? `<div class="admin-table-wrap admin-table-scroll">
            <table class="admin-table admin-table-compact">
              <thead><tr><th>Device Token</th><th>IP</th><th>User Agent</th><th>Time</th></tr></thead>
              <tbody>${sessionRows}</tbody>
            </table>
          </div>`
        : '<p class="admin-muted">No session history recorded yet.</p>'}
    `;

    const modal = openModal({
      title: `${escapeHtml(account.username ?? 'No username')} — Account Details`,
      bodyHtml,
      width: '720px',
    });

    modal.body.querySelector('#account-deactivate-btn')?.addEventListener('click', async () => {
      if (!confirm(`Suspend account "${account.username}"? This will kick them and prevent login.`)) return;
      try {
        await postAdmin(`/api/admin/players/${encodeURIComponent(account.username!)}/deactivate`, {});
        modal.close();
        await ctx.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to suspend');
      }
    });

    modal.body.querySelector('#account-reactivate-btn')?.addEventListener('click', async () => {
      if (!confirm(`Reactivate account "${account.username}"?`)) return;
      try {
        await postAdmin(`/api/admin/players/${encodeURIComponent(account.username!)}/reactivate`, {});
        modal.close();
        await ctx.refresh();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to reactivate');
      }
    });
  }
}
