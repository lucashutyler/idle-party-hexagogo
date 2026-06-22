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
  DEFAULT_MAP_ID,
} from '@idle-party-rpg/shared';
import type {
  CubeCoord,
  TileType,
  WorldData,
  WorldTileDefinition,
  EncounterDefinition,
} from '@idle-party-rpg/shared';

import type { Tab } from './Tab';
import type { AdminContext } from '../AdminContext';
import { escapeHtml, putAdmin, postAdmin, deleteAdmin } from '../api';
import { openModal } from '../components/Modal';

// Maps CUBE_DIRECTIONS index → hex corner indices for the shared edge.
const DIR_TO_EDGE: [number, number][] = [
  [0, 1],
  [5, 0],
  [4, 5],
  [3, 4],
  [2, 3],
  [1, 2],
];

interface AdjacentSlot {
  col: number;
  row: number;
  coord: CubeCoord;
}

export class MapTab implements Tab {
  private mapTiles: HexTile[] = [];
  private worldTileDefs = new Map<string, WorldTileDefinition>();
  private adjacentSlots: AdjacentSlot[] = [];

  private mapCanvas: HTMLCanvasElement | null = null;
  private mapCtx: CanvasRenderingContext2D | null = null;
  private mapOffset = { x: 0, y: 0 };
  private mapZoom = 1.0;
  private isDragging = false;
  private dragStart = { x: 0, y: 0 };
  private dragOffsetStart = { x: 0, y: 0 };
  private mapInitialized = false;
  private hasDragged = false;

  private resizeHandler: (() => void) | null = null;
  private mouseMoveHandler: ((e: MouseEvent) => void) | null = null;
  private mouseUpHandler: (() => void) | null = null;
  private keydownHandler: ((e: KeyboardEvent) => void) | null = null;
  private saveTimeout: ReturnType<typeof setTimeout> | null = null;

  private selectedTile: WorldTileDefinition | null = null;
  /** Which map the editor is currently showing. */
  private selectedMapId: string = DEFAULT_MAP_ID;
  /** When set, the next room click links it as `sourceTile`'s transition target. */
  private pickTransition: { sourceTile: WorldTileDefinition } | null = null;

  cleanup(): void {
    if (this.resizeHandler) window.removeEventListener('resize', this.resizeHandler);
    if (this.mouseMoveHandler) window.removeEventListener('mousemove', this.mouseMoveHandler);
    if (this.mouseUpHandler) window.removeEventListener('mouseup', this.mouseUpHandler);
    if (this.keydownHandler) window.removeEventListener('keydown', this.keydownHandler);
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.resizeHandler = this.mouseMoveHandler = this.mouseUpHandler = this.keydownHandler = null;
    this.saveTimeout = null;
    this.mapCanvas = null;
    this.mapCtx = null;
    this.mapInitialized = false;
    this.selectedTile = null;
  }

  render(container: HTMLElement, ctx: AdminContext): void {
    this.rebuildMapData(ctx);
    const content = ctx.getDisplayContent();
    const maps = content?.world.maps ?? [];
    const mapOptions = maps.map(m =>
      `<option value="${escapeHtml(m.id)}"${m.id === this.selectedMapId ? ' selected' : ''}>${escapeHtml(m.name)}</option>`
    ).join('');
    const newMapBtn = `<button class="admin-btn admin-btn-sm" id="map-new" type="button"${ctx.isReadOnly() ? ' disabled title="Switch to a draft version to create maps"' : ''}>+ New Map</button>`;
    container.innerHTML = `
      <div class="admin-page admin-page-map">
        <div class="admin-map-layout">
          <div class="admin-map-canvas-area">
            <div class="admin-map-controls">
              <select id="map-selector" class="admin-select admin-select-sm" title="Switch map">${mapOptions}</select>
              ${newMapBtn}
              <span id="map-tile-count" class="admin-map-tile-count">${this.mapTiles.length} rooms</span>
              <button class="admin-btn admin-btn-sm" id="map-zoom-in">+</button>
              <button class="admin-btn admin-btn-sm" id="map-zoom-out">−</button>
              <button class="admin-btn admin-btn-sm" id="map-reset">Reset</button>
              <span id="map-hover-info" class="admin-map-info"></span>
            </div>
            <div id="map-pick-banner" class="admin-map-pick-banner" style="display:none"></div>
            <canvas id="admin-map-canvas"></canvas>
          </div>
          <div class="admin-map-sidebar" id="admin-map-sidebar"></div>
        </div>
      </div>
    `;
    this.initMapCanvas(ctx);
    this.renderSidebar(ctx);
    this.updatePickBanner();
  }

  private rebuildMapData(ctx: AdminContext): void {
    const content = ctx.getDisplayContent();
    if (!content) return;
    // Default to the world's spawn map; fall back if the selected map was deleted.
    const maps = content.world.maps ?? [];
    if (!maps.some(m => m.id === this.selectedMapId)) {
      this.selectedMapId = content.world.defaultMapId ?? maps[0]?.id ?? DEFAULT_MAP_ID;
    }
    this.worldTileDefs.clear();
    const tiles: HexTile[] = [];
    for (const tileDef of content.world.tiles) {
      if (tileDef.mapId !== this.selectedMapId) continue;
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      tiles.push(new HexTile(coord, tileDef.type, tileDef.zone));
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }
    this.mapTiles = tiles;
    this.computeAdjacentSlots();
  }

  private computeAdjacentSlots(): void {
    const occupied = new Set<string>();
    for (const tile of this.mapTiles) {
      const offset = cubeToOffset(tile.coord);
      occupied.add(`${offset.col},${offset.row}`);
    }
    const adjacent = new Map<string, AdjacentSlot>();
    // A brand-new (empty) map has no tiles to be adjacent to — offer a single
    // starter slot at the origin so the first room can be placed.
    if (this.mapTiles.length === 0) {
      adjacent.set('0,0', { col: 0, row: 0, coord: offsetToCube({ col: 0, row: 0 }) });
      this.adjacentSlots = Array.from(adjacent.values());
      return;
    }
    for (const tile of this.mapTiles) {
      for (const neighborCoord of getNeighbors(tile.coord)) {
        const offset = cubeToOffset(neighborCoord);
        const key = `${offset.col},${offset.row}`;
        if (!occupied.has(key) && !adjacent.has(key)) {
          adjacent.set(key, { col: offset.col, row: offset.row, coord: neighborCoord });
        }
      }
    }
    this.adjacentSlots = Array.from(adjacent.values());
  }

  private initMapCanvas(ctx: AdminContext): void {
    this.cleanup();

    this.mapCanvas = document.getElementById('admin-map-canvas') as HTMLCanvasElement;
    if (!this.mapCanvas) return;
    this.mapCtx = this.mapCanvas.getContext('2d');

    const resizeCanvas = () => {
      if (!this.mapCanvas) return;
      this.mapCanvas.width = this.mapCanvas.clientWidth;
      this.mapCanvas.height = this.mapCanvas.clientHeight;
      if (!this.mapInitialized) {
        const startPixel = this.getStartTilePixel(ctx);
        this.mapOffset = {
          x: this.mapCanvas.width / 2 - startPixel.x * this.mapZoom,
          y: this.mapCanvas.height / 2 - startPixel.y * this.mapZoom,
        };
        this.mapInitialized = true;
      }
      this.draw(ctx);
    };
    this.resizeHandler = resizeCanvas;
    window.addEventListener('resize', resizeCanvas);
    resizeCanvas();

    this.mapCanvas.addEventListener('mousedown', e => {
      this.isDragging = true;
      this.hasDragged = false;
      this.dragStart = { x: e.clientX, y: e.clientY };
      this.dragOffsetStart = { ...this.mapOffset };
    });
    this.mouseMoveHandler = (e: MouseEvent) => {
      if (!this.isDragging) return;
      const dx = e.clientX - this.dragStart.x;
      const dy = e.clientY - this.dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this.hasDragged = true;
      this.mapOffset = { x: this.dragOffsetStart.x + dx, y: this.dragOffsetStart.y + dy };
      this.draw(ctx);
    };
    window.addEventListener('mousemove', this.mouseMoveHandler);
    this.mouseUpHandler = () => { this.isDragging = false; };
    window.addEventListener('mouseup', this.mouseUpHandler);

    this.mapCanvas.addEventListener('click', e => {
      if (this.hasDragged) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.handleMapClick(ctx, e.clientX - rect.left, e.clientY - rect.top);
    });

    this.mapCanvas.addEventListener('wheel', e => {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      this.mapZoom = Math.max(0.05, Math.min(3, this.mapZoom * delta));
      this.draw(ctx);
    });

    let lastTouch: { x: number; y: number } | null = null;
    this.mapCanvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        lastTouch = { x: e.touches[0].clientX, y: e.touches[0].clientY };
        this.dragOffsetStart = { ...this.mapOffset };
      }
    });
    this.mapCanvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 1 && lastTouch) {
        this.mapOffset = {
          x: this.dragOffsetStart.x + (e.touches[0].clientX - lastTouch.x),
          y: this.dragOffsetStart.y + (e.touches[0].clientY - lastTouch.y),
        };
        this.draw(ctx);
      }
    });
    this.mapCanvas.addEventListener('touchend', () => { lastTouch = null; });

    this.keydownHandler = (e: KeyboardEvent) => {
      if (ctx.isReadOnly()) return;
      if (e.key === 'Escape' && this.pickTransition) {
        e.preventDefault();
        this.pickTransition = null;
        this.updatePickBanner();
        this.renderSidebar(ctx);
        return;
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (document.activeElement?.tagName ?? '').toLowerCase();
        if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
        if (this.selectedTile) {
          e.preventDefault();
          this.deleteSelectedTile(ctx);
        }
      }
    };
    window.addEventListener('keydown', this.keydownHandler);

    document.getElementById('map-zoom-in')?.addEventListener('click', () => {
      this.mapZoom = Math.min(3, this.mapZoom * 1.3);
      this.draw(ctx);
    });
    document.getElementById('map-zoom-out')?.addEventListener('click', () => {
      this.mapZoom = Math.max(0.05, this.mapZoom * 0.7);
      this.draw(ctx);
    });
    document.getElementById('map-reset')?.addEventListener('click', () => {
      this.mapZoom = 1.0;
      const startPixel = this.getStartTilePixel(ctx);
      this.mapOffset = {
        x: this.mapCanvas!.width / 2 - startPixel.x * this.mapZoom,
        y: this.mapCanvas!.height / 2 - startPixel.y * this.mapZoom,
      };
      this.draw(ctx);
    });
    (document.getElementById('map-selector') as HTMLSelectElement | null)?.addEventListener('change', (e) => {
      this.switchMap(ctx, (e.target as HTMLSelectElement).value);
    });
    document.getElementById('map-new')?.addEventListener('click', () => this.promptNewMap(ctx));

    this.mapCanvas.addEventListener('mousemove', e => {
      if (this.isDragging) return;
      const rect = this.mapCanvas!.getBoundingClientRect();
      this.updateHoverInfo(e.clientX - rect.left, e.clientY - rect.top);
    });
  }

  private getStartTilePixel(ctx: AdminContext): { x: number; y: number } {
    const content = ctx.getDisplayContent();
    if (content) {
      const meta = content.world.maps?.find(m => m.id === this.selectedMapId);
      const { col, row } = meta?.startTile ?? content.world.startTile;
      return cubeToPixel(offsetToCube({ col, row }));
    }
    return { x: 0, y: 0 };
  }

  private updateHoverInfo(mx: number, my: number): void {
    const infoEl = document.getElementById('map-hover-info');
    if (!infoEl) return;
    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;
    const hoveredCube = pixelToCube({ x: worldX, y: worldY });
    const hoveredOffset = cubeToOffset(hoveredCube);
    const tileDef = this.worldTileDefs.get(`${hoveredOffset.col},${hoveredOffset.row}`);
    if (tileDef) {
      infoEl.textContent = `${tileDef.name} — ${tileDef.zone} (${hoveredOffset.col}, ${hoveredOffset.row})`;
      return;
    }
    const slot = this.adjacentSlots.find(s => cubeEquals(s.coord, hoveredCube));
    if (slot) {
      infoEl.textContent = `+ New room (${slot.col}, ${slot.row})`;
    } else {
      infoEl.textContent = '';
    }
  }

  private updateMapTileCount(): void {
    const el = document.getElementById('map-tile-count');
    if (el) el.textContent = `${this.mapTiles.length} rooms`;
  }

  /** Show/hide the "click a room to link" banner while in transition-pick mode. */
  private updatePickBanner(): void {
    const banner = document.getElementById('map-pick-banner');
    if (!banner) return;
    if (this.pickTransition) {
      banner.style.display = '';
      banner.textContent = `Linking "${this.pickTransition.sourceTile.name}" — switch maps if needed, then click the destination room. (Esc to cancel)`;
    } else {
      banner.style.display = 'none';
      banner.textContent = '';
    }
  }

  /** Switch the editor to a different map (full re-render keeps the selector in sync). */
  private switchMap(ctx: AdminContext, mapId: string): void {
    if (mapId === this.selectedMapId) return;
    this.selectedMapId = mapId;
    this.selectedTile = null;
    this.mapInitialized = false; // re-center on the new map's start
    ctx.rerenderTab();
  }

  /** Finish a transition pick: link the source room to the clicked target room. */
  private async completeTransitionPick(ctx: AdminContext, target: WorldTileDefinition): Promise<void> {
    const pick = this.pickTransition;
    if (!pick) return;
    const source = pick.sourceTile;
    this.pickTransition = null;
    if (target.id === source.id) {
      this.updatePickBanner();
      this.renderSidebar(ctx);
      return; // a room can't transition to itself
    }
    if (!source.transitions) source.transitions = [];
    if (!source.transitions.some(t => t.tileId === target.id && t.mapId === this.selectedMapId)) {
      source.transitions.push({ mapId: this.selectedMapId, tileId: target.id });
    }
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, source);
      this.applyWorldUpdate(ctx, data.world);
      // Return to the source room's map and reselect it so the link is visible.
      this.selectedMapId = source.mapId;
      this.mapInitialized = false;
      ctx.rerenderTab();
      this.selectedTile = this.worldTileDefs.get(`${source.col},${source.row}`) ?? null;
      this.draw(ctx);
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  /** Prompt for a new map's id + name, create it, and switch to it. */
  private promptNewMap(ctx: AdminContext): void {
    if (ctx.isReadOnly()) return;
    const modal = openModal({
      title: 'New Map',
      width: '420px',
      bodyHtml: `
        <div class="admin-form-grid">
          <label>Name<input type="text" id="new-map-name" placeholder="Sewers"></label>
          <label>ID (lowercase, no spaces)<input type="text" id="new-map-id" placeholder="sewers"></label>
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
        this.applyWorldUpdate(ctx, data.world);
        modal.close();
        this.switchMap(ctx, id);
      } catch (err) {
        errorEl.textContent = err instanceof Error ? err.message : 'Network error';
      }
    });
  }

  private handleMapClick(ctx: AdminContext, mx: number, my: number): void {
    const zoom = this.mapZoom;
    const worldX = (mx - this.mapOffset.x) / zoom;
    const worldY = (my - this.mapOffset.y) / zoom;
    const clickedCube = pixelToCube({ x: worldX, y: worldY });
    const clickedOffset = cubeToOffset(clickedCube);
    const clickedKey = `${clickedOffset.col},${clickedOffset.row}`;

    const tileDef = this.worldTileDefs.get(clickedKey);

    // Transition pick mode: the next room click becomes the source tile's target.
    if (this.pickTransition && tileDef) {
      this.completeTransitionPick(ctx, tileDef);
      return;
    }

    if (tileDef) {
      this.selectedTile = tileDef;
      this.draw(ctx);
      this.renderSidebar(ctx);
      return;
    }
    if (!ctx.isReadOnly()) {
      const slot = this.adjacentSlots.find(s => cubeEquals(s.coord, clickedCube));
      if (slot) {
        this.addTileAtSlot(ctx, slot);
        return;
      }
    }
    this.selectedTile = null;
    this.draw(ctx);
    this.renderSidebar(ctx);
  }

  // ---- Drawing ----

  private draw(ctx: AdminContext): void {
    const c = this.mapCtx;
    const canvas = this.mapCanvas;
    if (!c || !canvas) return;

    c.clearRect(0, 0, canvas.width, canvas.height);
    c.fillStyle = '#1a1d23';
    c.fillRect(0, 0, canvas.width, canvas.height);

    const content = ctx.getDisplayContent();
    const corners = getHexCorners(HEX_SIZE);
    const zoom = this.mapZoom;
    const ox = this.mapOffset.x;
    const oy = this.mapOffset.y;

    const zoneMap = new Map<string, string>();
    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      zoneMap.set(`${off.col},${off.row}`, tile.zone);
    }
    const selectedZone = this.selectedTile
      ? zoneMap.get(`${this.selectedTile.col},${this.selectedTile.row}`) ?? null
      : null;

    const otherTiles: HexTile[] = [];
    const zoneTiles: HexTile[] = [];
    let selectedHexTile: HexTile | null = null;
    for (const tile of this.mapTiles) {
      const off = cubeToOffset(tile.coord);
      const isSelected = this.selectedTile && this.selectedTile.col === off.col && this.selectedTile.row === off.row;
      if (isSelected) selectedHexTile = tile;
      else if (selectedZone && tile.zone === selectedZone) zoneTiles.push(tile);
      else otherTiles.push(tile);
    }

    // Adjacent slots (only when editable)
    const showSlots = !ctx.isReadOnly();
    for (const slot of (showSlots ? this.adjacentSlots : [])) {
      const pixel = cubeToPixel(slot.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      if (!this.inBounds(sx, sy, canvas, zoom)) continue;
      this.drawHex(c, corners, sx, sy, zoom);
      c.fillStyle = 'rgba(255,255,255,0.04)';
      c.fill();
      c.strokeStyle = 'rgba(255,255,255,0.15)';
      c.lineWidth = 1;
      c.setLineDash([4, 4]);
      c.stroke();
      c.setLineDash([]);
      const plusSize = 14 * zoom;
      c.strokeStyle = 'rgba(255,255,255,0.35)';
      c.lineWidth = Math.max(1.5, 3 * zoom);
      c.beginPath();
      c.moveTo(sx - plusSize, sy); c.lineTo(sx + plusSize, sy);
      c.moveTo(sx, sy - plusSize); c.lineTo(sx, sy + plusSize);
      c.stroke();
    }

    for (const tile of otherTiles) {
      this.drawTile(c, tile, corners, ox, oy, zoom, content);
    }

    if (selectedZone) {
      const all = selectedHexTile ? [...zoneTiles, selectedHexTile] : zoneTiles;
      const edges: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const tile of all) {
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
            x0: sx + corners[ei0].x * zoom, y0: sy + corners[ei0].y * zoom,
            x1: sx + corners[ei1].x * zoom, y1: sy + corners[ei1].y * zoom,
          });
        }
      }
      c.save();
      c.lineCap = 'round';
      const passes = [
        { width: Math.max(20, 40 * zoom), alpha: 0.04 },
        { width: Math.max(14, 28 * zoom), alpha: 0.08 },
        { width: Math.max(8, 16 * zoom), alpha: 0.15 },
        { width: Math.max(4, 8 * zoom), alpha: 0.25 },
        { width: Math.max(2, 4 * zoom), alpha: 0.4 },
      ];
      for (const pass of passes) {
        c.strokeStyle = `rgba(255,255,255,${pass.alpha})`;
        c.lineWidth = pass.width;
        c.beginPath();
        for (const e of edges) { c.moveTo(e.x0, e.y0); c.lineTo(e.x1, e.y1); }
        c.stroke();
      }
      c.restore();
    }

    for (const tile of zoneTiles) {
      this.drawTile(c, tile, corners, ox, oy, zoom, content);
    }

    // Yellow zone-boundary edges
    c.save();
    c.strokeStyle = '#ffc845';
    c.lineWidth = Math.max(1.5, 2.5 * zoom);
    c.lineCap = 'round';
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
        if (nZone === undefined || nZone === tileZone) continue;
        const [ei0, ei1] = DIR_TO_EDGE[dir];
        c.beginPath();
        c.moveTo(sx + corners[ei0].x * zoom, sy + corners[ei0].y * zoom);
        c.lineTo(sx + corners[ei1].x * zoom, sy + corners[ei1].y * zoom);
        c.stroke();
      }
    }
    c.restore();

    if (selectedHexTile) {
      const pixel = cubeToPixel(selectedHexTile.coord);
      const sx = pixel.x * zoom + ox;
      const sy = pixel.y * zoom + oy;
      c.save();
      c.shadowColor = 'rgba(0,0,0,0.5)';
      c.shadowBlur = Math.max(4, 8 * zoom);
      c.shadowOffsetY = Math.max(1, 3 * zoom);
      this.drawHex(c, corners, sx, sy, zoom, 1.08);
      const tt = content?.tileTypes?.[selectedHexTile.type];
      c.fillStyle = tt
        ? tt.color
        : '#' + (TILE_CONFIGS[selectedHexTile.type as TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
      c.fill();
      c.restore();
      this.drawHex(c, corners, sx, sy, zoom, 1.08);
      c.strokeStyle = 'rgba(255,255,255,0.25)';
      c.lineWidth = Math.max(1, 1.5 * zoom);
      c.stroke();
      const tileZone = selectedHexTile.zone;
      const scale = 1.08;
      c.strokeStyle = '#ffc845';
      c.lineWidth = Math.max(2, 3 * zoom);
      c.lineCap = 'round';
      for (let dir = 0; dir < 6; dir++) {
        const neighbor = getNeighbor(selectedHexTile.coord, dir);
        const nOff = cubeToOffset(neighbor);
        const nZone = zoneMap.get(`${nOff.col},${nOff.row}`);
        if (nZone === undefined || nZone === tileZone) continue;
        const [ei0, ei1] = DIR_TO_EDGE[dir];
        c.beginPath();
        c.moveTo(sx + corners[ei0].x * zoom * scale, sy + corners[ei0].y * zoom * scale);
        c.lineTo(sx + corners[ei1].x * zoom * scale, sy + corners[ei1].y * zoom * scale);
        c.stroke();
      }
      this.drawNonTraversableMarker(c, selectedHexTile, sx, sy, zoom, content);
      this.drawStartMarker(c, selectedHexTile, sx, sy, zoom, content);
    }
  }

  private drawTile(
    c: CanvasRenderingContext2D, tile: HexTile, corners: { x: number; y: number }[],
    ox: number, oy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    const canvas = this.mapCanvas!;
    const pixel = cubeToPixel(tile.coord);
    const sx = pixel.x * zoom + ox;
    const sy = pixel.y * zoom + oy;
    if (!this.inBounds(sx, sy, canvas, zoom)) return;
    this.drawHex(c, corners, sx, sy, zoom);
    const tt = content?.tileTypes?.[tile.type];
    c.fillStyle = tt
      ? tt.color
      : '#' + (TILE_CONFIGS[tile.type as TileType]?.color ?? 0x333333).toString(16).padStart(6, '0');
    c.fill();
    c.strokeStyle = '#2a2e36';
    c.lineWidth = 0.5;
    c.stroke();
    this.drawNonTraversableMarker(c, tile, sx, sy, zoom, content);
    this.drawStartMarker(c, tile, sx, sy, zoom, content);
    this.drawNpcMarker(c, tile, sx, sy, zoom, content);
    this.drawTransitionMarker(c, tile, sx, sy, zoom);
  }

  private drawNpcMarker(
    c: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    if (!content) return;
    const offset = cubeToOffset(tile.coord);
    const tileDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    if (!tileDef?.npcId) return;
    const npc = content.npcs?.[tileDef.npcId];
    if (!npc) return;
    c.save();
    c.font = `${Math.max(8, 14 * zoom)}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText(npc.emoji, sx + HEX_SIZE * 0.4 * zoom, sy - HEX_SIZE * 0.4 * zoom);
    c.restore();
  }

  private drawHex(c: CanvasRenderingContext2D, corners: { x: number; y: number }[], sx: number, sy: number, zoom: number, scale = 1.0): void {
    c.beginPath();
    for (let i = 0; i < corners.length; i++) {
      const cx = sx + corners[i].x * zoom * scale;
      const cy = sy + corners[i].y * zoom * scale;
      if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
    }
    c.closePath();
  }

  private inBounds(sx: number, sy: number, canvas: HTMLCanvasElement, zoom: number, pad = 2): boolean {
    const margin = HEX_SIZE * zoom * pad;
    return sx > -margin && sx < canvas.width + margin && sy > -margin && sy < canvas.height + margin;
  }

  private drawNonTraversableMarker(
    c: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    const tt = content?.tileTypes?.[tile.type];
    const isTraversable = tt ? tt.traversable : (TILE_CONFIGS[tile.type as TileType]?.traversable ?? true);
    if (isTraversable) return;
    const size = Math.max(5, 10 * zoom);
    c.save();
    c.strokeStyle = 'rgba(255,60,60,0.7)';
    c.lineWidth = Math.max(1.5, 2.5 * zoom);
    c.lineCap = 'round';
    c.beginPath();
    c.moveTo(sx - size, sy - size); c.lineTo(sx + size, sy + size);
    c.moveTo(sx + size, sy - size); c.lineTo(sx - size, sy + size);
    c.stroke();
    c.restore();
  }

  private drawStartMarker(
    c: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number,
    content: ReturnType<AdminContext['getDisplayContent']>,
  ): void {
    if (!content) return;
    const offset = cubeToOffset(tile.coord);
    const meta = content.world.maps?.find(m => m.id === this.selectedMapId);
    const start = meta?.startTile ?? content.world.startTile;
    if (start.col === offset.col && start.row === offset.row) {
      c.save();
      c.font = `${Math.max(10, 16 * zoom)}px sans-serif`;
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillStyle = '#ffc845';
      c.fillText('★', sx, sy);
      c.restore();
    }
  }

  private drawTransitionMarker(
    c: CanvasRenderingContext2D, tile: HexTile, sx: number, sy: number, zoom: number,
  ): void {
    const offset = cubeToOffset(tile.coord);
    const tileDef = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    if (!tileDef?.transitions?.length) return;
    c.save();
    c.font = `${Math.max(8, 14 * zoom)}px sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.fillText('🕳️', sx - HEX_SIZE * 0.4 * zoom, sy - HEX_SIZE * 0.4 * zoom);
    c.restore();
  }

  // ---- Sidebar ----

  private renderSidebar(ctx: AdminContext): void {
    const sidebar = document.getElementById('admin-map-sidebar');
    if (!sidebar) return;
    const readOnly = ctx.isReadOnly();
    const tile = this.selectedTile;

    if (!tile) {
      const hint = readOnly
        ? 'Click a room to view details. This version is read-only.'
        : 'Click a room to edit, or click + to add a new room.';
      sidebar.innerHTML = `
        <div class="admin-map-sidebar-header">Room Editor</div>
        <div class="admin-map-sidebar-placeholder">${hint}</div>
      `;
      return;
    }

    this.renderSidebarEditor(sidebar, ctx, tile);
  }

  private renderSidebarEditor(sidebar: HTMLElement, ctx: AdminContext, tile: WorldTileDefinition): void {
    const content = ctx.getDisplayContent();
    const zones = content ? Object.values(content.zones) : [];
    const mapMeta = content?.world.maps?.find(m => m.id === this.selectedMapId);
    const startTile = mapMeta?.startTile ?? content?.world.startTile;
    const isStart = !!startTile && startTile.col === tile.col && startTile.row === tile.row;
    const tileTypeDefs = content ? Object.values(content.tileTypes ?? {}) : [];
    const tileTypeDef = content?.tileTypes?.[tile.type];
    const isTraversable = tileTypeDef ? tileTypeDef.traversable : (TILE_CONFIGS[tile.type as TileType]?.traversable ?? false);
    const readOnly = ctx.isReadOnly();
    const disabled = readOnly ? ' disabled' : '';

    const typeOptions = tileTypeDefs
      .filter(t => t.id !== 'void')
      .map(t => {
        const prefix = !t.traversable ? '(X) ' : '';
        return `<option value="${t.id}"${t.id === tile.type ? ' selected' : ''}>${prefix}${escapeHtml(t.name)}</option>`;
      }).join('');
    const zoneOptions = zones.map(z =>
      `<option value="${z.id}"${z.id === tile.zone ? ' selected' : ''}>${escapeHtml(z.displayName)}</option>`
    ).join('');
    const shops = content ? Object.values(content.shops ?? {}) : [];
    const shopOptions = `<option value="">(none)</option>` + shops.map(s =>
      `<option value="${s.id}"${s.id === (tile.shopId ?? '') ? ' selected' : ''}>${escapeHtml(s.name)}</option>`
    ).join('');
    const npcs = content ? Object.values(content.npcs ?? {}) : [];
    const npcOptions = `<option value="">(none)</option>` + npcs.map(n =>
      `<option value="${n.id}"${n.id === (tile.npcId ?? '') ? ' selected' : ''}>${escapeHtml(`${n.emoji} ${n.name}`)}</option>`
    ).join('');
    const dungeons = content ? Object.values(content.dungeons ?? {}) : [];
    const dungeonOptions = `<option value="">(none)</option>` + dungeons.map(d =>
      `<option value="${d.id}"${d.id === (tile.dungeonId ?? '') ? ' selected' : ''}>${escapeHtml(d.name)}</option>`
    ).join('');

    // Map transitions — a room may link to several rooms on other maps.
    const links = tile.transitions ?? [];
    const linkRow = (link: { mapId: string; tileId: string }, idx: number): string => {
      const destTile = content?.world.tiles.find(t => t.id === link.tileId);
      const destMap = content?.world.maps?.find(m => m.id === link.mapId);
      const label = `→ ${escapeHtml(destMap?.name ?? link.mapId)}: ${escapeHtml(destTile?.name ?? '(missing room)')}`;
      return readOnly
        ? `<div class="admin-form-hint">${label}</div>`
        : `<div class="admin-map-transition-row"><span class="admin-form-hint">${label}</span><button class="admin-btn admin-btn-sm" data-remove-transition="${idx}" type="button">Remove</button></div>`;
    };
    const linksHtml = links.length
      ? links.map(linkRow).join('')
      : `<div class="admin-form-hint">No transitions. Link this room to rooms on other maps.</div>`;
    const addTransitionBtn = `<button class="admin-btn admin-btn-sm" id="sidebar-link-transition" type="button"${readOnly ? ' disabled title="Switch to a draft version to edit"' : ''}>${this.pickTransition ? 'Cancel linking…' : '+ Add transition'}</button>`;
    const transitionSectionHtml = `<div class="admin-map-transition">
          <div class="admin-form-label-text">Map Transitions</div>
          ${linksHtml}
          ${addTransitionBtn}
        </div>`;

    let startBtnHtml = '';
    if (!readOnly) {
      startBtnHtml = isStart
        ? `<div class="admin-pill admin-pill-gold">★ Start Tile</div>`
        : isTraversable
          ? `<button class="admin-btn" id="sidebar-set-start" type="button">Set as Start Tile</button>`
          : '';
    }
    const deleteBtnHtml = readOnly ? '' : (isStart
      ? `<button class="admin-btn admin-btn-danger" disabled title="Cannot delete the start tile">Delete Room</button>
         <div class="admin-form-hint">Assign a different start tile before deleting.</div>`
      : `<button class="admin-btn admin-btn-danger" id="sidebar-delete" type="button">Delete Room</button>`);

    sidebar.innerHTML = `
      <div class="admin-map-sidebar-header">
        <span>${readOnly ? 'Room Info' : 'Edit Room'}</span>
        ${isStart ? '<span class="admin-pill admin-pill-gold">★ Start</span>' : ''}
      </div>
      <div class="admin-map-sidebar-fields">
        <label>Room Name<input type="text" id="sidebar-name" value="${escapeHtml(tile.name)}"${disabled}></label>
        <label>Type<select id="sidebar-type"${disabled}>${typeOptions}</select></label>
        <label>Zone<select id="sidebar-zone"${disabled}>${zoneOptions}</select></label>
        <label>Shop<select id="sidebar-shop"${disabled}>${shopOptions}</select></label>
        <label>NPC<select id="sidebar-npc"${disabled}>${npcOptions}</select></label>
        <label>Dungeon<select id="sidebar-dungeon"${disabled}>${dungeonOptions}</select></label>
        ${transitionSectionHtml}
        <label>Required Item (override)
          <select id="sidebar-required-item"${disabled}>
            <option value="">(use type default)</option>
            ${Object.values(content?.items ?? {}).map(i =>
              `<option value="${escapeHtml(i.id)}"${i.id === (tile.requiredItemId ?? '') ? ' selected' : ''}>${escapeHtml(i.name)}</option>`
            ).join('')}
          </select>
        </label>
        <div class="admin-form-coords">Coordinates (${tile.col}, ${tile.row})</div>
        <label class="admin-form-checkbox">
          <input type="checkbox" id="sidebar-custom-encounters" ${tile.encounterTable?.length ? 'checked' : ''}${disabled}>
          Custom Encounters
        </label>
        <div id="sidebar-encounters-section" style="${tile.encounterTable?.length ? '' : 'display:none'}">
          ${this.encounterRowsHtml(tile, content ? Object.values(content.encounters) : [], readOnly)}
        </div>
        ${startBtnHtml}
        <div class="admin-map-sidebar-spacer"></div>
        ${deleteBtnHtml}
        <div id="sidebar-error" class="admin-map-sidebar-error"></div>
      </div>
    `;

    const nameInput = document.getElementById('sidebar-name') as HTMLInputElement;
    nameInput?.addEventListener('input', () => {
      if (this.selectedTile) { this.selectedTile.name = nameInput.value; this.scheduleSave(ctx); }
    });
    const typeSelect = document.getElementById('sidebar-type') as HTMLSelectElement;
    typeSelect?.addEventListener('change', () => {
      if (this.selectedTile) { this.selectedTile.type = typeSelect.value; this.scheduleSave(ctx); this.renderSidebar(ctx); }
    });
    const zoneSelect = document.getElementById('sidebar-zone') as HTMLSelectElement;
    zoneSelect?.addEventListener('change', () => {
      if (this.selectedTile) { this.selectedTile.zone = zoneSelect.value; this.scheduleSave(ctx); }
    });
    const shopSelect = document.getElementById('sidebar-shop') as HTMLSelectElement;
    shopSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (shopSelect.value) this.selectedTile.shopId = shopSelect.value;
      else delete this.selectedTile.shopId;
      this.scheduleSave(ctx);
    });
    const npcSelect = document.getElementById('sidebar-npc') as HTMLSelectElement;
    npcSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (npcSelect.value) this.selectedTile.npcId = npcSelect.value;
      else delete this.selectedTile.npcId;
      this.scheduleSave(ctx);
      this.draw(ctx);
    });
    const dungeonSelect = document.getElementById('sidebar-dungeon') as HTMLSelectElement;
    dungeonSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (dungeonSelect.value) this.selectedTile.dungeonId = dungeonSelect.value;
      else delete this.selectedTile.dungeonId;
      this.scheduleSave(ctx);
    });
    const requiredItemSelect = document.getElementById('sidebar-required-item') as HTMLSelectElement;
    requiredItemSelect?.addEventListener('change', () => {
      if (!this.selectedTile) return;
      if (requiredItemSelect.value) this.selectedTile.requiredItemId = requiredItemSelect.value;
      else delete this.selectedTile.requiredItemId;
      this.scheduleSave(ctx);
    });
    const customEncCheck = document.getElementById('sidebar-custom-encounters') as HTMLInputElement;
    customEncCheck?.addEventListener('change', () => {
      const section = document.getElementById('sidebar-encounters-section');
      if (!section || !this.selectedTile) return;
      if (customEncCheck.checked) {
        if (!this.selectedTile.encounterTable || this.selectedTile.encounterTable.length === 0) {
          this.selectedTile.encounterTable = [];
        }
        section.style.display = '';
        const c = ctx.getDisplayContent();
        section.innerHTML = this.encounterRowsHtml(this.selectedTile, c ? Object.values(c.encounters) : [], ctx.isReadOnly());
        this.wireEncounterEvents(ctx);
      } else {
        delete this.selectedTile.encounterTable;
        section.style.display = 'none';
        this.scheduleSave(ctx);
      }
    });

    this.wireEncounterEvents(ctx);
    document.getElementById('sidebar-set-start')?.addEventListener('click', () => this.setAsStartTile(ctx));
    document.getElementById('sidebar-delete')?.addEventListener('click', () => this.deleteSelectedTile(ctx));
    document.getElementById('sidebar-link-transition')?.addEventListener('click', () => {
      if (ctx.isReadOnly()) return;
      this.pickTransition = this.pickTransition ? null : (this.selectedTile ? { sourceTile: this.selectedTile } : null);
      this.updatePickBanner();
      this.renderSidebar(ctx);
    });
    for (const el of document.querySelectorAll('[data-remove-transition]')) {
      el.addEventListener('click', () => {
        if (!this.selectedTile?.transitions) return;
        const idx = Number(el.getAttribute('data-remove-transition'));
        this.selectedTile.transitions.splice(idx, 1);
        if (this.selectedTile.transitions.length === 0) delete this.selectedTile.transitions;
        this.scheduleSave(ctx);
        this.draw(ctx);
        this.renderSidebar(ctx);
      });
    }
  }

  private encounterRowsHtml(tile: WorldTileDefinition, encounters: EncounterDefinition[], readOnly: boolean): string {
    const disabled = readOnly ? ' disabled' : '';
    const entries = tile.encounterTable ?? [];
    const rows = entries.map((e, i) => {
      const options = encounters.map(enc =>
        `<option value="${enc.id}" ${enc.id === e.encounterId ? 'selected' : ''}>${escapeHtml(enc.name)}</option>`
      ).join('');
      return `
        <div class="admin-form-row sidebar-enc-row" data-index="${i}">
          <select class="sidebar-enc-encounter"${disabled}>${options}</select>
          <label>W <input type="number" class="sidebar-enc-weight" value="${e.weight}" min="1" step="1"${disabled}></label>
          ${readOnly ? '' : '<button class="admin-btn admin-btn-sm admin-btn-danger sidebar-enc-remove" type="button">×</button>'}
        </div>
      `;
    }).join('');
    const addBtn = readOnly ? '' : '<button class="admin-btn admin-btn-sm" id="sidebar-add-encounter" type="button">+ Encounter</button>';
    return `${addBtn}<div id="sidebar-encounters-list">${rows}</div>`;
  }

  private wireEncounterEvents(ctx: AdminContext): void {
    document.getElementById('sidebar-add-encounter')?.addEventListener('click', () => {
      if (!this.selectedTile) return;
      const c = ctx.getDisplayContent();
      const encounterDefs = c ? Object.values(c.encounters) : [];
      if (encounterDefs.length === 0) return;
      if (!this.selectedTile.encounterTable) this.selectedTile.encounterTable = [];
      this.selectedTile.encounterTable.push({ encounterId: encounterDefs[0].id, weight: 1 });
      this.scheduleSave(ctx);
      const section = document.getElementById('sidebar-encounters-section');
      if (section) {
        section.innerHTML = this.encounterRowsHtml(this.selectedTile, encounterDefs, ctx.isReadOnly());
        this.wireEncounterEvents(ctx);
      }
    });
    document.querySelectorAll<HTMLButtonElement>('.sidebar-enc-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        if (!this.selectedTile?.encounterTable) return;
        const row = btn.closest('.sidebar-enc-row');
        const index = parseInt(row?.getAttribute('data-index') ?? '-1');
        if (index >= 0) {
          this.selectedTile.encounterTable.splice(index, 1);
          this.scheduleSave(ctx);
          const section = document.getElementById('sidebar-encounters-section');
          const c = ctx.getDisplayContent();
          if (section) {
            section.innerHTML = this.encounterRowsHtml(this.selectedTile, c ? Object.values(c.encounters) : [], ctx.isReadOnly());
            this.wireEncounterEvents(ctx);
          }
        }
      });
    });
    document.querySelectorAll<HTMLElement>('.sidebar-enc-row').forEach(row => {
      const index = parseInt(row.getAttribute('data-index') ?? '-1');
      if (index < 0) return;
      row.querySelector('.sidebar-enc-encounter')?.addEventListener('change', e => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].encounterId = (e.target as HTMLSelectElement).value;
          this.scheduleSave(ctx);
        }
      });
      row.querySelector('.sidebar-enc-weight')?.addEventListener('input', e => {
        if (this.selectedTile?.encounterTable?.[index]) {
          this.selectedTile.encounterTable[index].weight = parseInt((e.target as HTMLInputElement).value) || 1;
          this.scheduleSave(ctx);
        }
      });
    });
  }

  private scheduleSave(ctx: AdminContext): void {
    if (this.saveTimeout) clearTimeout(this.saveTimeout);
    this.saveTimeout = setTimeout(() => this.saveSelectedTile(ctx), 300);
  }

  private async saveSelectedTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, this.selectedTile);
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = this.worldTileDefs.get(`${this.selectedTile.col},${this.selectedTile.row}`) ?? null;
      this.draw(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async addTileAtSlot(ctx: AdminContext, slot: AdjacentSlot): Promise<void> {
    if (ctx.isReadOnly()) return;

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
    // First room on a fresh map has no neighbors to inherit from — fall back to any zone.
    if (defaultZone === 'unknown') {
      const content = ctx.getDisplayContent();
      defaultZone = Object.keys(content?.zones ?? {})[0] ?? 'unknown';
    }

    const newTile: WorldTileDefinition = {
      id: '',
      mapId: this.selectedMapId,
      col: slot.col,
      row: slot.row,
      type: this.selectedTile?.type ?? 'plains',
      zone: defaultZone,
      name: 'New Room',
      encounterTable: this.selectedTile?.encounterTable ? [...this.selectedTile.encounterTable] : undefined,
    };

    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`, newTile);
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = this.worldTileDefs.get(`${newTile.col},${newTile.row}`) ?? newTile;
      this.draw(ctx);
      this.updateMapTileCount();
      this.renderSidebar(ctx);
      const input = document.getElementById('sidebar-name') as HTMLInputElement | null;
      input?.focus();
      input?.select();
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async deleteSelectedTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await deleteAdmin<{ world: WorldData }>(
        `/api/admin/world/tile${ctx.versionQueryParam()}`,
        { mapId: this.selectedTile.mapId, col: this.selectedTile.col, row: this.selectedTile.row });
      this.applyWorldUpdate(ctx, data.world);
      this.selectedTile = null;
      this.draw(ctx);
      this.updateMapTileCount();
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private async setAsStartTile(ctx: AdminContext): Promise<void> {
    if (!this.selectedTile) return;
    try {
      const data = await putAdmin<{ world: WorldData }>(
        `/api/admin/world/start-tile${ctx.versionQueryParam()}`,
        { mapId: this.selectedTile.mapId, col: this.selectedTile.col, row: this.selectedTile.row });
      this.applyWorldUpdate(ctx, data.world);
      this.draw(ctx);
      this.renderSidebar(ctx);
    } catch (err) {
      this.showSidebarError(err instanceof Error ? err.message : 'Network error');
    }
  }

  private applyWorldUpdate(ctx: AdminContext, world: WorldData): void {
    ctx.patchVersionContent({ world });
    this.rebuildMapData(ctx);
  }

  private showSidebarError(message: string): void {
    const errorEl = document.getElementById('sidebar-error');
    if (errorEl) {
      errorEl.textContent = message;
      setTimeout(() => { if (errorEl) errorEl.textContent = ''; }, 5000);
    }
  }
}
