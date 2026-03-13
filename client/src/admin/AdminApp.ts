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
  TileType,
} from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  ItemDefinition,
  ZoneDefinition,
  EncounterTableEntry,
  WorldTileDefinition,
  WorldData,
  CubeCoord,
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

interface AccountData {
  email: string;
  username: string | null;
  verified: boolean;
  createdAt: string;
  isOnline: boolean;
}

interface ContentData {
  monsters: Record<string, MonsterDefinition>;
  items: Record<string, ItemDefinition>;
  zones: Record<string, ZoneDefinition>;
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

type TabId = 'overview' | 'accounts' | 'monsters' | 'items' | 'zones' | 'map' | 'versions';

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
  { id: 'zones', label: 'Zones', icon: '#' },
  { id: 'map', label: 'Map', icon: '*' },
  { id: 'versions', label: 'Versions', icon: 'V' },
];

/** Tile types available in the editor dropdown (excludes Void). */
const EDITABLE_TILE_TYPES = [
  TileType.Plains,
  TileType.Forest,
  TileType.Mountain,
  TileType.Water,
  TileType.Town,
  TileType.Dungeon,
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
  private activeVersionId: string | null = null;
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

      // Always view a version — select the active one (or first available)
      const initialVersionId = this.activeVersionId ?? this.versions[0]?.id ?? null;
      if (initialVersionId) {
        await this.selectVersion(initialVersionId);
      }

      // Restore last active tab from sessionStorage
      const saved = sessionStorage.getItem('adminTab') as TabId | null;
      if (saved && TABS.some(t => t.id === saved)) {
        this.activeTab = saved;
      }

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

    this.renderTabContent();
  }

  private switchTab(tabId: TabId): void {
    if (tabId === this.activeTab) return;

    // Clean up map if leaving map tab
    if (this.activeTab === 'map') {
      this.cleanupMapCanvas();
    }

    this.activeTab = tabId;
    sessionStorage.setItem('adminTab', tabId);

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
        break;
      case 'monsters':
        content.innerHTML = this.renderMonsters();
        this.wireMonsterEvents();
        break;
      case 'items':
        content.innerHTML = this.renderItems();
        this.wireItemEvents();
        break;
      case 'zones':
        content.innerHTML = this.renderZones();
        this.wireZoneEvents();
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

  private renderAccounts(): string {
    const rows = this.accounts.map(a => `
      <tr>
        <td>${a.username ?? '<em>none</em>'}</td>
        <td>${a.email}</td>
        <td>${a.isOnline ? '<span class="status-online">Online</span>' : '<span class="status-offline">Offline</span>'}</td>
        <td>${a.verified ? 'Yes' : 'No'}</td>
        <td>${new Date(a.createdAt).toLocaleDateString()}</td>
      </tr>
    `).join('');

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Accounts (${this.accounts.length})</h2></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Username</th>
                <th>Email</th>
                <th>Status</th>
                <th>Verified</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
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
        return `${item?.name ?? d.itemId} (${Math.round(d.chance * 100)}%)`;
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
          <td>${m.level}</td>
          <td>${m.hp}</td>
          <td>${m.damage}</td>
          <td>${m.damageType}</td>
          <td>${m.xp}</td>
          <td>${m.goldMin}-${m.goldMax}</td>
          <td>${drops}</td>
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
                <th>Lv</th>
                <th>HP</th>
                <th>Dmg</th>
                <th>Type</th>
                <th>XP</th>
                <th>Gold</th>
                <th>Drops</th>
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
    const m = monster ?? { id: '', name: '', level: 1, hp: 10, damage: 3, damageType: 'physical' as const, xp: 5, goldMin: 1, goldMax: 2, drops: [] };
    const items = Object.values(displayContent.items);

    const dropRows = (m.drops ?? []).map((d, i) => this.renderDropRow(i, d.itemId, d.chance, items)).join('');

    area.innerHTML = `
      <div class="pixel-panel monster-form">
        <h3>${isNew ? 'Add Monster' : `Edit: ${this.escapeHtml(m.name)}`}</h3>
        <div class="monster-form-grid">
          <label>ID<input type="text" id="mf-id" value="${this.escapeHtml(m.id)}" ${isNew ? '' : 'disabled'}></label>
          <label>Name<input type="text" id="mf-name" value="${this.escapeHtml(m.name)}"></label>
          <label>Level<input type="number" id="mf-level" value="${m.level}" min="1"></label>
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

    return `
      <div class="monster-drop-row" data-index="${index}">
        <select class="mf-drop-item">${options}</select>
        <input type="number" class="mf-drop-chance" value="${Math.round(chance * 100)}" min="1" max="100" step="1">
        <span>%</span>
        <button class="admin-btn admin-btn-sm admin-btn-danger mf-drop-remove">X</button>
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

    document.getElementById('mf-save')?.addEventListener('click', () => {
      this.saveMonsterForm();
    });

    // Auto-generate ID from name for new monsters
    const idInput = document.getElementById('mf-id') as HTMLInputElement | null;
    const nameInput = document.getElementById('mf-name') as HTMLInputElement | null;
    if (idInput && nameInput && !idInput.disabled) {
      nameInput.addEventListener('input', () => {
        idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      });
    }
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

  private async saveMonsterForm(): Promise<void> {
    const id = (document.getElementById('mf-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('mf-name') as HTMLInputElement)?.value.trim();
    const level = parseInt((document.getElementById('mf-level') as HTMLInputElement)?.value);
    const hp = parseInt((document.getElementById('mf-hp') as HTMLInputElement)?.value);
    const damage = parseInt((document.getElementById('mf-damage') as HTMLInputElement)?.value);
    const damageType = (document.getElementById('mf-damageType') as HTMLSelectElement)?.value;
    const xp = parseInt((document.getElementById('mf-xp') as HTMLInputElement)?.value);
    const goldMin = parseInt((document.getElementById('mf-goldMin') as HTMLInputElement)?.value);
    const goldMax = parseInt((document.getElementById('mf-goldMax') as HTMLInputElement)?.value);

    if (!id || !name) {
      alert('ID and Name are required.');
      return;
    }

    const drops: { itemId: string; chance: number }[] = [];
    document.querySelectorAll('.monster-drop-row').forEach(row => {
      const itemId = (row.querySelector('.mf-drop-item') as HTMLSelectElement)?.value;
      const chance = parseInt((row.querySelector('.mf-drop-chance') as HTMLInputElement)?.value) / 100;
      if (itemId && chance > 0) drops.push({ itemId, chance });
    });

    const monster: MonsterDefinition = {
      id, name, level, hp, damage,
      damageType: damageType as 'physical' | 'magical',
      xp, goldMin, goldMax,
      drops: drops.length > 0 ? drops : undefined,
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
    const items = Object.values(displayContent.items);
    const readOnly = this.isReadOnly();

    const rows = items.map(i => {
      const effects: string[] = [];
      if (i.bonusAttackMin != null && i.bonusAttackMax != null && i.bonusAttackMax > 0) {
        effects.push(`+${i.bonusAttackMin}-${i.bonusAttackMax} Atk`);
      }
      if (i.damageReductionMin != null && i.damageReductionMax != null && i.damageReductionMax > 0) {
        effects.push(`${i.damageReductionMin}-${i.damageReductionMax} DR`);
      }
      if (i.dodgeChance != null && i.dodgeChance > 0) {
        effects.push(`${Math.round(i.dodgeChance * 100)}% Dodge`);
      }

      const actions = readOnly ? '' : `
        <td class="monster-actions-cell">
          <button class="admin-btn admin-btn-sm item-edit-btn" data-id="${i.id}">Edit</button>
          <button class="admin-btn admin-btn-sm admin-btn-danger item-delete-btn" data-id="${i.id}">Del</button>
        </td>
      `;

      return `
        <tr>
          <td>${this.escapeHtml(i.name)}</td>
          <td><span class="rarity-${i.rarity}">${i.rarity}</span></td>
          <td>${i.equipSlot ?? '-'}</td>
          <td>${effects.length > 0 ? effects.join(', ') : 'Material'}</td>
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
          <h2>Items (${items.length})</h2>
          ${addBtn}
        </div>
        ${versionBar}
        <div id="item-form-area"></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Rarity</th>
                <th>Slot</th>
                <th>Effects</th>
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
    const area = document.getElementById('item-form-area');
    if (!area) return;

    const isNew = !item;
    const i = item ?? { id: '', name: '', rarity: 'common' as const };

    const rarityOptions = ['janky', 'common'].map(r =>
      `<option value="${r}" ${i.rarity === r ? 'selected' : ''}>${r}</option>`
    ).join('');

    const slotOptions = ['', 'head', 'chest', 'hand', 'foot'].map(s =>
      `<option value="${s}" ${(i.equipSlot ?? '') === s ? 'selected' : ''}>${s || '(none - material)'}</option>`
    ).join('');

    area.innerHTML = `
      <div class="pixel-panel monster-form">
        <h3>${isNew ? 'Add Item' : `Edit: ${this.escapeHtml(i.name)}`}</h3>
        <div class="monster-form-grid">
          <label>ID<input type="text" id="if-id" value="${this.escapeHtml(i.id)}" ${isNew ? '' : 'disabled'}></label>
          <label>Name<input type="text" id="if-name" value="${this.escapeHtml(i.name)}"></label>
          <label>Rarity<select id="if-rarity">${rarityOptions}</select></label>
          <label>Equip Slot<select id="if-equipSlot">${slotOptions}</select></label>
          <label>Attack Min<input type="number" id="if-atkMin" value="${i.bonusAttackMin ?? 0}" min="0"></label>
          <label>Attack Max<input type="number" id="if-atkMax" value="${i.bonusAttackMax ?? 0}" min="0"></label>
          <label>DR Min<input type="number" id="if-drMin" value="${i.damageReductionMin ?? 0}" min="0"></label>
          <label>DR Max<input type="number" id="if-drMax" value="${i.damageReductionMax ?? 0}" min="0"></label>
          <label>Dodge %<input type="number" id="if-dodge" value="${i.dodgeChance != null ? Math.round(i.dodgeChance * 100) : 0}" min="0" max="100" step="1"></label>
        </div>
        <div class="monster-form-actions">
          <button class="admin-btn" id="if-save">${isNew ? 'Add' : 'Save'}</button>
          <button class="admin-btn admin-btn-secondary" id="if-cancel">Cancel</button>
        </div>
      </div>
    `;

    document.getElementById('if-cancel')?.addEventListener('click', () => {
      area.innerHTML = '';
    });

    document.getElementById('if-save')?.addEventListener('click', () => {
      this.saveItemForm();
    });

    // Auto-generate ID from name for new items
    const idInput = document.getElementById('if-id') as HTMLInputElement | null;
    const nameInput = document.getElementById('if-name') as HTMLInputElement | null;
    if (idInput && nameInput && !idInput.disabled) {
      nameInput.addEventListener('input', () => {
        idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      });
    }
  }

  private async saveItemForm(): Promise<void> {
    const id = (document.getElementById('if-id') as HTMLInputElement)?.value.trim();
    const name = (document.getElementById('if-name') as HTMLInputElement)?.value.trim();
    const rarity = (document.getElementById('if-rarity') as HTMLSelectElement)?.value;
    const equipSlot = (document.getElementById('if-equipSlot') as HTMLSelectElement)?.value || undefined;
    const bonusAttackMin = parseInt((document.getElementById('if-atkMin') as HTMLInputElement)?.value) || 0;
    const bonusAttackMax = parseInt((document.getElementById('if-atkMax') as HTMLInputElement)?.value) || 0;
    const damageReductionMin = parseInt((document.getElementById('if-drMin') as HTMLInputElement)?.value) || 0;
    const damageReductionMax = parseInt((document.getElementById('if-drMax') as HTMLInputElement)?.value) || 0;
    const dodgeChance = (parseInt((document.getElementById('if-dodge') as HTMLInputElement)?.value) || 0) / 100;

    if (!id || !name) {
      alert('ID and Name are required.');
      return;
    }

    const item: ItemDefinition = { id, name, rarity: rarity as 'janky' | 'common' };
    if (equipSlot) item.equipSlot = equipSlot as 'head' | 'chest' | 'hand' | 'foot';
    if (bonusAttackMin > 0 || bonusAttackMax > 0) { item.bonusAttackMin = bonusAttackMin; item.bonusAttackMax = bonusAttackMax; }
    if (damageReductionMin > 0 || damageReductionMax > 0) { item.damageReductionMin = damageReductionMin; item.damageReductionMax = damageReductionMax; }
    if (dodgeChance > 0) item.dodgeChance = dodgeChance;

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

  private renderZones(): string {
    const displayContent = this.getDisplayContent();
    if (!displayContent) return '<div class="admin-page-empty">No data</div>';
    const zones = Object.values(displayContent.zones);
    const monsters = displayContent.monsters;
    const readOnly = this.isReadOnly();

    const rows = zones.map(z => {
      const encounters = z.encounterTable.map(e => {
        const monster = monsters[e.monsterId];
        return `${monster?.name ?? e.monsterId} (w:${e.weight}, ${e.minCount}-${e.maxCount})`;
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
          <td>${encounters}</td>
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
    const monsterList = Object.values(displayContent.monsters);

    const encounterRows = z.encounterTable.map((e, i) => this.renderEncounterRow(i, e, monsterList)).join('');

    area.innerHTML = `
      <div class="pixel-panel monster-form">
        <h3>${isNew ? 'Add Zone' : `Edit: ${this.escapeHtml(z.displayName)}`}</h3>
        <div class="monster-form-grid">
          <label>ID<input type="text" id="zf-id" value="${this.escapeHtml(z.id)}" ${isNew ? '' : 'disabled'}></label>
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

    this.wireZoneFormEvents(monsterList);
  }

  private renderEncounterRow(index: number, entry: EncounterTableEntry, monsters: MonsterDefinition[]): string {
    const options = monsters.map(m =>
      `<option value="${m.id}" ${m.id === entry.monsterId ? 'selected' : ''}>${this.escapeHtml(m.name)}</option>`
    ).join('');

    return `
      <div class="monster-drop-row" data-index="${index}">
        <select class="zf-enc-monster">${options}</select>
        <label class="zf-enc-inline">W<input type="number" class="zf-enc-weight" value="${entry.weight}" min="1" step="1"></label>
        <label class="zf-enc-inline">Min<input type="number" class="zf-enc-min" value="${entry.minCount}" min="1" step="1"></label>
        <label class="zf-enc-inline">Max<input type="number" class="zf-enc-max" value="${entry.maxCount}" min="1" step="1"></label>
        <button class="admin-btn admin-btn-sm admin-btn-danger zf-enc-remove">X</button>
      </div>
    `;
  }

  private wireZoneFormEvents(monsters: MonsterDefinition[]): void {
    document.getElementById('zf-cancel')?.addEventListener('click', () => {
      const area = document.getElementById('zone-form-area');
      if (area) area.innerHTML = '';
    });

    document.getElementById('zf-add-encounter')?.addEventListener('click', () => {
      const list = document.getElementById('zf-encounters-list');
      if (!list || monsters.length === 0) return;
      const index = list.querySelectorAll('.monster-drop-row').length;
      const html = this.renderEncounterRow(index, { monsterId: monsters[0].id, weight: 1, minCount: 1, maxCount: 1 }, monsters);
      list.insertAdjacentHTML('beforeend', html);
      this.wireEncounterRemoveButtons();
    });

    this.wireEncounterRemoveButtons();

    document.getElementById('zf-save')?.addEventListener('click', () => {
      this.saveZoneForm();
    });

    // Auto-generate ID from name for new zones
    const idInput = document.getElementById('zf-id') as HTMLInputElement | null;
    const nameInput = document.getElementById('zf-name') as HTMLInputElement | null;
    if (idInput && nameInput && !idInput.disabled) {
      nameInput.addEventListener('input', () => {
        idInput.value = nameInput.value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
      });
    }
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
    const id = (document.getElementById('zf-id') as HTMLInputElement)?.value.trim();
    const displayName = (document.getElementById('zf-name') as HTMLInputElement)?.value.trim();
    const levelMin = parseInt((document.getElementById('zf-levelMin') as HTMLInputElement)?.value) || 1;
    const levelMax = parseInt((document.getElementById('zf-levelMax') as HTMLInputElement)?.value) || 1;

    if (!id || !displayName) {
      alert('ID and Display Name are required.');
      return;
    }

    const encounterTable: EncounterTableEntry[] = [];
    document.querySelectorAll('#zf-encounters-list .monster-drop-row').forEach(row => {
      const monsterId = (row.querySelector('.zf-enc-monster') as HTMLSelectElement)?.value;
      const weight = parseInt((row.querySelector('.zf-enc-weight') as HTMLInputElement)?.value) || 1;
      const minCount = parseInt((row.querySelector('.zf-enc-min') as HTMLInputElement)?.value) || 1;
      const maxCount = parseInt((row.querySelector('.zf-enc-max') as HTMLInputElement)?.value) || 1;
      if (monsterId) encounterTable.push({ monsterId, weight, minCount, maxCount });
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

      const color = TILE_CONFIGS[tile.type]?.color ?? 0x333333;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
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

      const color = TILE_CONFIGS[tile.type]?.color ?? 0x333333;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
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
      const color = TILE_CONFIGS[selectedHexTile.type]?.color ?? 0x333333;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
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
    if (TILE_CONFIGS[tile.type]?.traversable !== false) return;
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
      type: TileType.Plains,
      zone: defaultZone,
      name: 'Default Room Name',
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
    const isTraversable = TILE_CONFIGS[tile.type]?.traversable ?? false;
    const disabled = readOnly ? ' disabled' : '';

    const typeOptions = EDITABLE_TILE_TYPES.map(t => {
      const label = t.charAt(0).toUpperCase() + t.slice(1);
      const prefix = TILE_CONFIGS[t]?.traversable === false ? '(X) ' : '';
      return `<option value="${t}"${t === tile.type ? ' selected' : ''}>${prefix}${label}</option>`;
    }).join('');

    const zoneOptions = zones.map(z =>
      `<option value="${z.id}"${z.id === tile.zone ? ' selected' : ''}>${z.displayName}</option>`
    ).join('');

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
          <label>Coordinates</label>
          <div class="admin-map-sidebar-coords">(${tile.col}, ${tile.row})</div>
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
        this.selectedTile.type = typeSelect.value as TileType;
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
