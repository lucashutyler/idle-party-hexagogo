import {
  HexTile,
  offsetToCube,
  cubeToPixel,
  pixelToCube,
  cubeToOffset,
  cubeEquals,
  getHexCorners,
  getNeighbors,
  getNeighbor,
  TILE_CONFIGS,
  HEX_SIZE,
  xpForNextLevel,
  EQUIP_SLOTS,
  DISPLAY_EQUIP_SLOTS,
  ALL_CLASS_NAMES,
  MONSTER_SKILL_CATALOG,
  getSetBonusText,
} from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  ItemDefinition,
  ItemRarity,
  EquipSlot,
  ZoneDefinition,
  EncounterTableEntry,
  EncounterDefinition,
  RandomMonsterEntry,
  ExplicitPlacement,
  WorldTileDefinition,
  WorldData,
  CubeCoord,
  DamageType,
  Resistance,
  MonsterSkillEntry,
  SetDefinition,
  SetBonuses,
  ShopDefinition,
  ShopItem,
  TileTypeDefinition,
} from '@idle-party-rpg/shared';

// Maps CUBE_DIRECTIONS index → hex corner indices for the shared edge.
// For flat-top hexes: corners at 0°,60°,...,300° (CW in screen) and
// directions: 0=SE-screen,1=NE,2=N,3=NW,4=SW,5=S.
const DIR_TO_EDGE: [number, number][] = [
  [0, 1], // dir 0 (East/SE-screen)
  [5, 0], // dir 1 (NE)
  [4, 5], // dir 2 (NW/N-screen)
  [3, 4], // dir 3 (West/NW-screen)
  [2, 3], // dir 4 (SW)
  [1, 2], // dir 5 (SE/S-screen)
];

interface OverviewData {
  onlinePlayers: number;
  totalSessions: number;
  totalConnections: number;
  totalAccounts: number;
  uptime: number;
}

interface SessionRecord {
  deviceToken: string;
  ip: string;
  userAgent: string;
  timestamp: string;
}

interface AccountData {
  email: string;
  username: string | null;
  verified: boolean;
  createdAt: string;
  lastActiveAt: string | null;
  isOnline: boolean;
  className: string | null;
  level: number | null;
  deactivated: boolean;
  hasReactivationRequest: boolean;
  reactivationRequest: string | null;
  sessionHistory: SessionRecord[];
}

type AccountSortColumn = 'username' | 'email' | 'status' | 'level' | 'class' | 'created' | 'lastActive';
type SortDirection = 'asc' | 'desc';

interface ContentData {
  monsters: Record<string, MonsterDefinition>;
  items: Record<string, ItemDefinition>;
  zones: Record<string, ZoneDefinition>;
  encounters: Record<string, EncounterDefinition>;
  sets: Record<string, SetDefinition>;
  shops: Record<string, ShopDefinition>;
  tileTypes: Record<string, TileTypeDefinition>;
  world: WorldData;
}

interface ContentVersion {
  id: string;
  name: string;
  status: 'draft' | 'published';
  isActive: boolean;
  createdAt: string;
  createdFrom: string | null;
  publishedAt: string | null;
}

type TabId = 'overview' | 'accounts' | 'monsters' | 'items' | 'sets' | 'shops' | 'zones' | 'encounters' | 'tile-types' | 'map' | 'versions' | 'xp-table';

interface TabDef {
  id: TabId;
  label: string;
  icon: string;
}

const TABS: TabDef[] = [
  { id: 'overview', label: 'Overview', icon: '~' },
  { id: 'accounts', label: 'Accounts', icon: '@' },
  { id: 'monsters', label: 'Monsters', icon: '!' },
  { id: 'items', label: 'Items', icon: '+' },
  { id: 'sets', label: 'Sets', icon: 'S' },
  { id: 'shops', label: 'Shops', icon: '$' },
  { id: 'zones', label: 'Zones', icon: '#' },
  { id: 'encounters', label: 'Encounters', icon: 'E' },
  { id: 'tile-types', label: 'Tile Types', icon: 'T' },
  { id: 'map', label: 'Map', icon: '*' },
  { id: 'versions', label: 'Versions', icon: 'V' },
  { id: 'xp-table', label: 'XP Table', icon: 'X' },
];


/** Adjacent empty hex position where a new tile can be added. */
interface AdjacentSlot {
  col: number;
  row: number;
  coord: CubeCoord;
}

export class AdminApp {
  private container: HTMLElement;
  private activeTab: TabId = 'overview';
  private overview: OverviewData | null = null;
  private accounts: AccountData[] = [];
  private accountSortColumn: AccountSortColumn = 'lastActive';
  private accountSortDir: SortDirection = 'desc';
  private accountFilterShowNoChar = false;
  private accountFilterShowBanned = false;
  private accountFilterActiveDays = '';
  private accountFilterCreatedDays = '';
  private duplicateTokens: Record<string, string[]> = {}; // deviceToken → emails
  private activeVersionId: string | null = null;
  private itemSlotFilter: string = 'all';
  private mapTiles: HexTile[] = [];

  /** World tile definitions for room name lookups. */
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  // Map canvas state
  private mapCanvas: HTMLCanvasElement | null = null;
  private mapCtx: CanvasRenderingContext2D | null = null;
  private mapOffset = { x: 0, y: 0 };
  private mapZoom = 1.0;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragOffsetStart = { x: 0, y: 0 };
  private mapInitialized = false;
  private resizeHandler: (() => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseUpHandler: (() => void) | null = null;

  // Version state
  private versions: ContentVersion[] = [];
  private selectedVersionId: string | null = null;
  private versionContent: ContentData | null = null;

  // Map editor state
  private selectedTile: WorldTileDefinition | null = null;
  private adjacentSlots: AdjacentSlot[] = [];
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;
  private hasDragged = false;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;

  constructor() {
    this.container = document.getElementById('admin-app')!;
    this.init();
  }

  private async init(): Promise<void> {
    // Check auth
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

    // Fetch admin data
    try {
      const [overview, accountsData, versionsData] = await Promise.all([
        this.fetchAdmin<OverviewData>('/api/admin/overview'),
        this.fetchAdmin<{ accounts: AccountData[] }>('/api/admin/accounts'),
        this.fetchAdmin<{ versions: ContentVersion[]; activeVersionId: string | null }>('/api/admin/versions'),
      ]);

      this.overview = overview;
      this.accounts = accountsData.accounts;
      this.versions = versionsData.versions;
      this.activeVersionId = versionsData.activeVersionId ?? null;

      // Restore version from sessionStorage, or default to active version
      const savedVersionId = sessionStorage.getItem('adminVersionId');
      const initialVersionId = (savedVersionId && this.versions.some(v => v.id === savedVersionId))
        ? savedVersionId
        : (this.activeVersionId ?? this.versions[0]?.id ?? null);
      if (initialVersionId) {
        await this.selectVersion(initialVersionId);
      }

      // Restore tab from URL path, falling back to sessionStorage
      const tabFromUrl = this.getTabFromUrl();
      if (tabFromUrl) {
        this.activeTab = tabFromUrl;
      } else {
        const saved = sessionStorage.getItem('adminTab') as TabId | null;
        if (saved && TABS.some(t => t.id === saved)) {
          this.activeTab = saved;
        }
      }

      // Listen for browser back/forward navigation
      const handleNavigation = () => {
        const tab = this.getTabFromUrl();
        if (tab && tab !== this.activeTab) {
          if (this.activeTab === 'map') this.cleanupMapCanvas();
          this.activeTab = tab;
          this.container.querySelectorAll('.admin-sidebar-btn[data-tab]').forEach(btn => {
            const el = btn as HTMLElement;
            el.classList.toggle('active', el.dataset.tab === tab);
          });
          this.renderTabContent();
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

  private async fetchAdmin<T>(url: string): Promise<T> {
    const res = await fetch(url, { credentials: 'include' });
    if (res.status === 401) throw new Error('Not authenticated');
    if (res.status === 403) throw new Error('403 Not authorized');
    if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);
    return res.json();
  }

  private async refresh(): Promise<void> {
    try {
      const [overview, accountsData] = await Promise.all([
        this.fetchAdmin<OverviewData>('/api/admin/overview'),
        this.fetchAdmin<{ accounts: AccountData[] }>('/api/admin/accounts'),
      ]);
      this.overview = overview;
      this.accounts = accountsData.accounts;
      this.renderTabContent();
    } catch {
      // Silently fail refresh — data stays stale
    }
  }

  /** Find all empty hex positions adjacent to existing tiles. */
  private computeAdjacentSlots(): void {
    const occupied = new Set<string>();
    for (const tile of this.mapTiles) {
      const offset = cubeToOffset(tile.coord);
      occupied.add(`${offset.col},${offset.row}`);
    }

    const adjacent = new Map<string, AdjacentSlot>();
    for (const tile of this.mapTiles) {
      const neighbors = getNeighbors(tile.coord);
      for (const neighborCoord of neighbors) {
        const offset = cubeToOffset(neighborCoord);
        const key = `${offset.col},${offset.row}`;
        if (!occupied.has(key) && !adjacent.has(key)) {
          adjacent.set(key, { col: offset.col, row: offset.row, coord: neighborCoord });
        }
      }
    }
    this.adjacentSlots = Array.from(adjacent.values());
  }

  // --- Shell ---

  private renderShell(): void {
    const sidebarItems = TABS.map(t => `
      <button class="admin-sidebar-btn${t.id === this.activeTab ? ' active' : ''}" data-tab="${t.id}">
        <span class="admin-sidebar-icon">${t.icon}</span>
        <span class="admin-sidebar-label">${t.label}</span>
      </button>
    `).join('');

    this.container.innerHTML = `
      <div class="admin-shell">
        <nav class="admin-sidebar">
          <div class="admin-sidebar-title">World Manager</div>
          ${sidebarItems}
          <div class="admin-sidebar-spacer"></div>
          <button class="admin-sidebar-btn" id="admin-refresh">
            <span class="admin-sidebar-icon">&lt;</span>
            <span class="admin-sidebar-label">Refresh</span>
          </button>
          <a href="/" class="admin-sidebar-btn">
            <span class="admin-sidebar-icon">&gt;</span>
            <span class="admin-sidebar-label">Game</span>
          </a>
        </nav>
        <main class="admin-content" id="admin-content"></main>
      </div>
    `;

    // Wire sidebar clicks
    this.container.querySelectorAll('.admin-sidebar-btn[data-tab]').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabId = (btn as HTMLElement).dataset.tab as TabId;
        this.switchTab(tabId);
      });
    });

    document.getElementById('admin-refresh')?.addEventListener('click', () => this.refresh());

    // Set URL to reflect initial tab (use replaceState to avoid extra history entry)
    const isDev = window.location.pathname.includes('admin.html');
    if (isDev) {
      if (!window.location.hash) window.location.hash = this.activeTab;
    } else {
      const url = `/admin/${this.activeTab}`;
      if (window.location.pathname !== url) {
        history.replaceState(null, '', url);
      }
    }

    this.renderTabContent();
  }

  /** Extract the active tab from the URL path (e.g. /admin/sets → 'sets'). */
  private getTabFromUrl(): TabId | null {
    const path = window.location.pathname;
    // Match /admin/{tab} or /admin.html#{tab} (dev mode)
    const match = path.match(/\/admin\/(\w[\w-]*)/) ?? path.match(/\/admin\.html#(\w[\w-]*)/);
    if (match) {
      const candidate = match[1] as TabId;
      if (TABS.some(t => t.id === candidate)) return candidate;
    }
    // Also check hash for dev mode
    if (window.location.hash) {
      const hashTab = window.location.hash.replace('#', '') as TabId;
      if (TABS.some(t => t.id === hashTab)) return hashTab;
    }
    return null;
  }

  /** Update the URL to reflect the current tab. */
  private pushTabUrl(tabId: TabId): void {
    // In dev mode (Vite on admin.html), use hash routing
    // In prod mode (/admin/*), use path routing
    const isDev = window.location.pathname.includes('admin.html');
    if (isDev) {
      window.location.hash = tabId;
    } else {
      const url = `/admin/${tabId}`;
      if (window.location.pathname !== url) {
        history.pushState(null, '', url);
      }
    }
  }

  private switchTab(tabId: TabId): void {
    if (tabId === this.activeTab) return;

    // Clean up map if leaving map tab
    if (this.activeTab === 'map') {
      this.cleanupMapCanvas();
    }

    this.activeTab = tabId;
    sessionStorage.setItem('adminTab', tabId);
    this.pushTabUrl(tabId);

    // Update active class on sidebar buttons
    this.container.querySelectorAll('.admin-sidebar-btn[data-tab]').forEach(btn => {
      const el = btn as HTMLElement;
      el.classList.toggle('active', el.dataset.tab === tabId);
    });

    this.renderTabContent();
  }

  private renderTabContent(): void {
    const content = document.getElementById('admin-content');
    if (!content) return;

    switch (this.activeTab) {
      case 'overview':
        content.innerHTML = this.renderOverview();
        break;
      case 'accounts':
        content.innerHTML = this.renderAccounts();
        this.wireAccountEvents();
        break;
      case 'monsters':
        content.innerHTML = this.renderMonsters();
        this.wireMonsterEvents();
        break;
      case 'items':
        content.innerHTML = this.renderItems();
        this.wireItemEvents();
        break;
      case 'sets':
        content.innerHTML = this.renderSets();
        this.wireSetsEvents();
        break;
      case 'shops':
        content.innerHTML = this.renderShops();
        this.wireShopsEvents();
        break;
      case 'zones':
        content.innerHTML = this.renderZones();
        this.wireZoneEvents();
        break;
      case 'encounters':
        content.innerHTML = this.renderEncounters();
        this.wireEncounterEvents();
        break;
      case 'tile-types':
        content.innerHTML = this.renderTileTypes();
        this.wireTileTypeEvents();
        break;
      case 'map':
        content.innerHTML = this.renderMapSection();
        this.initMapCanvas();
        this.renderSidebar();
        break;
      case 'versions':
        content.innerHTML = this.renderVersions();
        this.wireVersionEvents();
        break;
      case 'xp-table':
        content.innerHTML = this.renderXpTable();
        break;
    }
  }

  // --- Error/auth states ---

  private renderUnauthenticated(): void {
    this.container.innerHTML = `
      <div class="admin-shell">
        <div class="admin-center-message pixel-panel">
          <h1>World Manager</h1>
          <p>You must be logged in to access the World Manager.</p>
          <p><a href="/">Go to login</a></p>
        </div>
      </div>
    `;
  }

  private renderForbidden(): void {
    this.container.innerHTML = `
      <div class="admin-shell">
        <div class="admin-center-message pixel-panel">
          <h1>World Manager</h1>
          <p>Access denied. Your account is not authorized as an admin.</p>
          <p><a href="/">Back to game</a></p>
        </div>
      </div>
    `;
  }

  private renderError(message: string): void {
    this.container.innerHTML = `
      <div class="admin-shell">
        <div class="admin-center-message pixel-panel">
          <h1>World Manager</h1>
          <p>Error: ${message}</p>
          <button class="admin-btn" onclick="location.reload()">Retry</button>
        </div>
      </div>
    `;
  }

  // --- Tab renderers ---

  private renderOverview(): string {
    if (!this.overview) return '<div class="admin-page-empty">No data</div>';
    const data = this.overview;

    const hours = Math.floor(data.uptime / 3600);
    const mins = Math.floor((data.uptime % 3600) / 60);
    const uptimeStr = hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Server Overview</h2></div>
        <div class="admin-stats pixel-panel">
          <div class="admin-stat">
            <span class="admin-stat-value">${data.onlinePlayers}</span>
            <span class="admin-stat-label">Online</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-value">${data.totalAccounts}</span>
            <span class="admin-stat-label">Accounts</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-value">${data.totalSessions}</span>
            <span class="admin-stat-label">Sessions</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-value">${data.totalConnections}</span>
            <span class="admin-stat-label">Connections</span>
          </div>
          <div class="admin-stat">
            <span class="admin-stat-value">${uptimeStr}</span>
            <span class="admin-stat-label">Uptime</span>
          </div>
        </div>
      </div>
    `;
  }

  private getFilteredAccounts(): AccountData[] {
    let filtered = [...this.accounts];

    if (!this.accountFilterShowNoChar) {
      filtered = filtered.filter(a => a.username && a.className);
    }

    if (!this.accountFilterShowBanned) {
      filtered = filtered.filter(a => !a.deactivated);
    }

    const activeDays = parseInt(this.accountFilterActiveDays);
    if (!isNaN(activeDays) && activeDays > 0) {
      const cutoff = Date.now() - activeDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(a => a.lastActiveAt && new Date(a.lastActiveAt).getTime() >= cutoff);
    }

    const createdDays = parseInt(this.accountFilterCreatedDays);
    if (!isNaN(createdDays) && createdDays > 0) {
      const cutoff = Date.now() - createdDays * 24 * 60 * 60 * 1000;
      filtered = filtered.filter(a => new Date(a.createdAt).getTime() >= cutoff);
    }

    return filtered;
  }

  private getSortedAccounts(): AccountData[] {
    const sorted = this.getFilteredAccounts();
    const dir = this.accountSortDir === 'asc' ? 1 : -1;
    sorted.sort((a, b) => {
      let cmp = 0;
      switch (this.accountSortColumn) {
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

  private formatRelativeTime(iso: string | null): string {
    if (!iso) return '—';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return 'just now';
    const seconds = Math.floor(diff / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    if (days < 30) return `${days}d ago`;
    const months = Math.floor(days / 30);
    return `${months}mo ago`;
  }

  private sortIndicator(col: AccountSortColumn): string {
    if (this.accountSortColumn !== col) return '';
    return this.accountSortDir === 'asc' ? ' ▲' : ' ▼';
  }

  private renderAccounts(): string {
    const classes = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];
    const sorted = this.getSortedAccounts();
    const filteredCount = sorted.length;
    const totalCount = this.accounts.length;
    const rows = sorted.map(a => {
      const classCell = a.username && a.className
        ? `<select class="account-class-select" data-username="${this.escapeHtml(a.username)}">
            ${classes.map(c => `<option value="${c}"${c === a.className ? ' selected' : ''}>${c}</option>`).join('')}
           </select>`
        : (a.className ?? '—');

      const usernameCell = a.username
        ? `<a href="#" class="account-detail-link" data-email="${this.escapeHtml(a.email)}" style="color: var(--color-link, #6af); text-decoration: underline; cursor: pointer;">${this.escapeHtml(a.username)}</a>`
        : '<em>none</em>';

      const statusBadges: string[] = [];
      if (a.isOnline) {
        statusBadges.push('<span class="status-online">Online</span>');
      } else {
        statusBadges.push('<span class="status-offline">Offline</span>');
      }
      if (a.deactivated) {
        const appealIcon = a.hasReactivationRequest
          ? ' <span style="color: #f39c12; cursor: help;" title="Has reactivation request">💬</span>'
          : '';
        statusBadges.push(`<span style="color: #e74c3c; font-weight: bold; margin-left: 4px;" title="Suspended">BAN${appealIcon}</span>`);
      }

      return `
        <tr${a.deactivated ? ' style="opacity: 0.6;"' : ''}>
          <td>${usernameCell}</td>
          <td>${a.email}</td>
          <td>${statusBadges.join('')}</td>
          <td>${a.level ?? '—'}</td>
          <td>${classCell}</td>
          <td>${new Date(a.createdAt).toLocaleDateString()}</td>
          <td title="${a.lastActiveAt ? new Date(a.lastActiveAt).toLocaleString() : ''}">${this.formatRelativeTime(a.lastActiveAt)}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Accounts — Showing ${filteredCount} of ${totalCount}</h2></div>
        <div class="pixel-panel" style="margin-bottom: 12px; padding: 10px; display: flex; flex-wrap: wrap; gap: 12px; align-items: center; font-size: 0.85em;">
          <label style="display: flex; align-items: center; gap: 4px;">
            <input type="checkbox" id="filter-show-no-char" ${this.accountFilterShowNoChar ? 'checked' : ''}>
            Show no character
          </label>
          <label style="display: flex; align-items: center; gap: 4px;">
            <input type="checkbox" id="filter-show-banned" ${this.accountFilterShowBanned ? 'checked' : ''}>
            Show banned
          </label>
          <label style="display: flex; align-items: center; gap: 4px;">
            Active in last
            <input type="number" id="filter-active-days" value="${this.accountFilterActiveDays}" min="1" style="width: 50px; padding: 2px 4px; background: var(--color-bg-panel, #1a1a2e); color: var(--color-text, #eee); border: 1px solid var(--color-border, #333);">
            days
          </label>
          <label style="display: flex; align-items: center; gap: 4px;">
            Created in last
            <input type="number" id="filter-created-days" value="${this.accountFilterCreatedDays}" min="1" style="width: 50px; padding: 2px 4px; background: var(--color-bg-panel, #1a1a2e); color: var(--color-text, #eee); border: 1px solid var(--color-border, #333);">
            days
          </label>
        </div>
        <div class="admin-table-wrap pixel-panel">
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
        <div style="margin-top: 24px; padding: 16px; border: 2px solid var(--danger, #c0392b); border-radius: 4px;">
          <h3 style="margin: 0 0 8px; color: var(--danger, #c0392b);">Danger Zone</h3>
          <p style="margin: 0 0 12px; font-size: 0.85em;">Reset ALL players to Level 1, 0 XP, starting room. Classes are kept.</p>
          <button id="master-reset-btn" class="admin-btn admin-btn-danger">Master Reset</button>
        </div>
      </div>
      <div id="account-detail-modal" style="display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000; overflow-y: auto;">
        <div style="max-width: 700px; margin: 40px auto; background: var(--color-bg-panel, #1a1a2e); border: 2px solid var(--color-border, #333); padding: 20px; border-radius: 4px;">
          <div id="account-detail-content"></div>
          <button id="account-detail-close" class="admin-btn" style="margin-top: 12px;">Close</button>
        </div>
      </div>
    `;
  }

  private wireAccountEvents(): void {
    // Filter controls
    document.getElementById('filter-show-no-char')?.addEventListener('change', (e) => {
      this.accountFilterShowNoChar = (e.target as HTMLInputElement).checked;
      this.renderTabContent();
    });
    document.getElementById('filter-show-banned')?.addEventListener('change', (e) => {
      this.accountFilterShowBanned = (e.target as HTMLInputElement).checked;
      this.renderTabContent();
    });
    document.getElementById('filter-active-days')?.addEventListener('input', (e) => {
      this.accountFilterActiveDays = (e.target as HTMLInputElement).value;
      this.renderTabContent();
    });
    document.getElementById('filter-created-days')?.addEventListener('input', (e) => {
      this.accountFilterCreatedDays = (e.target as HTMLInputElement).value;
      this.renderTabContent();
    });

    // Sortable headers
    document.querySelectorAll('.admin-table-sortable th[data-sort]').forEach(th => {
      th.addEventListener('click', () => {
        const col = (th as HTMLElement).dataset.sort as AccountSortColumn;
        if (this.accountSortColumn === col) {
          this.accountSortDir = this.accountSortDir === 'asc' ? 'desc' : 'asc';
        } else {
          this.accountSortColumn = col;
          this.accountSortDir = 'asc';
        }
        this.renderTabContent();
      });
    });

    // Account detail modal
    document.querySelectorAll('.account-detail-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        const email = (link as HTMLElement).dataset.email!;
        this.showAccountDetail(email);
      });
    });

    document.getElementById('account-detail-close')?.addEventListener('click', () => {
      const modal = document.getElementById('account-detail-modal');
      if (modal) modal.style.display = 'none';
    });

    // Close modal on background click
    document.getElementById('account-detail-modal')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) {
        (e.currentTarget as HTMLElement).style.display = 'none';
      }
    });

    document.querySelectorAll('.account-class-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        const select = sel as HTMLSelectElement;
        const username = select.dataset.username!;
        const className = select.value;
        if (!confirm(`Change ${username}'s class to ${className}? Their equipment will be unequipped.`)) {
          // Revert select to previous value
          const account = this.accounts.find(a => a.username === username);
          if (account?.className) select.value = account.className;
          return;
        }
        try {
          const res = await fetch(`/api/admin/players/${encodeURIComponent(username)}/class`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            credentials: 'include',
            body: JSON.stringify({ className }),
          });
          const data = await res.json();
          if (!res.ok) {
            alert(data.error || 'Failed to change class');
            const account = this.accounts.find(a => a.username === username);
            if (account?.className) select.value = account.className;
            return;
          }
          await this.refresh();
        } catch {
          alert('Network error — could not change class');
        }
      });
    });

    document.getElementById('master-reset-btn')?.addEventListener('click', async () => {
      const input = prompt('Type "IT ALL MUST END" to confirm master reset:');
      if (input !== 'IT ALL MUST END') return;

      try {
        const res = await fetch('/api/admin/master-reset', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ confirmation: input }),
        });
        const data = await res.json();
        if (!res.ok) {
          alert(data.error || 'Master reset failed');
          return;
        }
        alert(`Master reset complete: ${data.playersReset} players reset`);
        await this.refresh();
      } catch (err) {
        alert('Master reset failed: ' + (err instanceof Error ? err.message : err));
      }
    });

    // Fetch duplicate tokens on accounts tab load
    this.fetchAdmin<{ duplicates: Record<string, string[]> }>('/api/admin/duplicate-tokens')
      .then(data => { this.duplicateTokens = data.duplicates; })
      .catch(() => { /* ignore */ });
  }

  private showAccountDetail(email: string): void {
    const account = this.accounts.find(a => a.email === email);
    if (!account) return;

    const modal = document.getElementById('account-detail-modal');
    const content = document.getElementById('account-detail-content');
    if (!modal || !content) return;

    // Build set of duplicate tokens for this account
    const accountDuplicateTokens = new Set<string>();
    for (const [token, emails] of Object.entries(this.duplicateTokens)) {
      if (emails.includes(email)) accountDuplicateTokens.add(token);
    }

    // Find other accounts sharing device tokens
    const linkedAccounts = new Set<string>();
    for (const token of accountDuplicateTokens) {
      for (const linkedEmail of this.duplicateTokens[token]) {
        if (linkedEmail !== email) linkedAccounts.add(linkedEmail);
      }
    }

    const sessionRows = (account.sessionHistory ?? []).map(s => {
      const isDuplicate = accountDuplicateTokens.has(s.deviceToken);
      return `
        <tr${isDuplicate ? ' style="background: rgba(231, 76, 60, 0.15);"' : ''}>
          <td title="${this.escapeHtml(s.deviceToken)}">${this.escapeHtml(s.deviceToken.slice(0, 8))}...${isDuplicate ? ' <span style="color: #e74c3c;" title="Shared with other accounts">DUP</span>' : ''}</td>
          <td>${this.escapeHtml(s.ip)}</td>
          <td title="${this.escapeHtml(s.userAgent)}">${this.escapeHtml(s.userAgent.slice(0, 40))}${s.userAgent.length > 40 ? '...' : ''}</td>
          <td>${new Date(s.timestamp).toLocaleString()}</td>
        </tr>
      `;
    }).join('');

    const linkedSection = linkedAccounts.size > 0
      ? `<div style="margin-top: 12px; padding: 8px; background: rgba(231, 76, 60, 0.1); border: 1px solid #e74c3c; border-radius: 4px;">
          <strong style="color: #e74c3c;">Shared device token with:</strong>
          <ul style="margin: 4px 0 0 16px;">${Array.from(linkedAccounts).map(e => {
            const linked = this.accounts.find(a => a.email === e);
            return `<li>${linked?.username ?? '<em>no username</em>'} (${this.escapeHtml(e)})</li>`;
          }).join('')}</ul>
        </div>`
      : '';

    const reactivationSection = account.reactivationRequest
      ? `<div style="margin-top: 12px; padding: 8px; background: rgba(243, 156, 18, 0.1); border: 1px solid #f39c12; border-radius: 4px;">
          <strong style="color: #f39c12;">Reactivation Request:</strong>
          <p style="margin: 4px 0 0; white-space: pre-wrap;">${this.escapeHtml(account.reactivationRequest)}</p>
        </div>`
      : '';

    content.innerHTML = `
      <h3 style="margin: 0 0 12px;">${this.escapeHtml(account.username ?? 'No username')} — Account Details</h3>
      <div style="display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; margin-bottom: 16px; font-size: 0.9em;">
        <strong>Email:</strong> <span>${this.escapeHtml(account.email)}</span>
        <strong>Created:</strong> <span>${new Date(account.createdAt).toLocaleString()}</span>
        <strong>Last Active:</strong> <span>${account.lastActiveAt ? new Date(account.lastActiveAt).toLocaleString() : '—'}</span>
        <strong>Status:</strong> <span>${account.isOnline ? '<span class="status-online">Online</span>' : '<span class="status-offline">Offline</span>'}${account.deactivated ? ' <span style="color: #e74c3c; font-weight: bold;">SUSPENDED</span>' : ''}</span>
        <strong>Class/Level:</strong> <span>${account.className ?? '—'} Lv${account.level ?? '—'}</span>
      </div>
      <div style="margin-bottom: 16px;">
        ${account.deactivated
          ? `<button class="admin-btn" id="account-reactivate-btn" data-email="${this.escapeHtml(account.email)}" data-username="${this.escapeHtml(account.username ?? '')}">Reactivate Account</button>`
          : account.username
            ? `<button class="admin-btn admin-btn-danger" id="account-deactivate-btn" data-email="${this.escapeHtml(account.email)}" data-username="${this.escapeHtml(account.username)}">Suspend Account</button>`
            : ''}
      </div>
      ${reactivationSection}
      ${linkedSection}
      <h4 style="margin: 16px 0 8px;">Session History (last ${account.sessionHistory?.length ?? 0})</h4>
      ${sessionRows
        ? `<div class="admin-table-wrap" style="max-height: 300px; overflow-y: auto;">
            <table class="admin-table" style="font-size: 0.8em;">
              <thead><tr><th>Device Token</th><th>IP</th><th>User Agent</th><th>Time</th></tr></thead>
              <tbody>${sessionRows}</tbody>
            </table>
          </div>`
        : '<p style="color: #888;">No session history recorded yet.</p>'}
    `;

    // Wire deactivation/reactivation buttons
    document.getElementById('account-deactivate-btn')?.addEventListener('click', async () => {
      const username = (document.getElementById('account-deactivate-btn') as HTMLElement).dataset.username!;
      if (!confirm(`Suspend account "${username}"? This will kick them and prevent login.`)) return;
      try {
        await fetch(`/api/admin/players/${encodeURIComponent(username)}/deactivate`, {
          method: 'POST', credentials: 'include',
        });
        await this.refresh();
        modal.style.display = 'none';
      } catch { alert('Failed to suspend account'); }
    });

    document.getElementById('account-reactivate-btn')?.addEventListener('click', async () => {
      const username = (document.getElementById('account-reactivate-btn') as HTMLElement).dataset.username!;
      if (!confirm(`Reactivate account "${username}"?`)) return;
      try {
        await fetch(`/api/admin/players/${encodeURIComponent(username)}/reactivate`, {
          method: 'POST', credentials: 'include',
        });
        await this.refresh();
        modal.style.display = 'none';
      } catch { alert('Failed to reactivate account'); }
    });

    modal.style.display = '';
  }

  private renderMonsters(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const monsters = Object.values(displayContent.monsters);
    const items = displayContent.items;
    const readOnly = this.isReadOnly();

    const rows = monsters.map(m => {
      const drops = m.drops?.map(d => {
        const item = items[d.itemId];
        return `${item?.name ?? d.itemId} (${(d.chance * 100).toFixed(3)}%)`;
      }).join(', ') ?? 'None';

      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm monster-edit-btn" data-id="${m.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger monster-delete-btn" data-id="${m.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(m.name)}</td>
          <td>${m.hp}</td>
          <td>${m.damage}</td>
          <td>${m.damageType}</td>
          <td>${m.xp}</td>
          <td>${m.goldMin}-${m.goldMax}</td>
          <td>${drops}</td>
          <td>${m.resistances?.length ?? 0} res, ${m.skills?.length ?? 0} skills</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="monster-add-btn">+ Add Monster</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Monsters (${monsters.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div id="monster-form-area"></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>HP</th>
                <th>Dmg</th>
                <th>Type</th>
                <th>XP</th>
                <th>Gold</th>
                <th>Drops</th>
                <th>Mods</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireMonsterEvents(): void {
    document.getElementById('monster-add-btn')?.addEventListener('click', () => {
      this.showMonsterForm(null);
    });

    document.querySelectorAll('.monster-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const monster = displayContent.monsters[id];
        if (monster) this.showMonsterForm(monster);
      });
    });

    document.querySelectorAll('.monster-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteMonster(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showMonsterForm(monster: MonsterDefinition | null): void {
    const area = document.getElementById('monster-form-area');
    if (!area) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    const isNew = !monster;
    const m = monster ?? { id: '', name: '', hp: 10, damage: 3, damageType: 'physical' as const, xp: 5, goldMin: 1, goldMax: 2, drops: [] };
    const items = Object.values(displayContent.items);

    const dropRows = (m.drops ?? []).map((d, i) => this.renderDropRow(i, d.itemId, d.chance, items)).join('');
    const resistanceRows = (m.resistances ?? []).map((r, i) => this.renderResistanceRow(i, r)).join('');
    const skillRows = (m.skills ?? []).map((s, i) => this.renderMonsterSkillRow(i, s)).join('');

    area.innerHTML = `
      <div class="pixel-panel monster-form">
        <h3>${isNew ? 'Add Monster' : `Edit: ${this.escapeHtml(m.name)}`}</h3>
        <input type="hidden" id="mf-id" value="${this.escapeHtml(m.id)}">
        <div class="monster-form-grid">
          <label>Name<input type="text" id="mf-name" value="${this.escapeHtml(m.name)}"></label>
          <label>HP<input type="number" id="mf-hp" value="${m.hp}" min="1"></label>
          <label>Damage<input type="number" id="mf-damage" value="${m.damage}" min="0"></label>
          <label>Type
            <select id="mf-damageType">
              <option value="physical" ${m.damageType === 'physical' ? 'selected' : ''}>Physical</option>
              <option value="magical" ${m.damageType === 'magical' ? 'selected' : ''}>Magical</option>
            </select>
          </label>
          <label>XP<input type="number" id="mf-xp" value="${m.xp}" min="0"></label>
          <label>Gold Min<input type="number" id="mf-goldMin" value="${m.goldMin}" min="0"></label>
          <label>Gold Max<input type="number" id="mf-goldMax" value="${m.goldMax}" min="0"></label>
        </div>
        <div class="monster-form-drops">
          <h4>Drops <button class="admin-btn admin-btn-sm" id="mf-add-drop">+ Drop</button></h4>
          <div id="mf-drops-list">${dropRows}</div>
        </div>
        <div class="monster-form-resistances">
          <h4>Resistances <button class="admin-btn admin-btn-sm" id="mf-add-resistance">+ Resistance</button></h4>
          <div id="mf-resistances-list">${resistanceRows}</div>
        </div>
        <div class="monster-form-skills">
          <h4>Skills <button class="admin-btn admin-btn-sm" id="mf-add-skill">+ Skill</button></h4>
          <div id="mf-skills-list">${skillRows}</div>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="mf-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="mf-cancel">Cancel</button>
        </div>
      </div>
    `;

    this.wireMonsterFormEvents(items);
  }

  private renderDropRow(index: number, itemId: string, chance: number, items: ItemDefinition[]): string {
    const options = items.map(i =>
      `<option value="${i.id}" ${i.id === itemId ? 'selected' : ''}>${this.escapeHtml(i.name)}</option>`
    ).join('');

    const rateHint = chance > 0 ? `<span class="mf-drop-rate-hint">~${Math.round(1 / chance)} per kill</span>` : '';

    return `
      <div class="monster-drop-row" data-index="${index}">
        <select class="mf-drop-item">${options}</select>
        <input type="number" class="mf-drop-chance" value="${(chance * 100).toFixed(3)}" min="0.001" max="100" step="0.001">
        <span>%</span>
        ${rateHint}
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-drop-remove">X</button>
      </div>
    `;
  }

  private renderResistanceRow(index: number, resistance: Resistance): string {
    return `
      <div class="monster-resistance-row" data-index="${index}">
        <select class="mf-res-type">
          <option value="physical" ${resistance.damageType === 'physical' ? 'selected' : ''}>Physical</option>
          <option value="magical" ${resistance.damageType === 'magical' ? 'selected' : ''}>Magical</option>
          <option value="holy" ${resistance.damageType === 'holy' ? 'selected' : ''}>Holy</option>
        </select>
        <label>Flat<input type="number" class="mf-res-flat" value="${resistance.flatReduction}" step="1"></label>
        <label>%<input type="number" class="mf-res-percent" value="${resistance.percentReduction}" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-res-remove">X</button>
      </div>
    `;
  }

  private renderMonsterSkillRow(index: number, entry: MonsterSkillEntry): string {
    const options = Object.values(MONSTER_SKILL_CATALOG).map(s =>
      `<option value="${s.id}" ${s.id === entry.skillId ? 'selected' : ''}>${this.escapeHtml(s.name)}</option>`
    ).join('');

    const skillDef = MONSTER_SKILL_CATALOG[entry.skillId];
    const info = skillDef ? `${skillDef.targeting} / ${skillDef.effect}` : '';

    return `
      <div class="monster-skill-row" data-index="${index}">
        <select class="mf-skill-id">${options}</select>
        <label>Value<input type="number" class="mf-skill-value" value="${entry.value}" min="1"></label>
        <label>CD<input type="number" class="mf-skill-cd" value="${entry.cooldown}" min="1"></label>
        <span class="mf-skill-info">${info}</span>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-skill-remove">X</button>
      </div>
    `;
  }

  private wireMonsterFormEvents(items: ItemDefinition[]): void {
    document.getElementById('mf-cancel')?.addEventListener('click', () => {
      const area = document.getElementById('monster-form-area');
      if (area) area.innerHTML = '';
    });

    document.getElementById('mf-add-drop')?.addEventListener('click', () => {
      const list = document.getElementById('mf-drops-list');
      if (!list || items.length === 0) return;
      const index = list.querySelectorAll('.monster-drop-row').length;
      const html = this.renderDropRow(index, items[0].id, 0.1, items);
      list.insertAdjacentHTML('beforeend', html);
      this.wireDropRemoveButtons();
    });

    this.wireDropRemoveButtons();

    document.getElementById('mf-add-resistance')?.addEventListener('click', () => {
      const list = document.getElementById('mf-resistances-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-resistance-row').length;
      const html = this.renderResistanceRow(index, { damageType: 'physical', flatReduction: 0, percentReduction: 0 });
      list.insertAdjacentHTML('beforeend', html);
      this.wireResistanceRemoveButtons();
    });

    document.getElementById('mf-add-skill')?.addEventListener('click', () => {
      const list = document.getElementById('mf-skills-list');
      if (!list) return;
      const index = list.querySelectorAll('.monster-skill-row').length;
      const firstSkillId = Object.keys(MONSTER_SKILL_CATALOG)[0];
      const defaultCd = MONSTER_SKILL_CATALOG[firstSkillId]?.cooldown ?? 3;
      const html = this.renderMonsterSkillRow(index, { skillId: firstSkillId, value: 1, cooldown: defaultCd });
      list.insertAdjacentHTML('beforeend', html);
      this.wireSkillRemoveButtons();
    });

    this.wireResistanceRemoveButtons();
    this.wireSkillRemoveButtons();

    document.getElementById('mf-save')?.addEventListener('click', () => {
      this.saveMonsterForm();
    });
  }

  private wireDropRemoveButtons(): void {
    document.querySelectorAll('.mf-drop-remove').forEach(btn => {
      btn.replaceWith(btn.cloneNode(true));
    });
    document.querySelectorAll('.mf-drop-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        (btn as HTMLElement).closest('.monster-drop-row')?.remove();
      });
    });
  }

  private wireResistanceRemoveButtons(): void {
    document.querySelectorAll('.mf-res-remove').forEach(btn => {
      btn.replaceWith(btn.cloneNode(true));
    });
    document.querySelectorAll('.mf-res-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        (btn as HTMLElement).closest('.monster-resistance-row')?.remove();
      });
    });
  }

  private wireSkillRemoveButtons(): void {
    document.querySelectorAll('.mf-skill-remove').forEach(btn => {
      btn.replaceWith(btn.cloneNode(true));
    });
    document.querySelectorAll('.mf-skill-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        (btn as HTMLElement).closest('.monster-skill-row')?.remove();
      });
    });
  }

  private async saveMonsterForm(): Promise<void> {
    const existingId = (document.getElementById('mf-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('mf-name') as HTMLInputElement)?.value.trim();
    const hp = parseInt((document.getElementById('mf-hp') as HTMLInputElement)?.value);
    const damage = parseInt((document.getElementById('mf-damage') as HTMLInputElement)?.value);
    const damageType = (document.getElementById('mf-damageType') as HTMLSelectElement)?.value;
    const xp = parseInt((document.getElementById('mf-xp') as HTMLInputElement)?.value);
    const goldMin = parseInt((document.getElementById('mf-goldMin') as HTMLInputElement)?.value);
    const goldMax = parseInt((document.getElementById('mf-goldMax') as HTMLInputElement)?.value);

    if (!name) {
      alert('Name is required.');
      return;
    }

    // Validate name uniqueness
    const displayContent = this.getDisplayContent();
    if (displayContent) {
      const duplicate = Object.values(displayContent.monsters).find(m => m.name === name && m.id !== existingId);
      if (duplicate) {
        alert(`A monster named "${name}" already exists.`);
        return;
      }
    }

    const id = existingId || crypto.randomUUID();

    const drops: { itemId: string; chance: number }[] = [];
    document.querySelectorAll('.monster-drop-row').forEach(row => {
      const itemId = (row.querySelector('.mf-drop-item') as HTMLSelectElement)?.value;
      const chance = parseFloat((row.querySelector('.mf-drop-chance') as HTMLInputElement)?.value) / 100;
      if (itemId && chance > 0) drops.push({ itemId, chance });
    });

    const resistances: Resistance[] = [];
    document.querySelectorAll('.monster-resistance-row').forEach(row => {
      const dt = (row.querySelector('.mf-res-type') as HTMLSelectElement)?.value as DamageType;
      const flatReduction = parseInt((row.querySelector('.mf-res-flat') as HTMLInputElement)?.value) || 0;
      const percentReduction = parseInt((row.querySelector('.mf-res-percent') as HTMLInputElement)?.value) || 0;
      resistances.push({ damageType: dt, flatReduction, percentReduction });
    });

    const skills: MonsterSkillEntry[] = [];
    document.querySelectorAll('.monster-skill-row').forEach(row => {
      const skillId = (row.querySelector('.mf-skill-id') as HTMLSelectElement)?.value;
      const value = parseInt((row.querySelector('.mf-skill-value') as HTMLInputElement)?.value) || 1;
      const cooldown = parseInt((row.querySelector('.mf-skill-cd') as HTMLInputElement)?.value) || 3;
      if (skillId) skills.push({ skillId, value, cooldown });
    });

    const monster: MonsterDefinition = {
      id, name, hp, damage,
      damageType: damageType as DamageType,
      xp, goldMin, goldMax,
      drops: drops.length > 0 ? drops : undefined,
      resistances: resistances.length > 0 ? resistances : undefined,
      skills: skills.length > 0 ? skills : undefined,
    };

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/monsters/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(monster),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save monster');
        return;
      }
      this.updateDisplayMonsters(data.monsters);
      this.renderTabContent();
    } catch {
      alert('Network error — could not save monster');
    }
  }

  private async deleteMonster(monsterId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const monster = displayContent.monsters[monsterId];
    if (!monster) return;
    if (!confirm(`Delete monster "${monster.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/monsters/${encodeURIComponent(monsterId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete monster');
        return;
      }
      this.updateDisplayMonsters(data.monsters);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete monster');
    }
  }

  private updateDisplayMonsters(monsters: Record<string, MonsterDefinition>): void {
    if (this.versionContent) {
      this.versionContent.monsters = monsters;
    }
  }

  private renderItems(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const allItems = Object.values(displayContent.items);
    const readOnly = this.isReadOnly();

    const slotOptions = ['all', ...EQUIP_SLOTS, 'twohanded', 'none'].map(slot => {
      const selected = this.itemSlotFilter === slot ? ' selected' : '';
      const label = slot === 'none' ? 'No Slot' : slot.charAt(0).toUpperCase() + slot.slice(1);
      return `<option value="${slot}"${selected}>${label}</option>`;
    }).join('');

    const items = allItems.filter(i => {
      if (this.itemSlotFilter === 'all') return true;
      if (this.itemSlotFilter === 'none') return !i.equipSlot;
      if (this.itemSlotFilter === 'twohanded') return i.equipSlot === 'twohanded';
      return i.equipSlot === this.itemSlotFilter;
    });

    // Build set lookup: itemId → set name
    const itemSetMap = new Map<string, string>();
    if (displayContent.sets) {
      for (const set of Object.values(displayContent.sets)) {
        for (const itemId of set.itemIds) {
          itemSetMap.set(itemId, set.name);
        }
      }
    }

    const rows = items.map(i => {
      const effects: string[] = [];
      if (i.bonusAttackMin != null && i.bonusAttackMax != null && i.bonusAttackMax > 0) {
        effects.push(`+${i.bonusAttackMin}-${i.bonusAttackMax} Atk`);
      }
      if (i.damageReductionMin != null && i.damageReductionMax != null && i.damageReductionMax > 0) {
        effects.push(`${i.damageReductionMin}-${i.damageReductionMax} DR`);
      }
      if (i.magicReductionMin != null && i.magicReductionMax != null && i.magicReductionMax > 0) {
        effects.push(`${i.magicReductionMin}-${i.magicReductionMax} MR`);
      }

      const setName = itemSetMap.get(i.id) ?? '-';

      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm item-edit-btn" data-id="${i.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger item-delete-btn" data-id="${i.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td><img src="/item-artwork/${i.id}.png" style="width:24px;height:24px;vertical-align:middle;margin-right:4px;" onerror="this.style.display='none'">${this.escapeHtml(i.name)}</td>
          <td><span class="rarity-${i.rarity}">${i.rarity}</span></td>
          <td>${i.equipSlot ?? '-'}</td>
          <td>${effects.length > 0 ? effects.join(', ') : 'Material'}</td>
          <td>${i.value ?? 1}</td>
          <td>${this.escapeHtml(setName)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="item-add-btn">+ Add Item</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Items (${items.length}/${allItems.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div class="admin-filter-bar">
          <label>Slot: <select id="item-slot-filter">${slotOptions}</select></label>
        </div>
        <div id="item-form-area"></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Rarity</th>
                <th>Slot</th>
                <th>Effects</th>
                <th>Value</th>
                <th>Set</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireItemEvents(): void {
    document.getElementById('item-slot-filter')?.addEventListener('change', (e) => {
      this.itemSlotFilter = (e.target as HTMLSelectElement).value;
      this.renderTabContent();
    });

    document.getElementById('item-add-btn')?.addEventListener('click', () => {
      this.showItemForm(null);
    });

    document.querySelectorAll('.item-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const item = displayContent.items[id];
        if (item) this.showItemForm(item);
      });
    });

    document.querySelectorAll('.item-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteItem(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showItemForm(item: ItemDefinition | null): void {
    const isNew = !item;
    const i = item ?? { id: '', name: '', rarity: 'common' as const };

    const rarityOptions = ['janky', 'common', 'uncommon', 'rare', 'epic', 'legendary', 'heirloom'].map(r =>
      `<option value="${r}" ${i.rarity === r ? 'selected' : ''}>${r}</option>`
    ).join('');

    const slotOptions = ['', ...DISPLAY_EQUIP_SLOTS, 'twohanded'].map(s =>
      `<option value="${s}" ${(i.equipSlot ?? '') === s ? 'selected' : ''}>${s || '(none - material)'}</option>`
    ).join('');

    const classRestrictions = Array.isArray(i.classRestriction) ? i.classRestriction : [];
    const classCheckboxes = ALL_CLASS_NAMES.map(c =>
      `<label style="display:inline-flex;align-items:center;gap:4px;margin-right:8px;">
        <input type="checkbox" class="if-class-check" value="${c}" ${classRestrictions.includes(c) ? 'checked' : ''}> ${c}
      </label>`
    ).join('');

    const artworkPreview = i.id
      ? `<img src="/item-artwork/${i.id}.png" style="max-width:96px;max-height:96px;margin-bottom:8px;display:block;" onerror="this.style.display='none'">`
      : '';

    // Remove any existing modal
    document.querySelector('.admin-item-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'admin-item-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;overflow-y:auto;display:flex;justify-content:center;align-items:flex-start;';
    overlay.innerHTML = `
      <div style="max-width:600px;width:100%;margin:40px auto;background:var(--color-bg-panel,#1a1a2e);border:2px solid var(--color-border,#333);padding:20px;border-radius:4px;" class="pixel-panel">
        <h3>${isNew ? 'Add Item' : `Edit: ${this.escapeHtml(i.name)}`}</h3>
        <input type="hidden" id="if-id" value="${this.escapeHtml(i.id)}">
        <div class="monster-form-grid">
          <label>Name<input type="text" id="if-name" value="${this.escapeHtml(i.name)}"></label>
          <label>Rarity<select id="if-rarity">${rarityOptions}</select></label>
          <label>Equip Slot<select id="if-equipSlot">${slotOptions}</select></label>
          <label>Attack Min<input type="number" id="if-atkMin" value="${i.bonusAttackMin ?? 0}" min="0"></label>
          <label>Attack Max<input type="number" id="if-atkMax" value="${i.bonusAttackMax ?? 0}" min="0"></label>
          <label>DR Min<input type="number" id="if-drMin" value="${i.damageReductionMin ?? 0}" min="0"></label>
          <label>DR Max<input type="number" id="if-drMax" value="${i.damageReductionMax ?? 0}" min="0"></label>
          <label>MR Min<input type="number" id="if-mrMin" value="${i.magicReductionMin ?? 0}" min="0"></label>
          <label>MR Max<input type="number" id="if-mrMax" value="${i.magicReductionMax ?? 0}" min="0"></label>
          <label>Value<input type="number" id="if-value" value="${i.value ?? 1}" min="0"></label>
        </div>
        <div style="margin:8px 0;">
          <label style="display:block;margin-bottom:4px;">Class Restriction</label>
          ${classCheckboxes}
        </div>
        <div style="margin:8px 0;">
          <label style="display:block;margin-bottom:4px;">Artwork</label>
          ${artworkPreview}
          <input type="file" id="if-artwork-file" accept="image/png" style="margin-bottom:4px;">
          <div style="display:flex;gap:8px;">
            <button class="admin-btn admin-btn-sm" id="if-artwork-upload">Upload</button>
            <button class="admin-btn admin-btn-sm admin-btn-danger" id="if-artwork-remove">Remove Artwork</button>
          </div>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="if-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="if-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Close on overlay click
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.getElementById('if-cancel')?.addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('if-save')?.addEventListener('click', () => {
      this.saveItemForm();
    });

    document.getElementById('if-artwork-upload')?.addEventListener('click', () => {
      this.uploadItemArtwork();
    });

    document.getElementById('if-artwork-remove')?.addEventListener('click', () => {
      this.removeItemArtwork();
    });
  }

  private async uploadItemArtwork(): Promise<void> {
    const id = (document.getElementById('if-id') as HTMLInputElement)?.value.trim();
    if (!id) {
      alert('Save the item first before uploading artwork.');
      return;
    }
    const fileInput = document.getElementById('if-artwork-file') as HTMLInputElement;
    if (!fileInput?.files?.length) {
      alert('Select a PNG file first.');
      return;
    }
    const formData = new FormData();
    formData.append('artwork', fileInput.files[0]);
    try {
      const res = await fetch(`/api/admin/items/${encodeURIComponent(id)}/artwork`, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to upload artwork');
        return;
      }
      alert('Artwork uploaded successfully.');
    } catch {
      alert('Network error uploading artwork.');
    }
  }

  private async removeItemArtwork(): Promise<void> {
    const id = (document.getElementById('if-id') as HTMLInputElement)?.value.trim();
    if (!id) return;
    if (!confirm('Remove artwork for this item?')) return;
    try {
      const res = await fetch(`/api/admin/items/${encodeURIComponent(id)}/artwork`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        alert(data.error || 'Failed to remove artwork');
        return;
      }
      alert('Artwork removed.');
    } catch {
      alert('Network error removing artwork.');
    }
  }

  private async saveItemForm(): Promise<void> {
    const existingId = (document.getElementById('if-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('if-name') as HTMLInputElement)?.value.trim();
    const rarity = (document.getElementById('if-rarity') as HTMLSelectElement)?.value;
    const equipSlot = (document.getElementById('if-equipSlot') as HTMLSelectElement)?.value || undefined;
    const bonusAttackMin = parseInt((document.getElementById('if-atkMin') as HTMLInputElement)?.value) || 0;
    const bonusAttackMax = parseInt((document.getElementById('if-atkMax') as HTMLInputElement)?.value) || 0;
    const damageReductionMin = parseInt((document.getElementById('if-drMin') as HTMLInputElement)?.value) || 0;
    const damageReductionMax = parseInt((document.getElementById('if-drMax') as HTMLInputElement)?.value) || 0;
    const magicReductionMin = parseInt((document.getElementById('if-mrMin') as HTMLInputElement)?.value) || 0;
    const magicReductionMax = parseInt((document.getElementById('if-mrMax') as HTMLInputElement)?.value) || 0;
    const value = parseInt((document.getElementById('if-value') as HTMLInputElement)?.value) || 1;

    if (!name) {
      alert('Name is required.');
      return;
    }

    // Validate name uniqueness
    const displayContent = this.getDisplayContent();
    if (displayContent) {
      const duplicate = Object.values(displayContent.items).find(i => i.name === name && i.id !== existingId);
      if (duplicate) {
        alert(`An item named "${name}" already exists.`);
        return;
      }
    }

    const id = existingId || crypto.randomUUID();

    const item: ItemDefinition = { id, name, rarity: rarity as ItemRarity };
    if (equipSlot) item.equipSlot = equipSlot as EquipSlot;

    // Collect class restriction checkboxes
    const classRestriction: string[] = [];
    document.querySelectorAll('.if-class-check').forEach(cb => {
      if ((cb as HTMLInputElement).checked) {
        classRestriction.push((cb as HTMLInputElement).value);
      }
    });
    if (classRestriction.length > 0) item.classRestriction = classRestriction;

    if (bonusAttackMin > 0 || bonusAttackMax > 0) { item.bonusAttackMin = bonusAttackMin; item.bonusAttackMax = bonusAttackMax; }
    if (damageReductionMin > 0 || damageReductionMax > 0) { item.damageReductionMin = damageReductionMin; item.damageReductionMax = damageReductionMax; }
    if (magicReductionMin > 0 || magicReductionMax > 0) { item.magicReductionMin = magicReductionMin; item.magicReductionMax = magicReductionMax; }
    if (value !== 1) item.value = value;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/items/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(item),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save item');
        return;
      }
      this.updateDisplayItems(data.items);
      document.querySelector('.admin-item-modal-overlay')?.remove();
      this.renderTabContent();
    } catch {
      alert('Network error — could not save item');
    }
  }

  private async deleteItem(itemId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const item = displayContent.items[itemId];
    if (!item) return;
    if (!confirm(`Delete item "${item.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/items/${encodeURIComponent(itemId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete item');
        return;
      }
      this.updateDisplayItems(data.items);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete item');
    }
  }

  private updateDisplayItems(items: Record<string, ItemDefinition>): void {
    if (this.versionContent) {
      this.versionContent.items = items;
    }
  }

  // --- Sets ---

  private renderSets(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const sets = Object.values(displayContent.sets ?? {});
    const readOnly = this.isReadOnly();

    const rows = sets.map(s => {
      const bonusSummary = getSetBonusText(s.bonuses);

      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm set-edit-btn" data-id="${s.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger set-delete-btn" data-id="${s.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(s.name)}</td>
          <td>${s.itemIds.length}</td>
          <td>${this.escapeHtml(bonusSummary)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="set-add-btn">+ Add Set</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Sets (${sets.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Items</th>
                <th>Bonus Summary</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireSetsEvents(): void {
    document.getElementById('set-add-btn')?.addEventListener('click', () => {
      this.showSetForm(null);
    });

    document.querySelectorAll('.set-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const set = (displayContent.sets ?? {})[id];
        if (set) this.showSetForm(set);
      });
    });

    document.querySelectorAll('.set-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteSet(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showSetForm(set: SetDefinition | null): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    const isNew = !set;
    const s = set ?? { id: '', name: '', itemIds: [], bonuses: {} };
    const items = Object.values(displayContent.items);
    const existingItemIds = new Set(s.itemIds);

    const itemCheckboxes = items.map(item =>
      `<label style="display:block;margin:2px 0;">
        <input type="checkbox" class="sf-item-check" value="${item.id}" ${existingItemIds.has(item.id) ? 'checked' : ''}> ${this.escapeHtml(item.name)}
      </label>`
    ).join('');

    const b = s.bonuses;

    // Remove any existing modal
    document.querySelector('.admin-set-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'admin-set-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;overflow-y:auto;display:flex;justify-content:center;align-items:flex-start;';
    overlay.innerHTML = `
      <div style="max-width:600px;width:100%;margin:40px auto;background:var(--color-bg-panel,#1a1a2e);border:2px solid var(--color-border,#333);padding:20px;border-radius:4px;" class="pixel-panel">
        <h3>${isNew ? 'Add Set' : `Edit: ${this.escapeHtml(s.name)}`}</h3>
        <input type="hidden" id="sf-id" value="${this.escapeHtml(s.id)}">
        <div class="monster-form-grid">
          <label>Name<input type="text" id="sf-name" value="${this.escapeHtml(s.name)}"></label>
        </div>
        <div style="margin:8px 0;">
          <label style="display:block;margin-bottom:4px;font-weight:bold;">Items</label>
          <div style="max-height:200px;overflow-y:auto;border:1px solid var(--color-border,#333);padding:8px;">
            ${itemCheckboxes}
          </div>
        </div>
        <div style="margin:8px 0;">
          <label style="display:block;margin-bottom:4px;font-weight:bold;">Set Bonuses</label>
          <div class="monster-form-grid">
            <label>CD Reduction<input type="number" id="sf-cooldownReduction" value="${b.cooldownReduction ?? 0}" min="0"></label>
            <label>Damage %<input type="number" id="sf-damagePercent" value="${b.damagePercent ?? 0}" min="0"></label>
            <label>Dmg Resist %<input type="number" id="sf-damageResistancePercent" value="${b.damageResistancePercent ?? 0}" min="0"></label>
            <label>DR Min<input type="number" id="sf-drMin" value="${b.damageReductionMin ?? 0}" min="0"></label>
            <label>DR Max<input type="number" id="sf-drMax" value="${b.damageReductionMax ?? 0}" min="0"></label>
            <label>MR Min<input type="number" id="sf-mrMin" value="${b.magicReductionMin ?? 0}" min="0"></label>
            <label>MR Max<input type="number" id="sf-mrMax" value="${b.magicReductionMax ?? 0}" min="0"></label>
            <label>Atk Min<input type="number" id="sf-atkMin" value="${b.bonusAttackMin ?? 0}" min="0"></label>
            <label>Atk Max<input type="number" id="sf-atkMax" value="${b.bonusAttackMax ?? 0}" min="0"></label>
            <label>Flat HP<input type="number" id="sf-flatHp" value="${b.flatHp ?? 0}" min="0"></label>
            <label>% HP<input type="number" id="sf-percentHp" value="${b.percentHp ?? 0}" min="0"></label>
          </div>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="sf-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="sf-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.getElementById('sf-cancel')?.addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('sf-save')?.addEventListener('click', () => {
      this.saveSetForm();
    });
  }

  private async saveSetForm(): Promise<void> {
    const existingId = (document.getElementById('sf-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('sf-name') as HTMLInputElement)?.value.trim();

    if (!name) {
      alert('Name is required.');
      return;
    }

    const id = existingId || crypto.randomUUID();

    const itemIds: string[] = [];
    document.querySelectorAll('.sf-item-check').forEach(cb => {
      if ((cb as HTMLInputElement).checked) {
        itemIds.push((cb as HTMLInputElement).value);
      }
    });

    const bonuses: SetBonuses = {};
    const cooldownReduction = parseInt((document.getElementById('sf-cooldownReduction') as HTMLInputElement)?.value) || 0;
    const damagePercent = parseInt((document.getElementById('sf-damagePercent') as HTMLInputElement)?.value) || 0;
    const damageResistancePercent = parseInt((document.getElementById('sf-damageResistancePercent') as HTMLInputElement)?.value) || 0;
    const drMin = parseInt((document.getElementById('sf-drMin') as HTMLInputElement)?.value) || 0;
    const drMax = parseInt((document.getElementById('sf-drMax') as HTMLInputElement)?.value) || 0;
    const mrMin = parseInt((document.getElementById('sf-mrMin') as HTMLInputElement)?.value) || 0;
    const mrMax = parseInt((document.getElementById('sf-mrMax') as HTMLInputElement)?.value) || 0;
    const atkMin = parseInt((document.getElementById('sf-atkMin') as HTMLInputElement)?.value) || 0;
    const atkMax = parseInt((document.getElementById('sf-atkMax') as HTMLInputElement)?.value) || 0;
    const flatHp = parseInt((document.getElementById('sf-flatHp') as HTMLInputElement)?.value) || 0;
    const percentHp = parseInt((document.getElementById('sf-percentHp') as HTMLInputElement)?.value) || 0;

    if (cooldownReduction) bonuses.cooldownReduction = cooldownReduction;
    if (damagePercent) bonuses.damagePercent = damagePercent;
    if (damageResistancePercent) bonuses.damageResistancePercent = damageResistancePercent;
    if (drMin || drMax) { bonuses.damageReductionMin = drMin; bonuses.damageReductionMax = drMax; }
    if (mrMin || mrMax) { bonuses.magicReductionMin = mrMin; bonuses.magicReductionMax = mrMax; }
    if (atkMin || atkMax) { bonuses.bonusAttackMin = atkMin; bonuses.bonusAttackMax = atkMax; }
    if (flatHp) bonuses.flatHp = flatHp;
    if (percentHp) bonuses.percentHp = percentHp;

    const setDef: SetDefinition = { id, name, itemIds, bonuses };

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/sets/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(setDef),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save set');
        return;
      }
      this.updateDisplaySets(data.sets);
      document.querySelector('.admin-set-modal-overlay')?.remove();
      this.renderTabContent();
    } catch {
      alert('Network error — could not save set');
    }
  }

  private async deleteSet(setId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const set = (displayContent.sets ?? {})[setId];
    if (!set) return;
    if (!confirm(`Delete set "${set.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/sets/${encodeURIComponent(setId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete set');
        return;
      }
      this.updateDisplaySets(data.sets);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete set');
    }
  }

  private updateDisplaySets(sets: Record<string, SetDefinition>): void {
    if (this.versionContent) {
      this.versionContent.sets = sets;
    }
  }

  // --- Shops ---

  private renderShops(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const shops = Object.values(displayContent.shops ?? {});
    const readOnly = this.isReadOnly();

    const rows = shops.map(s => {
      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm shop-edit-btn" data-id="${s.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger shop-delete-btn" data-id="${s.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(s.name)}</td>
          <td>${s.inventory.length}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="shop-add-btn">+ Add Shop</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Shops (${shops.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Items</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireShopsEvents(): void {
    document.getElementById('shop-add-btn')?.addEventListener('click', () => {
      this.showShopForm(null);
    });

    document.querySelectorAll('.shop-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const shop = (displayContent.shops ?? {})[id];
        if (shop) this.showShopForm(shop);
      });
    });

    document.querySelectorAll('.shop-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteShop(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showShopForm(shop: ShopDefinition | null): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    const isNew = !shop;
    const s = shop ?? { id: '', name: '', inventory: [] };
    const items = Object.values(displayContent.items);

    // Build price lookup from existing inventory
    const priceMap = new Map<string, number>();
    const inShop = new Set<string>();
    for (const si of s.inventory) {
      priceMap.set(si.itemId, si.price);
      inShop.add(si.itemId);
    }

    const itemRows = items.map(item => {
      const checked = inShop.has(item.id);
      const price = priceMap.get(item.id) ?? (item.value ?? 1);
      return `
        <div style="display:flex;align-items:center;gap:8px;margin:2px 0;">
          <input type="checkbox" class="shf-item-check" value="${item.id}" ${checked ? 'checked' : ''}>
          <span style="min-width:150px;">${this.escapeHtml(item.name)}</span>
          <label>Price<input type="number" class="shf-item-price" data-item-id="${item.id}" value="${price}" min="0" style="width:80px;"></label>
        </div>
      `;
    }).join('');

    // Remove any existing modal
    document.querySelector('.admin-shop-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'admin-shop-modal-overlay';
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:1000;overflow-y:auto;display:flex;justify-content:center;align-items:flex-start;';
    overlay.innerHTML = `
      <div style="max-width:600px;width:100%;margin:40px auto;background:var(--color-bg-panel,#1a1a2e);border:2px solid var(--color-border,#333);padding:20px;border-radius:4px;" class="pixel-panel">
        <h3>${isNew ? 'Add Shop' : `Edit: ${this.escapeHtml(s.name)}`}</h3>
        <input type="hidden" id="shf-id" value="${this.escapeHtml(s.id)}">
        <div class="monster-form-grid">
          <label>Name<input type="text" id="shf-name" value="${this.escapeHtml(s.name)}"></label>
        </div>
        <div style="margin:8px 0;">
          <label style="display:block;margin-bottom:4px;font-weight:bold;">Inventory</label>
          <div style="max-height:300px;overflow-y:auto;border:1px solid var(--color-border,#333);padding:8px;">
            ${itemRows}
          </div>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="shf-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="shf-cancel">Cancel</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });

    document.getElementById('shf-cancel')?.addEventListener('click', () => {
      overlay.remove();
    });

    document.getElementById('shf-save')?.addEventListener('click', () => {
      this.saveShopForm();
    });
  }

  private async saveShopForm(): Promise<void> {
    const existingId = (document.getElementById('shf-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('shf-name') as HTMLInputElement)?.value.trim();

    if (!name) {
      alert('Name is required.');
      return;
    }

    const id = existingId || crypto.randomUUID();

    const inventory: ShopItem[] = [];
    document.querySelectorAll('.shf-item-check').forEach(cb => {
      if ((cb as HTMLInputElement).checked) {
        const itemId = (cb as HTMLInputElement).value;
        const priceInput = document.querySelector(`.shf-item-price[data-item-id="${itemId}"]`) as HTMLInputElement;
        const price = parseInt(priceInput?.value) || 1;
        inventory.push({ itemId, price });
      }
    });

    const shopDef: ShopDefinition = { id, name, inventory };

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/shops/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(shopDef),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save shop');
        return;
      }
      this.updateDisplayShops(data.shops);
      document.querySelector('.admin-shop-modal-overlay')?.remove();
      this.renderTabContent();
    } catch {
      alert('Network error — could not save shop');
    }
  }

  private async deleteShop(shopId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const shop = (displayContent.shops ?? {})[shopId];
    if (!shop) return;
    if (!confirm(`Delete shop "${shop.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/shops/${encodeURIComponent(shopId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete shop');
        return;
      }
      this.updateDisplayShops(data.shops);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete shop');
    }
  }

  private updateDisplayShops(shops: Record<string, ShopDefinition>): void {
    if (this.versionContent) {
      this.versionContent.shops = shops;
    }
  }

  private renderZones(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const zones = Object.values(displayContent.zones);
    const encounters = displayContent.encounters;
    const readOnly = this.isReadOnly();

    const rows = zones.map(z => {
      const encounterDescs = z.encounterTable.map(e => {
        return `${encounters[e.encounterId]?.name ?? e.encounterId} (w:${e.weight})`;
      }).join(', ');

      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm zone-edit-btn" data-id="${z.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger zone-delete-btn" data-id="${z.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(z.displayName)}</td>
          <td>${z.levelRange[0]}-${z.levelRange[1]}</td>
          <td>${encounterDescs}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="zone-add-btn">+ Add Zone</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Zones (${zones.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div id="zone-form-area"></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Level Range</th>
                <th>Encounters (weight, count range)</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireZoneEvents(): void {
    document.getElementById('zone-add-btn')?.addEventListener('click', () => {
      this.showZoneForm(null);
    });

    document.querySelectorAll('.zone-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const zone = displayContent.zones[id];
        if (zone) this.showZoneForm(zone);
      });
    });

    document.querySelectorAll('.zone-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteZone(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showZoneForm(zone: ZoneDefinition | null): void {
    const area = document.getElementById('zone-form-area');
    if (!area) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    const isNew = !zone;
    const z = zone ?? { id: '', displayName: '', levelRange: [1, 1] as [number, number], encounterTable: [] };
    const encounterDefs = Object.values(displayContent.encounters);

    const encounterRows = z.encounterTable.map((e, i) => this.renderEncounterRow(i, e, encounterDefs)).join('');

    area.innerHTML = `
      <div class="pixel-panel monster-form">
        <h3>${isNew ? 'Add Zone' : `Edit: ${this.escapeHtml(z.displayName)}`}</h3>
        <input type="hidden" id="zf-id" value="${this.escapeHtml(z.id)}">
        <div class="monster-form-grid">
          <label>Display Name<input type="text" id="zf-name" value="${this.escapeHtml(z.displayName)}"></label>
          <label>Level Min<input type="number" id="zf-levelMin" value="${z.levelRange[0]}" min="1"></label>
          <label>Level Max<input type="number" id="zf-levelMax" value="${z.levelRange[1]}" min="1"></label>
        </div>
        <div class="monster-form-drops">
          <h4>Encounter Table <button class="admin-btn admin-btn-sm" id="zf-add-encounter">+ Encounter</button></h4>
          <div id="zf-encounters-list">${encounterRows}</div>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="zf-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="zf-cancel">Cancel</button>
        </div>
      </div>
    `;

    this.wireZoneFormEvents(encounterDefs);
  }

  private renderEncounterRow(index: number, entry: EncounterTableEntry, encounters: EncounterDefinition[]): string {
    const options = encounters.map(enc =>
      `<option value="${enc.id}" ${enc.id === entry.encounterId ? 'selected' : ''}>${this.escapeHtml(enc.name)}</option>`
    ).join('');

    return `
      <div class="monster-drop-row" data-index="${index}">
        <select class="zf-enc-id">${options}</select>
        <label class="zf-enc-inline">W<input type="number" class="zf-enc-weight" value="${entry.weight}" min="1" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger zf-enc-remove">X</button>
      </div>
    `;
  }

  private wireZoneFormEvents(encounters: EncounterDefinition[]): void {
    document.getElementById('zf-cancel')?.addEventListener('click', () => {
      const area = document.getElementById('zone-form-area');
      if (area) area.innerHTML = '';
    });

    document.getElementById('zf-add-encounter')?.addEventListener('click', () => {
      const list = document.getElementById('zf-encounters-list');
      if (!list || encounters.length === 0) return;
      const index = list.querySelectorAll('.monster-drop-row').length;
      const html = this.renderEncounterRow(index, { encounterId: encounters[0].id, weight: 1 }, encounters);
      list.insertAdjacentHTML('beforeend', html);
      this.wireEncounterRemoveButtons();
    });

    this.wireEncounterRemoveButtons();

    document.getElementById('zf-save')?.addEventListener('click', () => {
      this.saveZoneForm();
    });
  }

  private wireEncounterRemoveButtons(): void {
    document.querySelectorAll('.zf-enc-remove').forEach(btn => {
      btn.replaceWith(btn.cloneNode(true));
    });
    document.querySelectorAll('.zf-enc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        (btn as HTMLElement).closest('.monster-drop-row')?.remove();
      });
    });
  }

  private async saveZoneForm(): Promise<void> {
    const existingId = (document.getElementById('zf-id') as HTMLInputElement)?.value.trim();
    const displayName = (document.getElementById('zf-name') as HTMLInputElement)?.value.trim();
    const levelMin = parseInt((document.getElementById('zf-levelMin') as HTMLInputElement)?.value) || 1;
    const levelMax = parseInt((document.getElementById('zf-levelMax') as HTMLInputElement)?.value) || 1;

    if (!displayName) {
      alert('Display Name is required.');
      return;
    }

    // Validate name uniqueness
    const displayContent = this.getDisplayContent();
    if (displayContent) {
      const duplicate = Object.values(displayContent.zones).find(z => z.displayName === displayName && z.id !== existingId);
      if (duplicate) {
        alert(`A zone named "${displayName}" already exists.`);
        return;
      }
    }

    const id = existingId || crypto.randomUUID();

    const encounterTable: EncounterTableEntry[] = [];
    document.querySelectorAll('#zf-encounters-list .monster-drop-row').forEach(row => {
      const encounterId = (row.querySelector('.zf-enc-id') as HTMLSelectElement)?.value;
      const weight = parseInt((row.querySelector('.zf-enc-weight') as HTMLInputElement)?.value) || 1;
      if (encounterId) encounterTable.push({ encounterId, weight });
    });

    const zone: ZoneDefinition = {
      id,
      displayName,
      levelRange: [levelMin, levelMax],
      encounterTable,
    };

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/zones/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(zone),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save zone');
        return;
      }
      this.updateDisplayZones(data.zones);
      this.renderTabContent();
    } catch {
      alert('Network error — could not save zone');
    }
  }

  private async deleteZone(zoneId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const zone = displayContent.zones[zoneId];
    if (!zone) return;
    if (!confirm(`Delete zone "${zone.displayName}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/zones/${encodeURIComponent(zoneId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete zone');
        return;
      }
      this.updateDisplayZones(data.zones);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete zone');
    }
  }

  private updateDisplayZones(zones: Record<string, ZoneDefinition>): void {
    if (this.versionContent) {
      this.versionContent.zones = zones;
    }
  }

  // --- Encounters ---

  private renderEncounters(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const encounters = Object.values(displayContent.encounters);
    const monsters = displayContent.monsters;
    const readOnly = this.isReadOnly();

    const rows = encounters.map(enc => {
      let summary = '';
      if (enc.type === 'random') {
        summary = (enc.monsterPool ?? []).map(p => {
          const m = monsters[p.monsterId];
          return `${m?.name ?? p.monsterId} (${p.min}-${p.max})`;
        }).join(', ') || 'Empty pool';
      } else {
        summary = (enc.placements ?? []).map(p => {
          const m = monsters[p.monsterId];
          return `${m?.name ?? p.monsterId} @${p.gridPosition}`;
        }).join(', ') || 'No placements';
      }

      const actions = readOnly ? '' : `
        <td>
          <button class="admin-btn admin-btn-sm encounter-edit-btn" data-id="${enc.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger encounter-delete-btn" data-id="${enc.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(enc.name)}</td>
          <td>${enc.type}</td>
          <td>${this.escapeHtml(summary)}</td>
          ${actions}
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();
    const addBtn = readOnly ? '' : '<button class="admin-btn" id="encounter-add-btn">+ Add Encounter</button>';
    const actionsHeader = readOnly ? '' : '<th>Actions</th>';

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Encounters (${encounters.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Summary</th>
                ${actionsHeader}
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private wireEncounterEvents(): void {
    document.getElementById('encounter-add-btn')?.addEventListener('click', () => {
      this.showEncounterModal(null);
    });

    document.querySelectorAll('.encounter-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        const displayContent = this.getDisplayContent();
        if (!displayContent) return;
        const encounter = displayContent.encounters[id];
        if (encounter) this.showEncounterModal(encounter);
      });
    });

    document.querySelectorAll('.encounter-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteEncounter(id);
      });
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private showEncounterModal(encounter: EncounterDefinition | null): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    const isNew = !encounter;
    const enc = encounter ?? { id: '', name: '', type: 'random' as const, monsterPool: [], roomMax: 9, placements: [] };

    // Remove any existing modal
    document.querySelector('.admin-encounter-modal-overlay')?.remove();

    const overlay = document.createElement('div');
    overlay.className = 'admin-encounter-modal-overlay';
    overlay.innerHTML = `
      <div class="admin-encounter-modal">
        <div class="admin-encounter-modal-header">
          <input type="text" id="enc-name" value="${this.escapeHtml(enc.name)}" placeholder="Encounter Name">
          <select id="enc-type">
            <option value="random" ${enc.type === 'random' ? 'selected' : ''}>Random</option>
            <option value="explicit" ${enc.type === 'explicit' ? 'selected' : ''}>Explicit</option>
          </select>
          <input type="hidden" id="enc-id" value="${this.escapeHtml(enc.id)}">
          <div class="admin-encounter-modal-actions">
            <button class="admin-btn" id="enc-save">${isNew ? 'Add' : 'Save'}</button>
            <button class="admin-btn admin-btn-secondary" id="enc-cancel">Cancel</button>
          </div>
        </div>
        <div class="admin-encounter-modal-body" id="enc-body">
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    // Render the body based on type
    this.renderEncounterModalBody(enc);

    // Wire events
    this.wireEncounterModalEvents(displayContent);
  }

  private renderEncounterModalBody(enc: EncounterDefinition): void {
    const body = document.getElementById('enc-body');
    if (!body) return;

    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const monsters = displayContent.monsters;

    const type = (document.getElementById('enc-type') as HTMLSelectElement)?.value ?? enc.type;

    if (type === 'random') {
      const poolRows = (enc.monsterPool ?? []).map((p, i) => this.renderEncPoolRow(i, p, monsters)).join('');
      body.innerHTML = `
        <div class="enc-random-body">
          <div class="enc-pool-section">
            <h4>Monster Pool <button class="admin-btn admin-btn-sm" id="enc-add-pool">+ Monster</button></h4>
            <div id="enc-pool-list">${poolRows}</div>
          </div>
          <div class="enc-room-max">
            <label>Room Max <input type="number" id="enc-room-max" value="${enc.roomMax ?? 9}" min="1" max="9"></label>
          </div>
        </div>
      `;
      this.wireEncPoolEvents(monsters);
    } else {
      const cells: string[] = [];
      for (let pos = 0; pos < 9; pos++) {
        const placement = (enc.placements ?? []).find(p => p.gridPosition === pos);
        const selectedId = placement?.monsterId ?? '';
        const options = `<option value="">Empty</option>` + Object.values(monsters).map(m =>
          `<option value="${m.id}" ${m.id === selectedId ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`
        ).join('');
        cells.push(`
          <div class="enc-grid-cell" data-pos="${pos}">
            <div class="enc-grid-pos">${pos}</div>
            <select class="enc-grid-monster">${options}</select>
          </div>
        `);
      }

      body.innerHTML = `
        <div class="enc-explicit-body">
          <h4>Monster Placements (3x3 Grid)</h4>
          <div class="enc-grid">
            ${cells.join('')}
          </div>
        </div>
      `;
    }
  }

  private renderEncPoolRow(index: number, entry: RandomMonsterEntry, monsters: Record<string, MonsterDefinition>): string {
    const options = Object.values(monsters).map(m =>
      `<option value="${m.id}" ${m.id === entry.monsterId ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`
    ).join('');

    return `
      <div class="enc-pool-row" data-index="${index}">
        <select class="enc-pool-monster">${options}</select>
        <label>Min<input type="number" class="enc-pool-min" value="${entry.min}" min="0" max="9"></label>
        <label>Max<input type="number" class="enc-pool-max" value="${entry.max}" min="0" max="9"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger enc-pool-remove">X</button>
      </div>
    `;
  }

  private wireEncPoolEvents(monsters: Record<string, MonsterDefinition>): void {
    document.getElementById('enc-add-pool')?.addEventListener('click', () => {
      const list = document.getElementById('enc-pool-list');
      if (!list) return;
      const index = list.children.length;
      const firstMonsterId = Object.keys(monsters)[0] ?? '';
      const entry: RandomMonsterEntry = { monsterId: firstMonsterId, min: 1, max: 1 };
      const row = document.createElement('div');
      row.innerHTML = this.renderEncPoolRow(index, entry, monsters);
      const newRow = row.firstElementChild as HTMLElement;
      list.appendChild(newRow);
      newRow.querySelector('.enc-pool-remove')?.addEventListener('click', () => newRow.remove());
    });

    document.querySelectorAll('.enc-pool-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        (btn as HTMLElement).closest('.enc-pool-row')?.remove();
      });
    });
  }

  private wireEncounterModalEvents(_displayContent: ContentData): void {
    // Type switching
    document.getElementById('enc-type')?.addEventListener('change', () => {
      const type = (document.getElementById('enc-type') as HTMLSelectElement).value as 'random' | 'explicit';
      const blankEnc: EncounterDefinition = {
        id: (document.getElementById('enc-id') as HTMLInputElement)?.value ?? '',
        name: (document.getElementById('enc-name') as HTMLInputElement)?.value ?? '',
        type,
        monsterPool: [],
        roomMax: 9,
        placements: [],
      };
      this.renderEncounterModalBody(blankEnc);
    });

    // Save
    document.getElementById('enc-save')?.addEventListener('click', () => {
      this.saveEncounter();
    });

    // Cancel
    document.getElementById('enc-cancel')?.addEventListener('click', () => {
      document.querySelector('.admin-encounter-modal-overlay')?.remove();
    });
  }

  private async saveEncounter(): Promise<void> {
    const existingId = (document.getElementById('enc-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('enc-name') as HTMLInputElement)?.value.trim();
    const type = (document.getElementById('enc-type') as HTMLSelectElement)?.value as 'random' | 'explicit';

    if (!name) {
      alert('Name is required.');
      return;
    }

    const id = existingId || crypto.randomUUID();

    const encounter: EncounterDefinition = { id, name, type };

    if (type === 'random') {
      const pool: RandomMonsterEntry[] = [];
      document.querySelectorAll('.enc-pool-row').forEach(row => {
        const monsterId = (row.querySelector('.enc-pool-monster') as HTMLSelectElement)?.value;
        const min = parseInt((row.querySelector('.enc-pool-min') as HTMLInputElement)?.value) || 0;
        const max = parseInt((row.querySelector('.enc-pool-max') as HTMLInputElement)?.value) || 0;
        if (monsterId) pool.push({ monsterId, min, max });
      });
      encounter.monsterPool = pool;
      encounter.roomMax = parseInt((document.getElementById('enc-room-max') as HTMLInputElement)?.value) || 9;
    } else {
      const placements: ExplicitPlacement[] = [];
      document.querySelectorAll('.enc-grid-cell').forEach(cell => {
        const pos = parseInt((cell as HTMLElement).dataset.pos!) as ExplicitPlacement['gridPosition'];
        const monsterId = (cell.querySelector('.enc-grid-monster') as HTMLSelectElement)?.value;
        if (monsterId) placements.push({ monsterId, gridPosition: pos });
      });
      encounter.placements = placements;
    }

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/encounters/${encodeURIComponent(id)}${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(encounter),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to save encounter');
        return;
      }
      this.updateDisplayEncounters(data.encounters);
      document.querySelector('.admin-encounter-modal-overlay')?.remove();
      this.renderTabContent();
    } catch {
      alert('Network error — could not save encounter');
    }
  }

  private async deleteEncounter(encounterId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const encounter = displayContent.encounters[encounterId];
    if (!encounter) return;
    if (!confirm(`Delete encounter "${encounter.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/encounters/${encodeURIComponent(encounterId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || 'Failed to delete encounter');
        return;
      }
      this.updateDisplayEncounters(data.encounters);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete encounter');
    }
  }

  private updateDisplayEncounters(encounters: Record<string, EncounterDefinition>): void {
    if (this.versionContent) {
      this.versionContent.encounters = encounters;
    }
  }

  // --- Tile Types ---

  private renderTileTypes(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const tileTypes = Object.values(displayContent.tileTypes ?? {});
    const items = displayContent.items;
    const readOnly = this.isReadOnly();
    const versionBar = this.renderVersionBar();

    const rows = tileTypes.map(t => {
      const itemName = t.requiredItemId ? (items[t.requiredItemId]?.name ?? t.requiredItemId) : '';
      return `<tr>
        <td>${this.escapeHtml(t.icon)}</td>
        <td>${this.escapeHtml(t.id)}</td>
        <td>${this.escapeHtml(t.name)}</td>
        <td><span class="color-swatch" style="background:${this.escapeHtml(t.color)}"></span> ${this.escapeHtml(t.color)}</td>
        <td>${t.traversable ? 'Yes' : 'No'}</td>
        <td>${this.escapeHtml(itemName)}</td>
        <td>${readOnly ? '' : `
          <button class="admin-btn admin-btn-sm tile-type-edit-btn" data-id="${this.escapeHtml(t.id)}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger tile-type-delete-btn" data-id="${this.escapeHtml(t.id)}">Del</button>
        `}</td>
      </tr>`;
    }).join('');

    const newBtn = readOnly ? '' : '<button class="admin-btn tile-type-new-btn">+ New Tile Type</button>';
    const seedBtn = !readOnly && tileTypes.length === 0
      ? '<button class="admin-btn tile-type-seed-btn" style="margin-left:8px">Restore Seed Data</button>'
      : '';

    return `<div class="admin-page">
      ${versionBar}
      <h2>Tile Types (${tileTypes.length})</h2>
      ${newBtn}${seedBtn}
      <table class="admin-table">
        <thead><tr><th>Icon</th><th>ID</th><th>Name</th><th>Color</th><th>Walk</th><th>Req. Item</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
  }

  private wireTileTypeEvents(): void {
    document.querySelectorAll('.tile-type-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.openTileTypeModal(id);
      });
    });
    document.querySelectorAll('.tile-type-delete-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = (btn as HTMLElement).dataset.id!;
        this.deleteTileType(id);
      });
    });
    document.querySelector('.tile-type-new-btn')?.addEventListener('click', () => {
      this.openTileTypeModal(null);
    });
    document.querySelector('.tile-type-seed-btn')?.addEventListener('click', () => {
      this.seedTileTypes();
    });
    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });
  }

  private openTileTypeModal(editId: string | null): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const existing = editId ? displayContent.tileTypes?.[editId] : null;
    const items = Object.values(displayContent.items);
    const itemOptions = items.map(i =>
      `<option value="${this.escapeHtml(i.id)}"${existing?.requiredItemId === i.id ? ' selected' : ''}>${this.escapeHtml(i.name)}</option>`
    ).join('');

    const modal = document.createElement('div');
    modal.className = 'admin-modal-overlay';
    modal.innerHTML = `<div class="admin-modal" style="max-width:460px">
      <h3>${existing ? 'Edit' : 'New'} Tile Type</h3>
      <div class="admin-form">
        <label>ID<input id="ttf-id" value="${this.escapeHtml(existing?.id ?? '')}" ${existing ? 'readonly' : ''}></label>
        <label>Name<input id="ttf-name" value="${this.escapeHtml(existing?.name ?? '')}"></label>
        <label>Icon (emoji)<input id="ttf-icon" value="${this.escapeHtml(existing?.icon ?? '')}"></label>
        <label>Color<input id="ttf-color" type="color" value="${existing?.color ?? '#888888'}"></label>
        <label><input id="ttf-traversable" type="checkbox" ${existing?.traversable !== false ? 'checked' : ''}> Traversable</label>
        <label>Required Item<select id="ttf-required-item"><option value="">(none)</option>${itemOptions}</select></label>
      </div>
      <div class="admin-modal-actions">
        <button class="admin-btn" id="ttf-save">Save</button>
        <button class="admin-btn admin-btn-secondary" id="ttf-cancel">Cancel</button>
      </div>
    </div>`;
    document.body.appendChild(modal);

    modal.querySelector('#ttf-cancel')!.addEventListener('click', () => modal.remove());
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

    modal.querySelector('#ttf-save')!.addEventListener('click', async () => {
      const id = (document.getElementById('ttf-id') as HTMLInputElement).value.trim();
      const name = (document.getElementById('ttf-name') as HTMLInputElement).value.trim();
      const icon = (document.getElementById('ttf-icon') as HTMLInputElement).value.trim();
      const color = (document.getElementById('ttf-color') as HTMLInputElement).value;
      const traversable = (document.getElementById('ttf-traversable') as HTMLInputElement).checked;
      const requiredItemId = (document.getElementById('ttf-required-item') as HTMLSelectElement).value || undefined;

      if (!id) { alert('ID is required.'); return; }
      if (!name) { alert('Name is required.'); return; }

      try {
        const qp = this.versionQueryParam();
        const res = await fetch(`/api/admin/tile-types/${encodeURIComponent(id)}${qp}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({ name, icon, color, traversable, requiredItemId }),
        });
        const data = await res.json();
        if (!res.ok) { alert(data.error || 'Failed to save tile type'); return; }
        this.updateDisplayTileTypes(data.tileTypes);
        modal.remove();
        this.renderTabContent();
      } catch {
        alert('Network error — could not save tile type');
      }
    });
  }

  private async deleteTileType(tileTypeId: string): Promise<void> {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const tt = displayContent.tileTypes?.[tileTypeId];
    if (!tt) return;
    if (!confirm(`Delete tile type "${tt.name}"?`)) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/tile-types/${encodeURIComponent(tileTypeId)}${qp}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to delete tile type'); return; }
      this.updateDisplayTileTypes(data.tileTypes);
      this.renderTabContent();
    } catch {
      alert('Network error — could not delete tile type');
    }
  }

  private async seedTileTypes(): Promise<void> {
    if (!confirm('Restore default tile types? This will add any missing seed types.')) return;
    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/tile-types/seed${qp}`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) { alert(data.error || 'Failed to seed tile types'); return; }
      this.updateDisplayTileTypes(data.tileTypes);
      this.renderTabContent();
    } catch {
      alert('Network error — could not seed tile types');
    }
  }

  private updateDisplayTileTypes(tileTypes: Record<string, TileTypeDefinition>): void {
    if (this.versionContent) {
      this.versionContent.tileTypes = tileTypes;
    }
  }

  // --- Versions ---

  private renderVersions(): string {
    const rows = this.versions.map(v => {
      const statusBadge = v.isActive
        ? '<span class="version-badge version-badge-active">Active</span>'
        : v.status === 'published'
          ? '<span class="version-badge version-badge-published">Published</span>'
          : '<span class="version-badge version-badge-draft">Draft</span>';

      const date = new Date(v.createdAt).toLocaleDateString();

      let actions = '';
      if (v.status === 'draft') {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="edit" data-id="${v.id}">Edit</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="publish" data-id="${v.id}">Publish</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger version-action" data-action="delete" data-id="${v.id}">Delete</button>
        `;
      } else if (v.isActive) {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="view" data-id="${v.id}">View</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="create-from" data-id="${v.id}">New Draft</button>
        `;
      } else {
        actions = `
          <button class="admin-btn admin-btn-sm version-action" data-action="view" data-id="${v.id}">View</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="deploy" data-id="${v.id}">Deploy</button>
          <button class="admin-btn admin-btn-sm version-action" data-action="create-from" data-id="${v.id}">New Draft</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger version-action" data-action="delete" data-id="${v.id}">Delete</button>
        `;
      }

      return `
        <tr>
          <td>${this.escapeHtml(v.name)}</td>
          <td>${statusBadge}</td>
          <td>${date}</td>
          <td class="version-actions-cell">${actions}</td>
        </tr>
      `;
    }).join('');

    const versionBar = this.renderVersionBar();

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>Versions</h2>
          <button class="admin-btn" id="version-create-new">+ New Draft</button>
        </div>
        ${versionBar}
        <div id="version-status" class="version-status"></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr><th>Name</th><th>Status</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="4" style="text-align:center;opacity:0.5">No versions yet</td></tr>'}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderVersionBar(): string {
    const version = this.versions.find(v => v.id === this.selectedVersionId);
    if (!version) return '';
    const isDraft = version.status === 'draft';
    const statusLabel = version.isActive
      ? '<span class="version-badge version-badge-active">Active</span>'
      : version.status === 'published'
        ? '<span class="version-badge version-badge-published">Published</span>'
        : '<span class="version-badge version-badge-draft">Draft</span>';
    const viewActiveBtn = !version.isActive && this.activeVersionId
      ? `<button class="admin-btn admin-btn-sm" id="version-bar-view-active">View Active</button>`
      : '';
    return `
      <div class="version-bar${isDraft ? ' version-bar-draft' : ' version-bar-readonly'}">
        <span>${isDraft ? 'Editing' : 'Viewing'}: <strong>${this.escapeHtml(version.name)}</strong></span>
        ${statusLabel}
        ${viewActiveBtn}
      </div>
    `;
  }

  private wireVersionEvents(): void {
    document.getElementById('version-create-new')?.addEventListener('click', () => {
      this.createDraftFromActive();
    });

    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });

    document.querySelectorAll('.version-action').forEach(btn => {
      btn.addEventListener('click', () => {
        const action = (btn as HTMLElement).dataset.action;
        const id = (btn as HTMLElement).dataset.id!;
        switch (action) {
          case 'edit': this.selectVersion(id); break;
          case 'view': this.selectVersion(id); break;
          case 'publish': this.publishVersion(id); break;
          case 'deploy': this.deployVersionAction(id); break;
          case 'delete': this.deleteVersion(id); break;
          case 'create-from': this.createDraftFrom(id); break;
        }
      });
    });
  }

  private async refreshVersions(): Promise<void> {
    try {
      const data = await this.fetchAdmin<{ versions: ContentVersion[]; activeVersionId: string | null }>('/api/admin/versions');
      this.versions = data.versions;
      this.activeVersionId = data.activeVersionId ?? null;
    } catch { /* keep stale */ }
  }

  private async selectVersion(versionId: string): Promise<void> {
    this.selectedVersionId = versionId;
    sessionStorage.setItem('adminVersionId', versionId);
    try {
      const snapshot = await this.fetchAdmin<ContentData>(`/api/admin/versions/${versionId}/content`);
      this.versionContent = snapshot;
    } catch {
      this.versionContent = null;
    }
    // Rebuild map data from the current display content
    this.rebuildMapDataFromDisplay();
    this.renderTabContent();
  }

  private async createDraftFromActive(): Promise<void> {
    const name = prompt('Draft name:');
    if (!name) return;
    try {
      await fetch('/api/admin/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, fromVersionId: this.activeVersionId }),
      });
      await this.refreshVersions();
      this.renderTabContent();
    } catch { /* ignore */ }
  }

  private async createDraftFrom(fromId: string): Promise<void> {
    const fromVersion = this.versions.find(v => v.id === fromId);
    const name = prompt('Draft name:', fromVersion ? `${fromVersion.name} (copy)` : '');
    if (!name) return;
    try {
      await fetch('/api/admin/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ name, fromVersionId: fromId }),
      });
      await this.refreshVersions();
      this.renderTabContent();
    } catch { /* ignore */ }
  }

  private async publishVersion(id: string): Promise<void> {
    if (!confirm('Publish this draft? It will become immutable.')) return;
    try {
      const res = await fetch(`/api/admin/versions/${id}/publish`, {
        method: 'POST',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        this.showVersionStatus(data.error || 'Failed to publish', true);
        return;
      }
      await this.refreshVersions();
      // Stay on the version (now read-only as published)
      this.renderTabContent();
    } catch { /* ignore */ }
  }

  private async deployVersionAction(id: string): Promise<void> {
    const version = this.versions.find(v => v.id === id);
    if (!confirm(`Deploy "${version?.name ?? id}" to the live game? Players on removed rooms will be relocated.`)) return;
    try {
      const res = await fetch(`/api/admin/versions/${id}/deploy`, {
        method: 'POST',
        credentials: 'include',
      });
      const data = await res.json();
      if (!res.ok) {
        this.showVersionStatus(data.error || 'Failed to deploy', true);
        return;
      }
      await this.refreshVersions();
      this.showVersionStatus(`Deployed! ${data.relocated ?? 0} parties relocated.`, false);
      this.renderTabContent();
    } catch { /* ignore */ }
  }

  private async deleteVersion(id: string): Promise<void> {
    if (!confirm('Delete this version?')) return;
    try {
      const res = await fetch(`/api/admin/versions/${id}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      if (!res.ok) {
        const data = await res.json();
        this.showVersionStatus(data.error || 'Failed to delete', true);
        return;
      }
      await this.refreshVersions();
      if (this.selectedVersionId === id && this.activeVersionId) {
        await this.selectVersion(this.activeVersionId);
        return; // selectVersion already re-renders
      }
      this.renderTabContent();
    } catch { /* ignore */ }
  }

  private showVersionStatus(msg: string, isError: boolean): void {
    const el = document.getElementById('version-status');
    if (el) {
      el.textContent = msg;
      el.className = `version-status ${isError ? 'version-status-error' : 'version-status-success'}`;
      setTimeout(() => { if (el) { el.textContent = ''; el.className = 'version-status'; } }, 5000);
    }
  }

  /** Get display content: always the selected version's content. */
  private getDisplayContent(): ContentData | null {
    return this.versionContent;
  }

  /** Whether the current display is read-only (published version selected). */
  private isReadOnly(): boolean {
    const version = this.versions.find(v => v.id === this.selectedVersionId);
    return !version || version.status !== 'draft';
  }

  /** Rebuild map data from whichever content is currently displayed. */
  private rebuildMapDataFromDisplay(): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    this.worldTileDefs.clear();
    const tiles: HexTile[] = [];
    for (const tileDef of displayContent.world.tiles) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      tiles.push(new HexTile(coord, tileDef.type, tileDef.zone));
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }
    this.mapTiles = tiles;
    this.computeAdjacentSlots();
  }

  /** Build the ?versionId= query string for API calls when editing a draft. */
  private versionQueryParam(): string {
    if (this.selectedVersionId) {
      const version = this.versions.find(v => v.id === this.selectedVersionId);
      if (version?.status === 'draft') return `?versionId=${this.selectedVersionId}`;
    }
    return '';
  }

  // --- XP Table ---

  private renderXpTable(): string {
    const rows: string[] = [];
    let cumulativeXp = 0;
    let cumulativeDays = 0;

    for (let level = 1; level <= 50; level++) {
      const xpNeeded = xpForNextLevel(level);
      cumulativeXp += xpNeeded;

      // Estimated daily income: solo 57,600 at L1, party at 557,000 at L10, doubling every 10 levels after
      let dailyIncome: number;
      if (level < 10) {
        // Interpolate from solo (57,600) to party (557,000) over levels 1-9
        const t = (level - 1) / 9;
        dailyIncome = 57600 + t * (557000 - 57600);
      } else {
        // Doubles every 10 levels from the L10 baseline
        dailyIncome = 557000 * Math.pow(2, (level - 10) / 10);
      }

      const daysToLevel = xpNeeded / dailyIncome;
      cumulativeDays += daysToLevel;
      const ratePerDay = xpNeeded / daysToLevel;
      const ratePerHour = ratePerDay / 24;
      const ratePerMinute = ratePerHour / 60;

      const daysStr = daysToLevel < 1
        ? `${(daysToLevel * 24).toFixed(1)}h`
        : `${daysToLevel.toFixed(1)}d`;

      rows.push(`
        <tr${level % 10 === 0 ? ' class="xp-table-milestone"' : ''}>
          <td>${level}</td>
          <td>${xpNeeded.toLocaleString()}</td>
          <td>${cumulativeXp.toLocaleString()}</td>
          <td>${daysStr}</td>
          <td>${cumulativeDays.toFixed(1)}d</td>
          <td>${Math.round(dailyIncome).toLocaleString()}</td>
          <td>${Math.round(ratePerHour).toLocaleString()}</td>
          <td>${Math.round(ratePerMinute).toLocaleString()}</td>
        </tr>
      `);
    }

    return `
      <div class="admin-page">
        <div class="admin-page-header">
          <h2>XP Table</h2>
          <p class="admin-page-subtitle">Formula: floor(18000 &times; L<sup>1.2</sup> &times; 1.06<sup>L</sup>) &mdash; Income model: 57.6k/day solo L1, 557k/day party L10, 2x per 10 levels</p>
        </div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table xp-table">
            <thead>
              <tr>
                <th>Level</th>
                <th>XP to Level</th>
                <th>Cumulative XP</th>
                <th>Est. Time</th>
                <th>Cumulative Time</th>
                <th>Rate/Day</th>
                <th>Rate/Hour</th>
                <th>Rate/Min</th>
              </tr>
            </thead>
            <tbody>${rows.join('')}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Map ---

  private renderMapSection(): string {
    const versionBar = this.renderVersionBar();
    return `
      <div class="admin-page admin-page-map">
        ${versionBar}
        <div class="admin-map-layout">
          <div class="admin-map-canvas-area">
            <div class="admin-map-controls">
              <span id="map-tile-count" class="admin-map-tile-count">World Map (${this.mapTiles.length} tiles)</span>
              <button class="admin-btn admin-btn-sm" id="map-zoom-in">+</button>
              <button class="admin-btn admin-btn-sm" id="map-zoom-out">-</button>
              <button class="admin-btn admin-btn-sm" id="map-reset">Reset</button>
              <span id="map-hover-info" class="admin-map-info"></span>
            </div>
            <canvas id="admin-map-canvas"></canvas>
          </div>
          <div class="admin-map-sidebar" id="admin-map-sidebar"></div>
        </div>
      </div>
    `;
  }

  /** Update the tile count display in the map header. */
  private updateMapTileCount(): void {
    const el = document.getElementById('map-tile-count');
    if (el) el.textContent = `World Map (${this.mapTiles.length} tiles)`;
  }

  private cleanupMapCanvas(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    if (this.mouseMoveHandler) {
      window.removeEventListener('mousemove', this.mouseMoveHandler);
      this.mouseMoveHandler = null;
    }
    if (this.mouseUpHandler) {
      window.removeEventListener('mouseup', this.mouseUpHandler);
      this.mouseUpHandler = null;
    }
    if (this.keydownHandler) {
      window.removeEventListener('keydown', this.keydownHandler);
      this.keydownHandler = null;
    }
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
      this.saveTimeout = null;
    }
    this.mapCanvas = null;
    this.mapCtx = null;
    this.mapInitialized = false;
    this.selectedTile = null;
  }

  private initMapCanvas(): void {
    this.cleanupMapCanvas();

    this.mapCanvas = document.getElementById('admin-map-canvas') as HTMLCanvasElement;
    if (!this.mapCanvas) return;
    this.mapCtx = this.mapCanvas.getContext('2d');

    const resizeCanvas = () => {
      if (!this.mapCanvas) return;
      const wrap = this.mapCanvas.parentElement;
      if (wrap) {
        // Buffer must match CSS display size to avoid hitbox coordinate mismatch
        this.mapCanvas.width = this.mapCanvas.clientWidth;
        this.mapCanvas.height = this.mapCanvas.clientHeight;
        if (!this.mapInitialized) {
          // Center on start tile
          const startPixel = this.getStartTilePixel();
          this.mapOffset = {
            x: this.mapCanvas.width / 2 - startPixel.x * this.mapZoom,
            y: this.mapCanvas.height / 2 - startPixel.y * this.mapZoom,
          };
          this.mapInitialized = true;
        }
        this.drawMap();
      }
    };
    this.resizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    // Pan (mouse)
    this.mapCanvas.addEventListener('mousedown', (e) => {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffsetStart = { ...this.mapOffset };
    });
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {
        this.hasDragged = true;
      }
      this.mapOffset = {
        x: this.dragOffsetStart.x + dx,
        y: this.dragOffsetStart.y + dy,
      };
      this.drawMap();
    };
    window.addEventListener('mousemove', this.mouseMoveHandler);
    this.mouseUpHandler = () => { this.isDragging = false; };
    window.addEventListener('mouseup', this.mouseUpHandler);

    // Click to select/add tile
    this.mapCanvas.addEventListener('click', (e) => {
      if (this.hasDragged) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.handleMapClick(e.clientX - rect.left, e.clientY - rect.top);
    });

    // Zoom (wheel)
    this.mapCanvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.mapZoom = Math.max(0.05, Math.min(3, this.mapZoom * delta));
      this.drawMap();
    });

    // Pan (touch)
    let lastTouch: { x: number; y: number } | null = null;
    this.mapCanvas.addEventListener('touchstart', (e) => {
      if (e.touches.length === 1) {
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.dragOffsetStart = { ...this.mapOffset };
      }
    });
    this.mapCanvas.addEventListener('touchmove', (e) => {
      e.preventDefault();
      if (e.touches.length === 1 && lastTouch) {
        this.mapOffset = {
          x: this.dragOffsetStart.x + (e.touches[0].clientX - lastTouch.x),
          y: this.dragOffsetStart.y + (e.touches[0].clientY - lastTouch.y),
        };
        this.drawMap();
      }
    });
    this.mapCanvas.addEventListener('touchend', () => { lastTouch = null; });

    // Delete key shortcut (only in edit mode)
    this.keydownHandler = (e: KeyboardEvent) => {
      if (this.isReadOnly()) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (this.selectedTile) {
          e.preventDefault();
          this.deleteSelectedTile();
        }
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    // Version bar "View Active" button (if present)
    document.getElementById('version-bar-view-active')?.addEventListener('click', () => {
      if (this.activeVersionId) this.selectVersion(this.activeVersionId);
    });

    // Hover info
    this.mapCanvas.addEventListener('mousemove', (e) => {
      if (this.isDragging) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.updateHoverInfo(e.clientX - rect.left, e.clientY - rect.top);
    });

    // Zoom controls
    document.getElementById('map-zoom-in')?.addEventListener('click', () => {
      this.mapZoom = Math.min(3, this.mapZoom * 1.3);
      this.drawMap();
    });
    document.getElementById('map-zoom-out')?.addEventListener('click', () => {
      this.mapZoom = Math.max(0.05, this.mapZoom * 0.7);
      this.drawMap();
    });
    document.getElementById('map-reset')?.addEventListener('click', () => {
      this.mapZoom = 1.0;
      const startPixel = this.getStartTilePixel();
      this.mapOffset = {
        x: this.mapCanvas!.width / 2 - startPixel.x * this.mapZoom,
        y: this.mapCanvas!.height / 2 - startPixel.y * this.mapZoom,
      };
      this.drawMap();
    });
  }

  /** Helper: draw a hex at (sx, sy) with given scale (1.0 = normal). */
  private drawHex(ctx: CanvasRenderingContext2D, corners: { x: number; y: number }[], sx: number, sy: number, zoom: number, scale = 1.0): void {
    ctx.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const cx = sx + corners[i].x * zoom * scale;
      const cy = sy + corners[i].y * zoom * scale;
      if (i === 0) ctx.moveTo(cx, cy);
      else ctx.lineTo(cx, cy);
    }
    ctx.closePath();
  }

  /** Helper: test if screen-space coord is within cull bounds. */
  private inBounds(sx: number, sy: number, canvas: HTMLCanvasElement, zoom: number, pad = 2): boolean {
    const margin = HEX_SIZE * zoom * pad;
    return sx > -margin && sx < canvas.width + margin && sy > -margin && sy < canvas.height + margin;
  }

  private drawMap(): void {
    const ctx = this.mapCtx;
    const canvas = this.mapCanvas;
    if (!ctx || !canvas) return;

    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#0d1b2a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const displayContent = this.getDisplayContent();
    const corners = getHexCorners(HEX_SIZE);
    const zoom = this.mapZoom;
    const ox = this.mapOffset.x;
    const oy = this.mapOffset.y;

    // Build zone lookup: "col,row" → zone string
    const zoneMap = new Map<string, string>();
    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      zoneMap.set(`${off.col},${off.row}`, tile.zone);
    }

    const selectedZone = this.selectedTile
      ? zoneMap.get(`${this.selectedTile.col},${this.selectedTile.row}`) ?? null
      : null;

    // Partition tiles into selected-zone vs other
    const otherTiles: HexTile[] = [];
    const zoneTiles: HexTile[] = [];
    let selectedHexTile: HexTile | null = null;

    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      const isSelected = this.selectedTile &&
        this.selectedTile.col === off.col &&
        this.selectedTile.row === off.row;
      if (isSelected) {
        selectedHexTile = tile;
      } else if (selectedZone && tile.zone === selectedZone) {
        zoneTiles.push(tile);
      } else {
        otherTiles.push(tile);
      }
    }

    // --- Layer 1: Adjacent slots (hidden in read-only mode) ---
    const showSlots = !this.isReadOnly();
    for (const slot of (showSlots ? this.adjacentSlots : [])) {
      const pixel = cubeToPixel(slot.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;

      this.drawHex(ctx, corners, sx, sy, zoom);

      ctx.fillStyle = 'rgba(255, 255, 255, 0.04)';
      ctx.fill();
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.15)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      // Draw + icon
      const plusSize = 14 * zoom;
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = Math.max(1.5, 3 * zoom);
      ctx.beginPath();
      ctx.moveTo(sx - plusSize, sy);
      ctx.lineTo(sx + plusSize, sy);
      ctx.moveTo(sx, sy - plusSize);
      ctx.lineTo(sx, sy + plusSize);
      ctx.stroke();
    }

    // --- Layer 2: Tiles NOT in the selected zone ---
    for (const tile of otherTiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;

      this.drawHex(ctx, corners, sx, sy, zoom);

      const ttDef = displayContent?.tileTypes?.[tile.type];
      ctx.fillStyle = ttDef ? ttDef.color : '#' + (TILE_CONFIGS[tile.type as import('@idle-party-rpg/shared').TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
      ctx.fill();
      ctx.strokeStyle = '#2a2a3e';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      this.drawNonTraversableMarker(ctx, tile, sx, sy, zoom);
      this.drawStartMarker(ctx, tile, sx, sy, zoom);
    }

    // --- Layer 3: Glow for selected zone boundary (multi-pass for gradient falloff) ---
    if (selectedZone) {
      const allZoneTiles = selectedHexTile ? [...zoneTiles, selectedHexTile] : zoneTiles;

      // Collect boundary edges once
      const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const tile of allZoneTiles) {
        const pixel = cubeToPixel(tile.coord);
        const sx = pixel.x * zoom + ox;
        const sy = pixel.y * zoom + oy;
        if (!this.inBounds(sx, sy, canvas, zoom, 4)) continue;

        for (let dir = 0; dir < 6; dir++) {
          const neighbor = getNeighbor(tile.coord, dir);
          const nOff = cubeToOffset(neighbor);
          const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
          if (nZone === selectedZone) continue;

          const [ei0, ei1] = DIR_TO_EDGE[dir];
          edges.push({
            x0: sx + corners[ei0].x * zoom,
            y0: sy + corners[ei0].y * zoom,
            x1: sx + corners[ei1].x * zoom,
            y1: sy + corners[ei1].y * zoom,
          });
        }
      }

      // Draw multiple passes: wide & faint → narrow & bright
      ctx.save();
      ctx.lineCap = 'round';
      const passes = [
        { width: Math.max(20, 40 * zoom), alpha: 0.04 },
        { width: Math.max(14, 28 * zoom), alpha: 0.08 },
        { width: Math.max(8, 16 * zoom), alpha: 0.15 },
        { width: Math.max(4, 8 * zoom), alpha: 0.25 },
        { width: Math.max(2, 4 * zoom), alpha: 0.4 },
      ];
      for (const pass of passes) {
        ctx.strokeStyle = `rgba(255, 255, 255, ${pass.alpha})`;
        ctx.lineWidth = pass.width;
        ctx.beginPath();
        for (const e of edges) {
          ctx.moveTo(e.x0, e.y0);
          ctx.lineTo(e.x1, e.y1);
        }
        ctx.stroke();
      }
      ctx.restore();
    }

    // --- Layer 4: Tiles IN the selected zone (covers inner shadow) ---
    for (const tile of zoneTiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;

      this.drawHex(ctx, corners, sx, sy, zoom);

      const ttDef = displayContent?.tileTypes?.[tile.type];
      ctx.fillStyle = ttDef ? ttDef.color : '#' + (TILE_CONFIGS[tile.type as import('@idle-party-rpg/shared').TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
      ctx.fill();
      ctx.strokeStyle = '#2a2a3e';
      ctx.lineWidth = 0.5;
      ctx.stroke();

      this.drawNonTraversableMarker(ctx, tile, sx, sy, zoom);
      this.drawStartMarker(ctx, tile, sx, sy, zoom);
    }

    // --- Layer 5: Yellow borders on zone-to-zone boundaries only ---
    ctx.save();
    ctx.strokeStyle = '#ffc845';
    ctx.lineWidth = Math.max(1.5, 2.5 * zoom);
    ctx.lineCap = 'round';

    for (const tile of this.mapTiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom, 3)) continue;

      const tileZone = tile.zone;
      for (let dir = 0; dir < 6; dir++) {
        const neighbor = getNeighbor(tile.coord, dir);
        const nOff = cubeToOffset(neighbor);
        const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
        // Only where neighbor tile exists AND is a different zone
        if (nZone === undefined || nZone === tileZone) continue;

        const [ei0, ei1] = DIR_TO_EDGE[dir];
        ctx.beginPath();
        ctx.moveTo(sx + corners[ei0].x * zoom, sy + corners[ei0].y * zoom);
        ctx.lineTo(sx + corners[ei1].x * zoom, sy + corners[ei1].y * zoom);
        ctx.stroke();
      }
    }
    ctx.restore();

    // --- Layer 6: Selected tile (drawn last, enlarged to "pop up") ---
    if (selectedHexTile) {
      const pixel = cubeToPixel(selectedHexTile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;

      // Shadow under the popped tile
      ctx.save();
      ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
      ctx.shadowBlur = Math.max(4, 8 * zoom);
      ctx.shadowOffsetY = Math.max(1, 3 * zoom);
      this.drawHex(ctx, corners, sx, sy, zoom, 1.08);
      const selTtDef = displayContent?.tileTypes?.[selectedHexTile.type];
      ctx.fillStyle = selTtDef ? selTtDef.color : '#' + (TILE_CONFIGS[selectedHexTile.type as import('@idle-party-rpg/shared').TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
      ctx.fill();
      ctx.restore();

      // Subtle outline + yellow only on zone-boundary edges
      const tileZone = selectedHexTile.zone;
      this.drawHex(ctx, corners, sx, sy, zoom, 1.08);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.25)';
      ctx.lineWidth = Math.max(1, 1.5 * zoom);
      ctx.stroke();

      // Draw yellow on edges that border a different zone
      const scale = 1.08;
      ctx.strokeStyle = '#ffc845';
      ctx.lineWidth = Math.max(2, 3 * zoom);
      ctx.lineCap = 'round';
      for (let dir = 0; dir < 6; dir++) {
        const neighbor = getNeighbor(selectedHexTile.coord, dir);
        const nOff = cubeToOffset(neighbor);
        const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
        if (nZone === undefined || nZone === tileZone) continue;
        const [ei0, ei1] = DIR_TO_EDGE[dir];
        ctx.beginPath();
        ctx.moveTo(sx + corners[ei0].x * zoom * scale, sy + corners[ei0].y * zoom * scale);
        ctx.lineTo(sx + corners[ei1].x * zoom * scale, sy + corners[ei1].y * zoom * scale);
        ctx.stroke();
      }

      this.drawNonTraversableMarker(ctx, selectedHexTile, sx, sy, zoom);
      this.drawStartMarker(ctx, selectedHexTile, sx, sy, zoom);
    }
  }

  /** Draw a red X on non-traversable tiles. */
  private drawNonTraversableMarker(ctx: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number): void {
    const displayContent = this.getDisplayContent();
    const ntDef = displayContent?.tileTypes?.[tile.type];
    const isTraversable = ntDef ? ntDef.traversable : (TILE_CONFIGS[tile.type as import('@idle-party-rpg/shared').TileType]?.traversable ?? true);
    if (isTraversable) return;
    const size = Math.max(5, 10 * zoom);
    ctx.save();
    ctx.strokeStyle = 'rgba(255, 60, 60, 0.7)';
    ctx.lineWidth = Math.max(1.5, 2.5 * zoom);
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(sx - size, sy - size);
    ctx.lineTo(sx + size, sy + size);
    ctx.moveTo(sx + size, sy - size);
    ctx.lineTo(sx - size, sy + size);
    ctx.stroke();
    ctx.restore();
  }

  /** Draw the star marker if this tile is the start tile. */
  private drawStartMarker(ctx: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number): void {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;
    const offset = cubeToOffset(tile.coord);
    if (displayContent.world.startTile.col === offset.col &&
        displayContent.world.startTile.row === offset.row) {
      ctx.save();
      ctx.font = `${Math.max(10, 16 * zoom)}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#ffc845';
      ctx.fillText('\u2605', sx, sy);
      ctx.restore();
    }
  }

  /** Hit-test a click on the canvas and select or create a tile. */
  private handleMapClick(mx: number, my: number): void {
    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;

    // Use proper hex rounding to find which hex was clicked
    const clickedCube = pixelToCube({ x: worldX, y: worldY });
    const clickedOffset = cubeToOffset(clickedCube);
    const clickedKey = `${clickedOffset.col},${clickedOffset.row}`;

    // Check existing tiles first
    const tileDef = this.worldTileDefs.get(clickedKey);
    if (tileDef) {
      this.selectedTile = tileDef;
      this.drawMap();
      this.renderSidebar();
      return;
    }

    // Check adjacent slots (only allow adding in editable mode)
    if (!this.isReadOnly()) {
      const clickedSlot = this.adjacentSlots.find(s =>
        cubeEquals(s.coord, clickedCube)
      );
      if (clickedSlot) {
        this.addTileAtSlot(clickedSlot);
        return;
      }
    }

    // Clicked empty space — deselect
    this.selectedTile = null;
    this.drawMap();
    this.renderSidebar();
  }

  /** Create a new tile at an adjacent slot with defaults. */
  private async addTileAtSlot(slot: AdjacentSlot): Promise<void> {
    if (this.isReadOnly()) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    // Default zone: prefer the currently selected tile's zone if it's a neighbor,
    // otherwise inherit from the first neighboring tile
    const neighbors = getNeighbors(slot.coord);
    const selectedZone = this.selectedTile?.zone;
    let defaultZone = 'unknown';
    let fallbackZone = 'unknown';
    for (const neighborCoord of neighbors) {
      const offset = cubeToOffset(neighborCoord);
      const neighborDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
      if (neighborDef) {
        if (fallbackZone === 'unknown') fallbackZone = neighborDef.zone;
        if (selectedZone && neighborDef.zone === selectedZone) {
          defaultZone = selectedZone;
          break;
        }
      }
    }
    if (defaultZone === 'unknown') defaultZone = fallbackZone;

    const newTile: WorldTileDefinition = {
      id: '',
      col: slot.col,
      row: slot.row,
      type: this.selectedTile?.type ?? 'plains',
      zone: defaultZone,
      name: this.selectedTile?.name ?? 'Default Room Name',
      encounterTable: this.selectedTile?.encounterTable
        ? [...this.selectedTile.encounterTable]
        : undefined,
    };

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/world/tile${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(newTile),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showSidebarError(data.error || 'Failed to add tile');
        return;
      }
      this.updateDisplayWorld(data.world);
      // Use the server-returned tile (which has the assigned GUID)
      this.selectedTile = this.worldTileDefs.get(`${newTile.col},${newTile.row}`) ?? newTile;
      this.drawMap();
      this.updateMapTileCount();
      this.renderSidebar(true);
    } catch {
      this.showSidebarError('Network error — could not add tile');
    }
  }

  /** Save the currently selected tile to the server (debounced). */
  private scheduleSave(): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.saveSelectedTile(), 300);
  }

  private async saveSelectedTile(): Promise<void> {
    if (!this.selectedTile) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/world/tile${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(this.selectedTile),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showSidebarError(data.error || 'Failed to save tile');
        return;
      }
      this.updateDisplayWorld(data.world);
      // Re-select the tile from the updated data
      this.selectedTile = this.worldTileDefs.get(
        `${this.selectedTile.col},${this.selectedTile.row}`
      ) ?? null;
      this.drawMap();
    } catch {
      this.showSidebarError('Network error — could not save tile');
    }
  }

  /** Delete the currently selected tile. */
  private async deleteSelectedTile(): Promise<void> {
    if (!this.selectedTile) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/world/tile${qp}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ col: this.selectedTile.col, row: this.selectedTile.row }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showSidebarError(data.error || 'Failed to delete tile');
        return;
      }
      this.updateDisplayWorld(data.world);
      this.selectedTile = null;
      this.drawMap();
      this.updateMapTileCount();
      this.renderSidebar();
    } catch {
      this.showSidebarError('Network error — could not delete tile');
    }
  }

  /** Set the currently selected tile as the start tile. */
  private async setAsStartTile(): Promise<void> {
    if (!this.selectedTile) return;
    const displayContent = this.getDisplayContent();
    if (!displayContent) return;

    try {
      const qp = this.versionQueryParam();
      const res = await fetch(`/api/admin/world/start-tile${qp}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ col: this.selectedTile.col, row: this.selectedTile.row }),
      });
      const data = await res.json();
      if (!res.ok) {
        this.showSidebarError(data.error || 'Failed to set start tile');
        return;
      }
      this.updateDisplayWorld(data.world);
      this.drawMap();
      this.renderSidebar();
    } catch {
      this.showSidebarError('Network error — could not set start tile');
    }
  }

  /** Update the world data on the currently displayed version, then rebuild. */
  private updateDisplayWorld(world: WorldData): void {
    if (this.versionContent) {
      this.versionContent.world = world;
    }
    this.rebuildMapDataFromDisplay();
  }

  // --- Sidebar ---

  private renderSidebar(focusName = false): void {
    const sidebar = document.getElementById('admin-map-sidebar');
    if (!sidebar) return;

    const readOnly = this.isReadOnly();

    if (!this.selectedTile) {
      const hint = readOnly
        ? 'Click a room to view details. This version is read-only.'
        : 'Click a room to edit, or click + to add a new room.';
      sidebar.innerHTML = `
        <div class="admin-map-sidebar-header">Room Editor</div>
        <div class="admin-map-sidebar-placeholder">${hint}</div>
      `;
      return;
    }

    const tile = this.selectedTile;
    const displayContent = this.getDisplayContent();
    const zones = displayContent ? Object.values(displayContent.zones) : [];
    const startTile = displayContent?.world.startTile;
    const isStart = startTile && startTile.col === tile.col && startTile.row === tile.row;
    const tileTypeDefs = displayContent ? Object.values(displayContent.tileTypes ?? {}) : [];
    const tileTypeDef = displayContent?.tileTypes?.[tile.type];
    const isTraversable = tileTypeDef ? tileTypeDef.traversable : (TILE_CONFIGS[tile.type as import('@idle-party-rpg/shared').TileType]?.traversable ?? false);
    const disabled = readOnly ? ' disabled' : '';

    const typeOptions = tileTypeDefs
      .filter(t => t.id !== 'void')
      .map(t => {
        const prefix = !t.traversable ? '(X) ' : '';
        return `<option value="${t.id}"${t.id === tile.type ? ' selected' : ''}>${prefix}${this.escapeHtml(t.name)}</option>`;
      }).join('');

    const zoneOptions = zones.map(z =>
      `<option value="${z.id}"${z.id === tile.zone ? ' selected' : ''}>${z.displayName}</option>`
    ).join('');

    const shops = displayContent ? Object.values(displayContent.shops ?? {}) : [];
    const shopOptions = [`<option value="">(none)</option>`].concat(shops.map(s =>
      `<option value="${s.id}"${s.id === (tile.shopId ?? '') ? ' selected' : ''}>${this.escapeHtml(s.name)}</option>`
    )).join('');

    let startBtnHtml = '';
    if (!readOnly) {
      startBtnHtml = isStart
        ? `<div class="admin-map-sidebar-start-badge">\u2605 Start Tile</div>`
        : isTraversable
          ? `<button class="admin-btn admin-map-start-btn" id="sidebar-set-start">Set as Start Tile</button>`
          : '';
    } else if (isStart) {
      startBtnHtml = `<div class="admin-map-sidebar-start-badge">\u2605 Start Tile</div>`;
    }

    const deleteBtnHtml = readOnly ? '' : (isStart
      ? `<button class="admin-btn admin-map-delete-btn" disabled title="Cannot delete the start tile">Delete Room</button>
         <div class="admin-map-sidebar-hint">Assign a different start tile before deleting.</div>`
      : `<button class="admin-btn admin-map-delete-btn" id="sidebar-delete">Delete Room</button>`);

    sidebar.innerHTML = `
      <div class="admin-map-sidebar-header">Room ${readOnly ? 'Info' : 'Editor'}</div>
      <div class="admin-map-sidebar-fields">
        <div class="admin-map-sidebar-field">
          <label>Room Name</label>
          <input type="text" id="sidebar-name" value="${this.escapeHtml(tile.name)}"${disabled} />
        </div>
        <div class="admin-map-sidebar-field">
          <label>Type</label>
          <select id="sidebar-type"${disabled}>${typeOptions}</select>
        </div>
        <div class="admin-map-sidebar-field">
          <label>Zone</label>
          <select id="sidebar-zone"${disabled}>${zoneOptions}</select>
        </div>
        <div class="admin-map-sidebar-field">
          <label>Shop</label>
          <select id="sidebar-shop"${disabled}>${shopOptions}</select>
        </div>
        <div class="admin-map-sidebar-field">
          <label>Required Item (override)</label>
          <select id="sidebar-required-item"${disabled}>
            <option value="">(use type default)</option>
            ${Object.values(displayContent?.items ?? {}).map(i =>
              `<option value="${this.escapeHtml(i.id)}"${i.id === (tile.requiredItemId ?? '') ? ' selected' : ''}>${this.escapeHtml(i.name)}</option>`
            ).join('')}
          </select>
        </div>
        <div class="admin-map-sidebar-field">
          <label>Coordinates</label>
          <div class="admin-map-sidebar-coords">(${tile.col}, ${tile.row})</div>
        </div>
        <div class="admin-map-sidebar-field">
          <label>
            <input type="checkbox" id="sidebar-custom-encounters" ${tile.encounterTable?.length ? 'checked' : ''}${disabled} />
            Custom Encounters
          </label>
        </div>
        <div id="sidebar-encounters-section" style="${tile.encounterTable?.length ? '' : 'display:none'}">
          ${this.renderSidebarEncounterRows(tile, displayContent ? Object.values(displayContent.encounters) : [], readOnly)}
        </div>
        ${startBtnHtml}
        <div class="admin-map-sidebar-spacer"></div>
        ${deleteBtnHtml}
        <div id="sidebar-error" class="admin-map-sidebar-error"></div>
      </div>
    `;

    // Wire events
    const nameInput = document.getElementById('sidebar-name') as HTMLInputElement;
    const typeSelect = document.getElementById('sidebar-type') as HTMLSelectElement;
    const zoneSelect = document.getElementById('sidebar-zone') as HTMLSelectElement;

    nameInput?.addEventListener('input', () => {
      if (this.selectedTile) {
        this.selectedTile.name = nameInput.value;
        this.scheduleSave();
      }
    });

    typeSelect?.addEventListener('change', () => {
      if (this.selectedTile) {
        this.selectedTile.type = typeSelect.value;
        this.scheduleSave();
        // Re-render sidebar to update start tile button visibility
        this.renderSidebar();
      }
    });

    zoneSelect?.addEventListener('change', () => {
      if (this.selectedTile) {
        this.selectedTile.zone = zoneSelect.value;
        this.scheduleSave();
      }
    });

    const shopSelect = document.getElementById('sidebar-shop') as HTMLSelectElement;
    shopSelect?.addEventListener('change', () => {
      if (this.selectedTile) {
        const val = shopSelect.value;
        if (val) {
          this.selectedTile.shopId = val;
        } else {
          delete this.selectedTile.shopId;
        }
        this.scheduleSave();
      }
    });

    const requiredItemSelect = document.getElementById('sidebar-required-item') as HTMLSelectElement;
    requiredItemSelect?.addEventListener('change', () => {
      if (this.selectedTile) {
        const val = requiredItemSelect.value;
        if (val) {
          this.selectedTile.requiredItemId = val;
        } else {
          delete this.selectedTile.requiredItemId;
        }
        this.scheduleSave();
      }
    });

    const customEncCheck = document.getElementById('sidebar-custom-encounters') as HTMLInputElement;
    customEncCheck?.addEventListener('change', () => {
      const section = document.getElementById('sidebar-encounters-section');
      if (section && this.selectedTile) {
        if (customEncCheck.checked) {
          if (!this.selectedTile.encounterTable || this.selectedTile.encounterTable.length === 0) {
            this.selectedTile.encounterTable = [];
          }
          section.style.display = '';
          const displayContent = this.getDisplayContent();
          section.innerHTML = this.renderSidebarEncounterRows(this.selectedTile, displayContent ? Object.values(displayContent.encounters) : [], this.isReadOnly());
          this.wireSidebarEncounterEvents();
        } else {
          delete this.selectedTile.encounterTable;
          section.style.display = 'none';
          this.scheduleSave();
        }
      }
    });

    this.wireSidebarEncounterEvents();

    document.getElementById('sidebar-set-start')?.addEventListener('click', () => {
      this.setAsStartTile();
    });

    document.getElementById('sidebar-delete')?.addEventListener('click', () => {
      this.deleteSelectedTile();
    });

    if (focusName && nameInput) {
      nameInput.focus();
      nameInput.select();
    }
  }

  private renderSidebarEncounterRows(tile: WorldTileDefinition, encounters: EncounterDefinition[], readOnly: boolean): string {
    const disabled = readOnly ? ' disabled' : '';
    const entries = tile.encounterTable ?? [];
    const rows = entries.map((e, i) => {
      const options = encounters.map(enc =>
        `<option value="${enc.id}" ${enc.id === e.encounterId ? 'selected' : ''}>${this.escapeHtml(enc.name)}</option>`
      ).join('');
      return `
        <div class="monster-drop-row sidebar-enc-row" data-index="${i}">
          <select class="sidebar-enc-encounter"${disabled}>${options}</select>
          <label class="zf-enc-inline">W<input type="number" class="sidebar-enc-weight" value="${e.weight}" min="1" step="1"${disabled}></label>
          ${readOnly ? '' : '<button class="admin-btn admin-btn-sm admin-btn-danger sidebar-enc-remove">X</button>'}
        </div>
      `;
    }).join('');

    const addBtn = readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="sidebar-add-encounter">+ Encounter</button>';
    return `${addBtn}<div id="sidebar-encounters-list">${rows}</div>`;
  }

  private wireSidebarEncounterEvents(): void {
    document.getElementById('sidebar-add-encounter')?.addEventListener('click', () => {
      if (!this.selectedTile) return;
      const displayContent = this.getDisplayContent();
      const encounterDefs = displayContent ? Object.values(displayContent.encounters) : [];
      if (encounterDefs.length === 0) return;

      if (!this.selectedTile.encounterTable) this.selectedTile.encounterTable = [];
      this.selectedTile.encounterTable.push({ encounterId: encounterDefs[0].id, weight: 1 });
      this.scheduleSave();

      // Re-render encounter section
      const section = document.getElementById('sidebar-encounters-section');
      if (section) {
        section.innerHTML = this.renderSidebarEncounterRows(this.selectedTile, encounterDefs, this.isReadOnly());
        this.wireSidebarEncounterEvents();
      }
    });

    // Wire remove buttons
    document.querySelectorAll('.sidebar-enc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.selectedTile?.encounterTable) return;
        const row = (btn as HTMLElement).closest('.sidebar-enc-row');
        const index = parseInt(row?.getAttribute('data-index') ?? '-1');
        if (index >= 0) {
          this.selectedTile.encounterTable.splice(index, 1);
          this.scheduleSave();
          const section = document.getElementById('sidebar-encounters-section');
          const displayContent = this.getDisplayContent();
          if (section) {
            section.innerHTML = this.renderSidebarEncounterRows(this.selectedTile, displayContent ? Object.values(displayContent.encounters) : [], this.isReadOnly());
            this.wireSidebarEncounterEvents();
          }
        }
      });
    });

    // Wire change events on all encounter inputs
    document.querySelectorAll('.sidebar-enc-row').forEach(row => {
      const index = parseInt(row.getAttribute('data-index') ?? '-1');
      if (index < 0) return;

      row.querySelector('.sidebar-enc-encounter')?.addEventListener('change', (e) => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].encounterId = (e.target as HTMLSelectElement).value;
          this.scheduleSave();
        }
      });

      row.querySelector('.sidebar-enc-weight')?.addEventListener('input', (e) => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].weight = parseInt((e.target as HTMLInputElement).value) || 1;
          this.scheduleSave();
        }
      });
    });
  }

  private showSidebarError(message: string): void {
    const errorEl = document.getElementById('sidebar-error');
    if (errorEl) {
      errorEl.textContent = message;
      setTimeout(() => { if (errorEl) errorEl.textContent = ''; }, 5000);
    }
  }

  private updateHoverInfo(mx: number, my: number): void {
    const infoEl = document.getElementById('map-hover-info');
    if (!infoEl) return;

    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;

    const hoveredCube = pixelToCube({ x: worldX, y: worldY });
    const hoveredOffset = cubeToOffset(hoveredCube);
    const hoveredKey = `${hoveredOffset.col},${hoveredOffset.row}`;

    // Check existing tiles
    const tileDef = this.worldTileDefs.get(hoveredKey);
    if (tileDef) {
      infoEl.textContent = `${tileDef.type} (${hoveredOffset.col}, ${hoveredOffset.row}) — ${tileDef.zone} — ${tileDef.name}`;
      return;
    }

    // Check adjacent slots
    const slot = this.adjacentSlots.find(s => cubeEquals(s.coord, hoveredCube));
    if (slot) {
      infoEl.textContent = `+ New room (${slot.col}, ${slot.row})`;
    } else {
      infoEl.textContent = '';
    }
  }

  /** Get the pixel position of the start tile (or world origin if none). */
  private getStartTilePixel(): { x: number; y: number } {
    const displayContent = this.getDisplayContent();
    if (displayContent) {
      const { col, row } = displayContent.world.startTile;
      const coord = offsetToCube({ col, row });
      return cubeToPixel(coord);
    }
    return { x: 0, y: 0 };
  }

  private escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
}
