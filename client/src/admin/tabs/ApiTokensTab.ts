import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import type { ApiTokenData } from '../types';
import { escapeHtml, fetchAdmin, postAdmin, deleteAdmin, formatRelativeTime } from '../api';
import { openModal } from '../components/Modal';

/**
 * Your own API tokens — bearer credentials for the MCP content-authoring server and the REST
 * admin API. Always scoped to the signed-in admin: there is no way to see or revoke anyone
 * else's. A token is only as good as its owner's admin role, which is re-checked on every use.
 */
export class ApiTokensTab implements Tab {
  private tokens: ApiTokenData[] = [];
  private loaded = false;

  render(container: HTMLElement, ctx: AdminContext): void {
    const rows = this.tokens.map(t => {
      const expiry = t.expiresAt
        ? `${new Date(t.expiresAt).toLocaleDateString()}${t.expired ? ' <span class="admin-pill">expired</span>' : ''}`
        : '<span class="admin-muted">never</span>';
      return `
        <tr${t.expired ? ' class="admin-row-disabled"' : ''}>
          <td>${escapeHtml(t.label)}</td>
          <td><code>${escapeHtml(t.prefix)}…</code></td>
          <td title="${new Date(t.createdAt).toLocaleString()}">${new Date(t.createdAt).toLocaleDateString()}</td>
          <td>${expiry}</td>
          <td title="${t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : ''}">${formatRelativeTime(t.lastUsedAt)}</td>
          <td><button class="admin-btn admin-btn-sm admin-btn-danger token-revoke-btn" data-id="${escapeHtml(t.id)}" data-label="${escapeHtml(t.label)}">Revoke</button></td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>API Tokens <span class="admin-count-badge">${this.tokens.length}</span></h2>
        </div>
        <p class="admin-page-subtitle">
          Bearer tokens for the MCP content-authoring server and the admin API. These are yours alone —
          nobody else can see or revoke them, and you can't see anyone else's. A token carries no
          permissions of its own: it works only while your account still has an admin role, so losing
          admin silently disables every token you hold.
        </p>
        <div class="admin-filter-bar">
          <label class="admin-inline-field">
            Label
            <input type="text" id="token-label-input" placeholder="laptop MCP" maxlength="60">
          </label>
          <label class="admin-inline-field">
            Expires
            <input type="date" id="token-expiry-input">
          </label>
          <button class="admin-btn admin-btn-primary" id="token-generate-btn">Generate Token</button>
          <span class="admin-muted">Leave the date empty for a token that never expires.</span>
        </div>
        <div class="admin-table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Label</th><th>Token</th><th>Created</th><th>Expires</th><th>Last used</th><th></th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="6"><em>No API tokens yet</em></td></tr>'}</tbody>
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
    const labelInput = container.querySelector<HTMLInputElement>('#token-label-input');
    const expiryInput = container.querySelector<HTMLInputElement>('#token-expiry-input');

    const generate = async () => {
      const label = labelInput?.value.trim();
      if (!label) {
        alert('Give the token a label so you can tell it apart later.');
        return;
      }
      try {
        const res = await postAdmin<{ token: string; tokens: ApiTokenData[] }>('/api/admin/api-tokens', {
          label,
          expiresAt: expiryInput?.value || null,
        });
        this.tokens = res.tokens;
        this.loaded = true;
        if (labelInput) labelInput.value = '';
        if (expiryInput) expiryInput.value = '';
        ctx.rerenderTab();
        this.showSecretModal(label, res.token);
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to generate token');
      }
    };

    container.querySelector('#token-generate-btn')?.addEventListener('click', generate);
    labelInput?.addEventListener('keydown', e => {
      if (e.key === 'Enter') generate();
    });

    container.querySelectorAll<HTMLButtonElement>('.token-revoke-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { id, label } = btn.dataset;
        if (!confirm(`Revoke "${label}"? Anything using this token stops working immediately.`)) return;
        try {
          const res = await deleteAdmin<{ tokens: ApiTokenData[] }>(`/api/admin/api-tokens/${encodeURIComponent(id!)}`);
          this.tokens = res.tokens;
          ctx.rerenderTab();
        } catch (err) {
          alert(err instanceof Error ? err.message : 'Failed to revoke token');
        }
      });
    });
  }

  /** The one and only time the secret is visible — it's stored hashed and can't be shown again. */
  private showSecretModal(label: string, token: string): void {
    const mcpConfig = JSON.stringify({
      mcpServers: {
        'idle-party-rpg': {
          type: 'http',
          url: `${window.location.origin}/mcp`,
          headers: { Authorization: `Bearer ${token}` },
        },
      },
    }, null, 2);

    const modal = openModal({
      title: `${escapeHtml(label)} — copy your token now`,
      bodyHtml: `
        <div class="admin-warn-box">
          This is the only time this token will be shown. Store it somewhere safe — if you lose it,
          revoke it and generate a new one.
        </div>
        <div class="token-secret-block">
          <label class="admin-form-label-text" for="token-secret-value">Token</label>
          <input type="text" id="token-secret-value" class="token-secret-input" readonly value="${escapeHtml(token)}">
          <div class="admin-modal-actions">
            <button class="admin-btn admin-btn-primary" id="token-copy-btn">Copy token</button>
          </div>
        </div>
        <div class="token-secret-block">
          <span class="admin-form-label-text">MCP client config</span>
          <pre class="token-config-block"><code>${escapeHtml(mcpConfig)}</code></pre>
          <div class="admin-modal-actions">
            <button class="admin-btn" id="token-copy-config-btn">Copy config</button>
          </div>
        </div>
      `,
      width: '640px',
    });

    const copy = async (text: string, btn: HTMLButtonElement | null) => {
      if (!btn) return;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(text);
        btn.textContent = 'Copied!';
      } catch {
        btn.textContent = 'Press Ctrl+C to copy';
      }
      setTimeout(() => { btn.textContent = original; }, 2000);
    };

    const secretInput = modal.body.querySelector<HTMLInputElement>('#token-secret-value');
    secretInput?.addEventListener('focus', () => secretInput.select());

    const copyBtn = modal.body.querySelector<HTMLButtonElement>('#token-copy-btn');
    copyBtn?.addEventListener('click', () => {
      secretInput?.select();
      copy(token, copyBtn);
    });

    const copyConfigBtn = modal.body.querySelector<HTMLButtonElement>('#token-copy-config-btn');
    copyConfigBtn?.addEventListener('click', () => copy(mcpConfig, copyConfigBtn));
  }

  private async refresh(ctx: AdminContext): Promise<void> {
    try {
      const data = await fetchAdmin<{ tokens: ApiTokenData[] }>('/api/admin/api-tokens');
      this.tokens = data.tokens;
      this.loaded = true;
      ctx.rerenderTab();
    } catch {
      // keep stale
    }
  }
}
