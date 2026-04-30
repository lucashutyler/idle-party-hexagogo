import type { AdminContext } from './AdminContext';
import type {
  AccountData,
  ContentData,
  ContentVersion,
  OverviewData,
  TabId,
  UiSize,
} from './types';
import { TABS } from './types';
import { fetchAdmin } from './api';
import { applyUiSize, getUiSize, setUiSize } from './components/UiSize';
import { closeAllModals } from './components/Modal';

import type { Tab } from './tabs/Tab';
import { OverviewTab } from './tabs/OverviewTab';
import { AccountsTab } from './tabs/AccountsTab';
import { MonstersTab } from './tabs/MonstersTab';
import { ItemsTab } from './tabs/ItemsTab';
import { SetsTab } from './tabs/SetsTab';
import { ShopsTab } from './tabs/ShopsTab';
import { ZonesTab } from './tabs/ZonesTab';
import { EncountersTab } from './tabs/EncountersTab';
import { TileTypesTab } from './tabs/TileTypesTab';
import { MapTab } from './tabs/MapTab';
import { VersionsTab } from './tabs/VersionsTab';
import { XpTableTab } from './tabs/XpTableTab';

export class AdminApp implements AdminContext {
  private container: HTMLElement;
  private activeTab: TabId = 'overview';

  // Shared state (read-only via AdminContext)
  overview: OverviewData | null = null;
  accounts: AccountData[] = [];
  versions: ContentVersion[] = [];
  activeVersionId: string | null = null;
  selectedVersionId: string | null = null;
  versionContent: ContentData | null = null;

  private tabs: Record<TabId, Tab> = {
    'overview':   new OverviewTab(),
    'accounts':   new AccountsTab(),
    'monsters':   new MonstersTab(),
    'items':      new ItemsTab(),
    'sets':       new SetsTab(),
    'shops':      new ShopsTab(),
    'zones':      new ZonesTab(),
    'encounters': new EncountersTab(),
    'tile-types': new TileTypesTab(),
    'map':        new MapTab(),
    'versions':   new VersionsTab(),
    'xp-table':   new XpTableTab(),
  };

  constructor() {
    this.container = document.getElementById('admin-app')!;
    applyUiSize();
    this.init();
  }

  // ---- Lifecycle ----

  private async init(): Promise<void> {
    try {
      const sessionRes = await fetch('/auth/session', { credentials: 'include' });
      const session = await sessionRes.json();
      if (!session.authenticated) {
        this.renderUnauthenticated();
        return;
      }
    } catch {
      this.renderError('Could not reach server');
      return;
    }

    try {
      const [overview, accountsData, versionsData] = await Promise.all([
        fetchAdmin<OverviewData>('/api/admin/overview'),
        fetchAdmin<{ accounts: AccountData[] }>('/api/admin/accounts'),
        fetchAdmin<{ versions: ContentVersion[]; activeVersionId: string | null }>('/api/admin/versions'),
      ]);
      this.overview = overview;
      this.accounts = accountsData.accounts;
      this.versions = versionsData.versions;
      this.activeVersionId = versionsData.activeVersionId ?? null;

      const savedVersionId = sessionStorage.getItem('adminVersionId');
      const initialVersionId = (savedVersionId && this.versions.some(v => v.id === savedVersionId))
        ? savedVersionId
        : (this.activeVersionId ?? this.versions[0]?.id ?? null);
      if (initialVersionId) {
        await this.loadVersionContent(initialVersionId);
      }

      const tabFromUrl = this.getTabFromUrl();
      if (tabFromUrl) {
        this.activeTab = tabFromUrl;
      } else {
        const saved = sessionStorage.getItem('adminTab') as TabId | null;
        if (saved && TABS.some(t => t.id === saved)) this.activeTab = saved;
      }

      const handleNavigation = () => {
        const tab = this.getTabFromUrl();
        if (tab && tab !== this.activeTab) {
          this.tabs[this.activeTab].cleanup?.();
          this.activeTab = tab;
          this.refreshSidebarActive();
          this.rerenderTab();
        }
      };
      window.addEventListener('popstate', handleNavigation);
      window.addEventListener('hashchange', handleNavigation);

      this.renderShell();
    } catch (err) {
      if (err instanceof Error && err.message.includes('403')) {
        this.renderForbidden();
      } else {
        this.renderError(err instanceof Error ? err.message : 'Unknown error');
      }
    }
  }

  // ---- AdminContext methods ----

  getDisplayContent(): ContentData | null {
    return this.versionContent;
  }

  isReadOnly(): boolean {
    const version = this.versions.find(v => v.id === this.selectedVersionId);
    return !version || version.status !== 'draft';
  }

  versionQueryParam(): string {
    if (this.selectedVersionId) {
      const version = this.versions.find(v => v.id === this.selectedVersionId);
      if (version?.status === 'draft') return `?versionId=${this.selectedVersionId}`;
    }
    return '';
  }

  async refresh(): Promise<void> {
    try {
      const [overview, accountsData] = await Promise.all([
        fetchAdmin<OverviewData>('/api/admin/overview'),
        fetchAdmin<{ accounts: AccountData[] }>('/api/admin/accounts'),
      ]);
      this.overview = overview;
      this.accounts = accountsData.accounts;
      this.rerenderTab();
    } catch {
      // Silently fail — keep stale data on screen.
    }
  }

  async refreshVersions(): Promise<void> {
    try {
      const data = await fetchAdmin<{ versions: ContentVersion[]; activeVersionId: string | null }>('/api/admin/versions');
      this.versions = data.versions;
      this.activeVersionId = data.activeVersionId ?? null;
    } catch { /* keep stale */ }
  }

  async selectVersion(id: string): Promise<void> {
    await this.loadVersionContent(id);
    this.refreshStatusBar();
    this.rerenderTab();
  }

  rerenderTab(): void {
    const content = document.getElementById('admin-content');
    if (!content) return;
    const tab = this.tabs[this.activeTab];
    tab.render(content, this);
  }

  patchVersionContent(patch: Partial<ContentData>): void {
    if (this.versionContent) {
      this.versionContent = { ...this.versionContent, ...patch };
    }
  }

  refreshStatusBar(): void {
    const bar = document.getElementById('admin-status-bar');
    if (bar) bar.outerHTML = this.renderStatusBar();
    this.wireStatusBar();
  }

  // ---- Rendering ----

  private renderShell(): void {
    const sidebarItems = TABS.map(t => `
      <button class="admin-sidebar-btn${t.id === this.activeTab ? ' active' : ''}" data-tab="${t.id}">
        <span class="admin-sidebar-icon">${t.icon}</span>
        <span class="admin-sidebar-label">${t.label}</span>
      </button>
    `).join('');

    this.container.innerHTML = `
      <div class="admin-shell">
        <header class="admin-topbar">
          <button class="admin-sidebar-toggle" id="admin-sidebar-toggle" aria-label="Toggle navigation">
            <span></span><span></span><span></span>
          </button>
          <div class="admin-topbar-title">World Manager</div>
          ${this.renderStatusBar()}
        </header>
        <div class="admin-shell-body">
          <div class="admin-sidebar-backdrop" id="admin-sidebar-backdrop"></div>
          <nav class="admin-sidebar" id="admin-sidebar">
            ${sidebarItems}
            <div class="admin-sidebar-spacer"></div>
            ${this.renderUiSizeSelector()}
            <button class="admin-sidebar-btn" id="admin-refresh">
              <span class="admin-sidebar-icon">↻</span>
              <span class="admin-sidebar-label">Refresh</span>
            </button>
            <a href="/" class="admin-sidebar-btn" target="_blank" rel="noopener">
              <span class="admin-sidebar-icon">↗</span>
              <span class="admin-sidebar-label">Game</span>
            </a>
          </nav>
          <main class="admin-content" id="admin-content"></main>
        </div>
      </div>
    `;

    // Wire sidebar nav
    this.container.querySelectorAll<HTMLButtonElement>('.admin-sidebar-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = btn.dataset.tab as TabId;
        this.switchTab(tabId);
        this.closeMobileSidebar();
      });
    });

    document.getElementById('admin-refresh')?.addEventListener('click', () => this.refresh());

    document.getElementById('admin-sidebar-toggle')?.addEventListener('click', () => this.toggleMobileSidebar());
    document.getElementById('admin-sidebar-backdrop')?.addEventListener('click', () => this.closeMobileSidebar());

    this.wireStatusBar();
    this.wireUiSizeSelector();

    // Set URL to reflect initial tab.
    const isDev = window.location.pathname.includes('admin.html');
    if (isDev) {
      if (!window.location.hash) window.location.hash = this.activeTab;
    } else {
      const url = `/admin/${this.activeTab}`;
      if (window.location.pathname !== url) history.replaceState(null, '', url);
    }

    this.rerenderTab();
  }

  private renderStatusBar(): string {
    const version = this.versions.find(v => v.id === this.selectedVersionId) ?? null;
    const isDraft = version?.status === 'draft';
    const isActive = !!version?.isActive;
    const isPublished = version?.status === 'published' && !isActive;

    const statusBadge = !version
      ? '<span class="version-badge version-badge-none">No version</span>'
      : isActive
        ? '<span class="version-badge version-badge-active">Active</span>'
        : isPublished
          ? '<span class="version-badge version-badge-published">Published</span>'
          : '<span class="version-badge version-badge-draft">Draft</span>';

    const versionOptions = this.versions.map(v => {
      const tag = v.isActive ? '★' : v.status === 'draft' ? '✎' : '✓';
      return `<option value="${v.id}"${v.id === this.selectedVersionId ? ' selected' : ''}>${tag} ${this.escapeAttr(v.name)}</option>`;
    }).join('');

    const publishBtn = isDraft
      ? '<button class="admin-btn admin-btn-sm" id="status-publish-btn">Publish</button>'
      : '';
    const deployBtn = isPublished
      ? '<button class="admin-btn admin-btn-sm admin-btn-primary" id="status-deploy-btn">Deploy</button>'
      : '';
    const newDraftBtn = '<button class="admin-btn admin-btn-sm admin-btn-secondary" id="status-new-draft-btn">+ New Draft</button>';

    return `
      <div id="admin-status-bar" class="admin-status-bar">
        <label class="admin-status-version">
          <span class="admin-status-label">Version</span>
          <select id="status-version-select">
            ${versionOptions || '<option>(none)</option>'}
          </select>
        </label>
        ${statusBadge}
        ${publishBtn}
        ${deployBtn}
        ${newDraftBtn}
      </div>
    `;
  }

  private wireStatusBar(): void {
    const select = document.getElementById('status-version-select') as HTMLSelectElement | null;
    select?.addEventListener('change', () => this.selectVersion(select.value));

    document.getElementById('status-publish-btn')?.addEventListener('click', async () => {
      if (!this.selectedVersionId) return;
      if (!confirm('Publish this draft? It will become immutable.')) return;
      try {
        await fetch(`/api/admin/versions/${this.selectedVersionId}/publish`, {
          method: 'POST',
          credentials: 'include',
        });
        await this.refreshVersions();
        this.refreshStatusBar();
        this.rerenderTab();
      } catch {
        alert('Failed to publish');
      }
    });

    document.getElementById('status-deploy-btn')?.addEventListener('click', async () => {
      if (!this.selectedVersionId) return;
      const version = this.versions.find(v => v.id === this.selectedVersionId);
      if (!confirm(`Deploy "${version?.name ?? ''}" to the live game? Players on removed rooms will be relocated.`)) return;
      try {
        const res = await fetch(`/api/admin/versions/${this.selectedVersionId}/deploy`, {
          method: 'POST',
          credentials: 'include',
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to deploy');
        alert(`Deployed! ${data.relocated ?? 0} parties relocated.`);
        await this.refreshVersions();
        this.refreshStatusBar();
        this.rerenderTab();
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to deploy');
      }
    });

    document.getElementById('status-new-draft-btn')?.addEventListener('click', async () => {
      const seed = this.versions.find(v => v.id === this.selectedVersionId)?.name ?? '';
      const name = prompt('Draft name:', seed ? `${seed} (copy)` : '');
      if (!name) return;
      try {
        const res = await fetch('/api/admin/versions', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name, fromVersionId: this.selectedVersionId ?? this.activeVersionId }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to create draft');
        await this.refreshVersions();
        if (data.version?.id) {
          // Auto-select the new draft so the UI immediately enters edit mode.
          await this.selectVersion(data.version.id);
        } else {
          this.refreshStatusBar();
          this.rerenderTab();
        }
      } catch (err) {
        alert(err instanceof Error ? err.message : 'Failed to create draft');
      }
    });
  }

  private renderUiSizeSelector(): string {
    const current = getUiSize();
    const sizes: { id: UiSize; label: string }[] = [
      { id: 'small',  label: 'S' },
      { id: 'medium', label: 'M' },
      { id: 'large',  label: 'L' },
      { id: 'xlarge', label: 'XL' },
    ];
    const buttons = sizes.map(s => `
      <button class="admin-ui-size-btn${s.id === current ? ' active' : ''}" data-size="${s.id}" type="button">${s.label}</button>
    `).join('');
    return `
      <div class="admin-ui-size">
        <span class="admin-ui-size-label">UI Size</span>
        <div class="admin-ui-size-row">${buttons}</div>
      </div>
    `;
  }

  private wireUiSizeSelector(): void {
    this.container.querySelectorAll<HTMLButtonElement>('.admin-ui-size-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const size = btn.dataset.size as UiSize;
        setUiSize(size);
        this.container.querySelectorAll('.admin-ui-size-btn').forEach(b => b.classList.toggle('active', b === btn));
      });
    });
  }

  private toggleMobileSidebar(): void {
    document.body.classList.toggle('admin-sidebar-open');
  }
  private closeMobileSidebar(): void {
    document.body.classList.remove('admin-sidebar-open');
  }

  private refreshSidebarActive(): void {
    this.container.querySelectorAll<HTMLElement>('.admin-sidebar-btn[data-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.tab === this.activeTab);
    });
  }

  private switchTab(tabId: TabId): void {
    if (tabId === this.activeTab) return;
    this.tabs[this.activeTab].cleanup?.();
    closeAllModals();
    this.activeTab = tabId;
    sessionStorage.setItem('adminTab', tabId);
    this.pushTabUrl(tabId);
    this.refreshSidebarActive();
    this.rerenderTab();
  }

  private getTabFromUrl(): TabId | null {
    const path = window.location.pathname;
    const match = path.match(/\/admin\/(\w[\w-]*)/) ?? path.match(/\/admin\.html#(\w[\w-]*)/);
    if (match) {
      const candidate = match[1] as TabId;
      if (TABS.some(t => t.id === candidate)) return candidate;
    }
    if (window.location.hash) {
      const hashTab = window.location.hash.replace('#', '') as TabId;
      if (TABS.some(t => t.id === hashTab)) return hashTab;
    }
    return null;
  }

  private pushTabUrl(tabId: TabId): void {
    const isDev = window.location.pathname.includes('admin.html');
    if (isDev) {
      window.location.hash = tabId;
    } else {
      const url = `/admin/${tabId}`;
      if (window.location.pathname !== url) history.pushState(null, '', url);
    }
  }

  private async loadVersionContent(versionId: string): Promise<void> {
    this.selectedVersionId = versionId;
    sessionStorage.setItem('adminVersionId', versionId);
    try {
      this.versionContent = await fetchAdmin<ContentData>(`/api/admin/versions/${versionId}/content`);
    } catch {
      this.versionContent = null;
    }
  }

  // ---- Error / unauth states ----

  private renderUnauthenticated(): void {
    this.container.innerHTML = `
      <div class="admin-center-message">
        <h1>World Manager</h1>
        <p>You must be logged in to access the World Manager.</p>
        <p><a href="/" target="_blank" rel="noopener">Go to login</a></p>
      </div>
    `;
  }

  private renderForbidden(): void {
    this.container.innerHTML = `
      <div class="admin-center-message">
        <h1>World Manager</h1>
        <p>Access denied. Your account is not authorized as an admin.</p>
        <p><a href="/" target="_blank" rel="noopener">Back to game</a></p>
      </div>
    `;
  }

  private renderError(message: string): void {
    this.container.innerHTML = `
      <div class="admin-center-message">
        <h1>World Manager</h1>
        <p>Error: ${message}</p>
        <button class="admin-btn" onclick="location.reload()">Retry</button>
      </div>
    `;
  }

  private escapeAttr(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  }
}
