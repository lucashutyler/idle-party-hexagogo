import {
  HexGrid,
  HexTile,
  offsetToCube,
  cubeToPixel,
  cubeToOffset,
  getHexCorners,
  TILE_CONFIGS,
  HEX_SIZE,
} from '@idle-party-rpg/shared';
import type {
  MonsterDefinition,
  ItemDefinition,
  ZoneDefinition,
  WorldTileDefinition,
  WorldData,
} from '@idle-party-rpg/shared';

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

type TabId = 'overview' | 'accounts' | 'monsters' | 'items' | 'zones' | 'map';

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
];

export class AdminApp {
  private container: HTMLElement;
  private activeTab: TabId = 'overview';
  private overview: OverviewData | null = null;
  private accounts: AccountData[] = [];
  private content: ContentData | null = null;
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
      const [overview, accountsData, contentData] = await Promise.all([
        this.fetchAdmin<OverviewData>('/api/admin/overview'),
        this.fetchAdmin<{ accounts: AccountData[] }>('/api/admin/accounts'),
        this.fetchAdmin<ContentData>('/api/admin/content'),
      ]);

      this.overview = overview;
      this.accounts = accountsData.accounts;
      this.content = contentData;

      // Build hex grid from content world data
      const grid = new HexGrid();
      this.worldTileDefs.clear();
      for (const tileDef of contentData.world.tiles) {
        const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
        const tile = new HexTile(coord, tileDef.type, tileDef.zone);
        grid.addTile(tile);
        this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
      }
      this.mapTiles = grid.getAllTiles();

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
        break;
      case 'items':
        content.innerHTML = this.renderItems();
        break;
      case 'zones':
        content.innerHTML = this.renderZones();
        break;
      case 'map':
        content.innerHTML = this.renderMapSection();
        this.initMapCanvas();
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
    if (!this.content) return '<div class="admin-page-empty">No data</div>';
    const monsters = Object.values(this.content.monsters);
    const items = this.content.items;

    const rows = monsters.map(m => {
      const drops = m.drops?.map(d => {
        const item = items[d.itemId];
        return `${item?.name ?? d.itemId} (${Math.round(d.chance * 100)}%)`;
      }).join(', ') ?? 'None';

      return `
        <tr>
          <td>${m.name}</td>
          <td>${m.level}</td>
          <td>${m.hp}</td>
          <td>${m.damage}</td>
          <td>${m.damageType}</td>
          <td>${m.xp}</td>
          <td>${m.goldMin}-${m.goldMax}</td>
          <td>${drops}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Monsters (${monsters.length})</h2></div>
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
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderItems(): string {
    if (!this.content) return '<div class="admin-page-empty">No data</div>';
    const items = Object.values(this.content.items);

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

      return `
        <tr>
          <td>${i.name}</td>
          <td><span class="rarity-${i.rarity}">${i.rarity}</span></td>
          <td>${i.equipSlot ?? '-'}</td>
          <td>${effects.length > 0 ? effects.join(', ') : 'Material'}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Items (${items.length})</h2></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Rarity</th>
                <th>Slot</th>
                <th>Effects</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  private renderZones(): string {
    if (!this.content) return '<div class="admin-page-empty">No data</div>';
    const zones = Object.values(this.content.zones);
    const monsters = this.content.monsters;

    const rows = zones.map(z => {
      const encounters = z.encounterTable.map(e => {
        const monster = monsters[e.monsterId];
        return `${monster?.name ?? e.monsterId} (w:${e.weight}, ${e.minCount}-${e.maxCount})`;
      }).join(', ');

      return `
        <tr>
          <td>${z.displayName}</td>
          <td>${z.levelRange[0]}-${z.levelRange[1]}</td>
          <td>${encounters}</td>
        </tr>
      `;
    }).join('');

    return `
      <div class="admin-page">
        <div class="admin-page-header"><h2>Zones (${zones.length})</h2></div>
        <div class="admin-table-wrap pixel-panel">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Level Range</th>
                <th>Encounters (weight, count range)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </div>
    `;
  }

  // --- Map ---

  private renderMapSection(): string {
    return `
      <div class="admin-page admin-page-map">
        <div class="admin-page-header">
          <h2>World Map (${this.mapTiles.length} tiles)</h2>
        </div>
        <div class="admin-map-wrap">
          <div class="admin-map-controls">
            <button class="admin-btn admin-btn-sm" id="map-zoom-in">+</button>
            <button class="admin-btn admin-btn-sm" id="map-zoom-out">-</button>
            <button class="admin-btn admin-btn-sm" id="map-reset">Reset</button>
            <span id="map-hover-info" class="admin-map-info"></span>
          </div>
          <canvas id="admin-map-canvas"></canvas>
        </div>
      </div>
    `;
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
    this.mapCanvas = null;
    this.mapCtx = null;
    this.mapInitialized = false;
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
        this.mapCanvas.width = wrap.clientWidth;
        this.mapCanvas.height = wrap.clientHeight - 40;
        if (!this.mapInitialized) {
          this.mapOffset = { x: this.mapCanvas.width / 2, y: this.mapCanvas.height / 2 };
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
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffsetStart = { ...this.mapOffset };
    });
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (!this.isDragging) return;
      this.mapOffset = {
        x: this.dragOffsetStart.x + (e.clientX - this.dragStart.x),
        y: this.dragOffsetStart.y + (e.clientY - this.dragStart.y),
      };
      this.drawMap();
    };
    window.addEventListener('mousemove', this.mouseMoveHandler);
    this.mouseUpHandler = () => { this.isDragging = false; };
    window.addEventListener('mouseup', this.mouseUpHandler);

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
      this.mapOffset = {
        x: this.mapCanvas!.width / 2,
        y: this.mapCanvas!.height / 2,
      };
      this.drawMap();
    });
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

    for (const tile of this.mapTiles) {
      const pixel = cubeToPixel(tile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;

      // Cull tiles outside viewport
      if (sx < -HEX_SIZE * zoom * 2 || sx > canvas.width + HEX_SIZE * zoom * 2) continue;
      if (sy < -HEX_SIZE * zoom * 2 || sy > canvas.height + HEX_SIZE * zoom * 2) continue;

      ctx.beginPath();
      for (let i = 0; i < corners.length; i++) {
        const cx = sx + corners[i].x * zoom;
        const cy = sy + corners[i].y * zoom;
        if (i === 0) ctx.moveTo(cx, cy);
        else ctx.lineTo(cx, cy);
      }
      ctx.closePath();

      const color = TILE_CONFIGS[tile.type]?.color ?? 0x333333;
      ctx.fillStyle = '#' + color.toString(16).padStart(6, '0');
      ctx.fill();

      ctx.strokeStyle = '#2a2a3e';
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  private updateHoverInfo(mx: number, my: number): void {
    const infoEl = document.getElementById('map-hover-info');
    if (!infoEl) return;

    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;

    let closest: HexTile | null = null;
    let closestDist = Infinity;
    for (const tile of this.mapTiles) {
      const pixel = cubeToPixel(tile.coord);
      const dx = pixel.x - worldX;
      const dy = pixel.y - worldY;
      const dist = dx * dx + dy * dy;
      if (dist < closestDist && dist < HEX_SIZE * HEX_SIZE) {
        closestDist = dist;
        closest = tile;
      }
    }

    if (closest) {
      const offset = cubeToOffset(closest.coord);
      const tileDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
      const roomName = tileDef?.name ? ` — ${tileDef.name}` : '';
      infoEl.textContent = `${closest.type} (${offset.col}, ${offset.row}) — ${closest.zone}${roomName}`;
    } else {
      infoEl.textContent = '';
    }
  }
}
