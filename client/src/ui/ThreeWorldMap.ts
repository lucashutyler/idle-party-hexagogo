/**
 * WebGL-backed world map renderer (replaces CanvasWorldMap).
 *
 * Rendering split:
 *   • three.js (WebGL canvas) renders the *static* layers — parchment
 *     background, drop shadow, baked tile composite (tile fills + artwork
 *     + outlines + zone overlay + zone borders). These are uploaded as
 *     textures and the per-frame work collapses to a camera-matrix update.
 *   • An HTML overlay (`.three-map-overlay`) sits on top of the canvas
 *     and hosts every *dynamic* element — party sprite, other-player
 *     flags + count badges, hover highlight, path preview. The overlay
 *     carries a single `transform: translate scale translate` mirroring
 *     the three.js camera, so a single style update moves all children
 *     together when the user pans/zooms.
 *   • The tooltip is a separate cursor-positioned element (no map
 *     transform).
 *
 * Why this matters: the WebGL scene is render-on-demand. Idle = zero
 * GPU/CPU. Panning re-renders the scene but the textures are already on
 * the GPU. Party pulse + tween live entirely in CSS so they don't drive
 * any JS frame work.
 *
 * Public API parity with the prior CanvasWorldMap:
 *   setSendMove, setOnTileClick, adjustZoom, applyServerState,
 *   rebuildFromCache, recenterOnPlayer, pause, resume, destroy.
 */

import * as THREE from 'three';
import {
  HexGrid,
  HexTile,
  HEX_SIZE,
  getHexCorners,
  getNeighbors,
  pixelToCube,
  offsetToCube,
  cubeToPixel,
  cubeToOffset,
} from '@idle-party-rpg/shared';
import type {
  ServerStateMessage,
  ServerPartyState,
  BattleVisual,
  OtherPlayerState,
  WorldTileDefinition,
} from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';
import { artworkUrl, placeholderUrl } from './assets';

export interface TileClickInfo {
  col: number;
  row: number;
  tileType: string;
  zoneName: string;
  roomName: string;
  zoneId: string;
  isTraversable: boolean;
  isUnlocked: boolean;
  isSameZone: boolean;
  isCurrentTile: boolean;
  playersHere: { username: string; className?: string; partyId?: string }[];
  partyMemberUsernames: string[];
  dungeonId?: string;
}

// ─── Render constants ─────────────────────────────────────────
// Party sprite colors live in CSS — see `.three-map-party-inner` and its
// data-visual variants (default green, fighting orange, defeat red).

const PARCHMENT_FALLBACK_COLOR = '#3a2a1a';

const MIN_TILES_VISIBLE = 15;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEPS = [0.4, 0.7, 1.0, 1.5, 2.5] as const;
const ZOOM_STORAGE_KEY = 'mapZoom';

const OVERDRAG_FACTOR = 0.25;
const SPRING_DURATION = 250;
const DRAG_THRESHOLD = 5;

const DIR_TO_EDGE: [number, number][] = [
  [0, 1],
  [5, 0],
  [4, 5],
  [3, 4],
  [2, 3],
  [1, 2],
];

const SHADOW_OFFSET_X_WORLD = 40;
const SHADOW_OFFSET_Y_WORLD = 60;
const SHADOW_ALPHA = 0.5;
const SHADOW_BLUR_RADIUS = 10;
const SHADOW_BLUR_PAD = 30;

// Parchment plane is sized to a fixed quad and follows the camera at a
// reduced rate so it reads as a deeper background layer (parallax).
const PARCHMENT_PARALLAX = 0.3;

// ─── Image cache ──────────────────────────────────────────────

interface CachedImage {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
}

class ImageCache {
  private cache = new Map<string, CachedImage>();

  get(url: string, fallbackUrl: string | null, onLoad: () => void): HTMLImageElement | null {
    const existing = this.cache.get(url);
    if (existing) {
      if (existing.loaded) return existing.img;
      return null;
    }
    const entry: CachedImage = {
      img: new Image(),
      loaded: false,
      failed: false,
    };
    this.cache.set(url, entry);
    entry.img.onload = () => {
      entry.loaded = true;
      onLoad();
    };
    entry.img.onerror = () => {
      if (fallbackUrl && entry.img.src !== fallbackUrl) {
        entry.img.src = fallbackUrl;
      } else {
        entry.failed = true;
      }
    };
    entry.img.src = url;
    return null;
  }
}

// ─── Easing ───────────────────────────────────────────────────

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

// ─── Main class ───────────────────────────────────────────────

export class ThreeWorldMap {
  private container: HTMLElement;
  private worldCache: WorldCache;

  // DOM elements.
  private canvas: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private partyEl: HTMLDivElement;
  private hoverEl: HTMLDivElement;
  private pathEl: HTMLDivElement;
  private flagsEl: HTMLDivElement;
  private tooltipEl: HTMLDivElement;

  // three.js core.
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;

  // Scene planes.
  private parchmentMesh: THREE.Mesh | null = null;
  private parchmentMaterial: THREE.MeshBasicMaterial;
  private parchmentTexture: THREE.Texture | null = null;
  private shadowMesh: THREE.Mesh | null = null;
  private shadowMaterial: THREE.MeshBasicMaterial;
  private shadowTexture: THREE.CanvasTexture | null = null;
  private staticMesh: THREE.Mesh | null = null;
  private staticMaterial: THREE.MeshBasicMaterial;
  private staticTexture: THREE.CanvasTexture | null = null;

  // Bake state.
  private staticCanvas: HTMLCanvasElement | null = null;
  private staticBounds: { minX: number; minY: number; w: number; h: number } | null = null;
  private staticDirty = true;
  private shadowCanvas: HTMLCanvasElement | null = null;
  private shadowBlurredCanvas: HTMLCanvasElement | null = null;
  private shadowBounds: { minX: number; minY: number; w: number; h: number } | null = null;

  // Image cache (shared across renders).
  private imageCache = new ImageCache();
  private hexSpriteCache = new Map<string, HTMLCanvasElement>();
  private parchmentLoading = false;

  // Grid + content.
  private grid: HexGrid = new HexGrid();
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  // Camera state — camWorldX/Y is the world point currently centered on
  // screen; zoom is the magnification scalar. Maps directly to
  // `camera.position.x = camWorldX`, `camera.position.y = -camWorldY`
  // (Y flipped so positive world-Y still reads as "down" on screen),
  // and `camera.zoom = zoom`.
  private camWorldX = 0;
  private camWorldY = 0;
  private zoom = 1;

  // Spring-back animation state for overdrag.
  private springAnim: { startX: number; startY: number; targetX: number; targetY: number; startTime: number } | null = null;

  // Party state.
  private playerCol = 0;
  private playerRow = 0;
  private currentZone = '';
  private partyMemberUsernames: string[] = [];
  private lastOtherPlayers: OtherPlayerState[] = [];
  private currentBattleVisual: BattleVisual = 'none';

  // Party rendering. Movement is animated by a CSS transition on the
  // `.three-map-party` element (`left`/`top`); we just push the target.
  private partyRendered = false;
  private partyTargetCol = 0;
  private partyTargetRow = 0;

  // Server-provided path (col,row pairs).
  private serverPath: { col: number; row: number }[] = [];

  // Hover state.
  private hoverCol: number | null = null;
  private hoverRow: number | null = null;
  private mousePixelX = 0;
  private mousePixelY = 0;

  // Drag state.
  private pointerActive = false;
  private isDragging = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private dragStartCamX = 0;
  private dragStartCamY = 0;
  private dragDistance = 0;

  // Pinch zoom state.
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private pinchStartCenterX = 0;
  private pinchStartCenterY = 0;
  private pinchStartCamX = 0;
  private pinchStartCamY = 0;
  private isPinching = false;
  private lastTouch: { x: number; y: number } | null = null;

  // External callbacks.
  private sendMoveFn?: (col: number, row: number) => void;
  private onTileClickFn?: (info: TileClickInfo) => void;

  // Lifecycle.
  private destroyed = false;
  private isFirstState = true;
  private hasInitializedView = false;
  private resizeObserver?: ResizeObserver;
  private resizeHandler: () => void;

  // Render-on-demand bookkeeping.
  /** True while we have a pending RAF render queued. Coalesces multiple
   *  state pushes into one re-render. */
  private renderQueued = false;
  /** RAF id for the active animation loop (spring-back). When null, we're
   *  in pure render-on-demand mode. */
  private animRafId: number | null = null;

  constructor(container: HTMLElement, worldCache: WorldCache) {
    this.container = container;
    this.worldCache = worldCache;

    // ── DOM scaffolding ──────────────────────────────────────
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'three-world-map';
    this.container.appendChild(this.canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'three-map-overlay';
    this.container.appendChild(this.overlay);

    this.partyEl = document.createElement('div');
    this.partyEl.className = 'three-map-party';
    const partyInner = document.createElement('div');
    partyInner.className = 'three-map-party-inner';
    this.partyEl.appendChild(partyInner);
    this.partyEl.style.display = 'none';
    this.overlay.appendChild(this.partyEl);

    // Hover highlight — an SVG hex outline. Stroke color flips between
    // white/red via the data-traversable attribute (see CSS).
    this.hoverEl = document.createElement('div');
    this.hoverEl.className = 'three-map-hover';
    this.hoverEl.innerHTML =
      `<svg viewBox="-40 -35 80 70" width="80" height="70" preserveAspectRatio="xMidYMid meet">
        <polygon points="40,0 20,34.64 -20,34.64 -40,0 -20,-34.64 20,-34.64" fill="none" stroke="currentColor" stroke-width="3" />
      </svg>`;
    this.hoverEl.style.display = 'none';
    this.overlay.appendChild(this.hoverEl);

    this.pathEl = document.createElement('div');
    this.pathEl.className = 'three-map-path';
    this.overlay.appendChild(this.pathEl);

    this.flagsEl = document.createElement('div');
    this.flagsEl.className = 'three-map-flags';
    this.overlay.appendChild(this.flagsEl);

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'canvas-map-tooltip';
    this.tooltipEl.style.display = 'none';
    this.container.appendChild(this.tooltipEl);

    // ── three.js setup ───────────────────────────────────────
    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: true,
      alpha: false,
      premultipliedAlpha: true,
    });
    this.renderer.setClearColor(new THREE.Color(PARCHMENT_FALLBACK_COLOR), 1);
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);

    this.scene = new THREE.Scene();

    // OrthographicCamera frustum spans the canvas CSS pixels; we resize
    // it on every layout pass so screen-pixel math (pan/zoom, hit-test)
    // stays consistent with the DOM overlay.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 100;

    // Materials are persistent; their textures are swapped in as the
    // various bakes complete.
    this.parchmentMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(PARCHMENT_FALLBACK_COLOR),
      depthWrite: false,
      transparent: false,
    });
    this.shadowMaterial = new THREE.MeshBasicMaterial({
      color: 0x000000,
      opacity: SHADOW_ALPHA,
      transparent: true,
      depthWrite: false,
    });
    this.staticMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    });

    // ── Grid + content ───────────────────────────────────────
    this.grid = this.buildGridFromCache();
    this.loadParchment();
    this.attachInput();

    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }
    this.handleResize();
  }

  // ─── Public API ─────────────────────────────────────────────

  setSendMove(fn: (col: number, row: number) => void): void {
    this.sendMoveFn = fn;
  }

  setOnTileClick(fn: (info: TileClickInfo) => void): void {
    this.onTileClickFn = fn;
  }

  adjustZoom(delta: number): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const target = this.nextZoomStep(this.zoom, delta > 0 ? 1 : -1);
    this.zoomAt(target, cw / 2, ch / 2);
  }

  private nextZoomStep(current: number, direction: 1 | -1): number {
    let nearestIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const d = Math.abs(ZOOM_STEPS[i] - current);
      if (d < bestDelta) { bestDelta = d; nearestIdx = i; }
    }
    const STICKY_THRESHOLD = 0.02;
    if (bestDelta > STICKY_THRESHOLD) {
      if (direction > 0) {
        for (const z of ZOOM_STEPS) if (z > current) return z;
        return ZOOM_STEPS[ZOOM_STEPS.length - 1];
      }
      for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current) return ZOOM_STEPS[i];
      return ZOOM_STEPS[0];
    }
    const next = Math.max(0, Math.min(ZOOM_STEPS.length - 1, nearestIdx + direction));
    return ZOOM_STEPS[next];
  }

  applyServerState(state: ServerStateMessage, snap?: boolean): void {
    const shouldSnap = snap || this.isFirstState;

    const unlockedChanged = this.worldCache.updateUnlocked(state.unlocked);
    if (unlockedChanged || shouldSnap) {
      this.grid = this.buildGridFromCache();
    }

    this.applyPartyState(state.party, shouldSnap);
    this.currentBattleVisual = state.battle.visual;

    this.playerCol = state.party.col;
    this.playerRow = state.party.row;
    const myTile = this.grid.getTile(offsetToCube({ col: state.party.col, row: state.party.row }));
    const prevZone = this.currentZone;
    this.currentZone = myTile?.zone ?? '';
    if (this.currentZone !== prevZone) this.staticDirty = true;

    this.partyMemberUsernames = (state.social?.party?.members ?? []).map(m => m.username);
    this.lastOtherPlayers = state.otherPlayers;
    this.serverPath = state.party.path ?? [];

    if (shouldSnap || !this.hasInitializedView) {
      this.centerOnParty();
      this.hasInitializedView = true;
    }

    this.isFirstState = false;

    // State change → update overlays + redraw.
    this.updatePartyOverlay();
    this.updatePathOverlay();
    this.updateFlagsOverlay();
    this.updateBattleVisualClass();
    this.requestRender();
  }

  rebuildFromCache(): void {
    this.grid = this.buildGridFromCache();
    this.requestRender();
  }

  destroy(): void {
    this.destroyed = true;
    if (this.animRafId !== null) cancelAnimationFrame(this.animRafId);
    this.animRafId = null;

    window.removeEventListener('resize', this.resizeHandler);
    this.resizeObserver?.disconnect();

    this.staticTexture?.dispose();
    this.shadowTexture?.dispose();
    this.parchmentTexture?.dispose();
    this.staticMaterial.dispose();
    this.shadowMaterial.dispose();
    this.parchmentMaterial.dispose();
    this.renderer.dispose();

    this.canvas.remove();
    this.overlay.remove();
    this.tooltipEl.remove();
  }

  pause(): void {
    if (this.animRafId !== null) {
      cancelAnimationFrame(this.animRafId);
      this.animRafId = null;
    }
  }

  resume(): void {
    if (!this.destroyed) {
      this.handleResize();
      this.requestRender();
    }
  }

  recenterOnPlayer(): void {
    this.centerOnParty();
  }

  // ─── Grid building ──────────────────────────────────────────

  private buildGridFromCache(): HexGrid {
    const grid = new HexGrid();
    this.worldTileDefs.clear();

    for (const tileDef of this.worldCache.getTiles()) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tileTypeDef = this.worldCache.getTileTypeDef(tileDef.type);
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef);
      grid.addTile(tile);
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }

    this.shadowBounds = null;
    this.shadowBlurredCanvas = null;
    this.staticDirty = true;

    return grid;
  }

  // ─── Camera ────────────────────────────────────────────────

  private centerOnParty(): void {
    if (!this.partyRendered) return;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.camWorldX = px.x;
    this.camWorldY = px.y;
    this.springAnim = null;
    this.requestRender();
  }

  private computeInitialZoom(): number {
    const shorter = Math.min(this.canvasCssWidth(), this.canvasCssHeight());
    if (shorter <= 0) return 1;
    const hexHeight = Math.sqrt(3) * HEX_SIZE;
    const tilesAtZoom1 = shorter / hexHeight;
    if (tilesAtZoom1 >= MIN_TILES_VISIBLE) return 1;
    return Math.max(MIN_ZOOM, tilesAtZoom1 / MIN_TILES_VISIBLE);
  }

  private getMapBounds(): { minX: number; minY: number; maxX: number; maxY: number } {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const p = tile.pixelPosition;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    if (!isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    return { minX: minX - HEX_SIZE, minY: minY - HEX_SIZE, maxX: maxX + HEX_SIZE, maxY: maxY + HEX_SIZE };
  }

  /**
   * Bounds for camera position (world units) such that at least one
   * tile-width of map stays visible — i.e. the user can't scroll the
   * island entirely off-screen.
   */
  private getCamBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const b = this.getMapBounds();
    const z = this.zoom;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    // Half the visible world width/height at current zoom.
    const halfW = cw / 2 / z;
    const halfH = ch / 2 / z;
    // Pixel margin equivalent to ~2 tiles must stay visible.
    const tilePx = HEX_SIZE * 2;
    // Cam X range: keep at least tilePx of map inside the viewport.
    const minX = b.minX + tilePx - halfW;
    const maxX = b.maxX - tilePx + halfW;
    const minY = b.minY + tilePx - halfH;
    const maxY = b.maxY - tilePx + halfH;
    return { minX, maxX, minY, maxY };
  }

  private clampCamWithOverdrag(): void {
    const b = this.getCamBounds();
    const overW = (this.canvasCssWidth() / this.zoom) * OVERDRAG_FACTOR;
    const overH = (this.canvasCssHeight() / this.zoom) * OVERDRAG_FACTOR;

    const loX = Math.min(b.minX, b.maxX) - overW;
    const hiX = Math.max(b.minX, b.maxX) + overW;
    if (this.camWorldX < loX) this.camWorldX = loX;
    else if (this.camWorldX > hiX) this.camWorldX = hiX;

    const loY = Math.min(b.minY, b.maxY) - overH;
    const hiY = Math.max(b.minY, b.maxY) + overH;
    if (this.camWorldY < loY) this.camWorldY = loY;
    else if (this.camWorldY > hiY) this.camWorldY = hiY;
  }

  private springBackIfNeeded(): void {
    const b = this.getCamBounds();
    const lo = Math.min(b.minX, b.maxX);
    const hi = Math.max(b.minX, b.maxX);
    const loY = Math.min(b.minY, b.maxY);
    const hiY = Math.max(b.minY, b.maxY);

    const clampedX = Math.max(lo, Math.min(hi, this.camWorldX));
    const clampedY = Math.max(loY, Math.min(hiY, this.camWorldY));

    if (Math.abs(clampedX - this.camWorldX) > 0.5 || Math.abs(clampedY - this.camWorldY) > 0.5) {
      this.springAnim = {
        startX: this.camWorldX,
        startY: this.camWorldY,
        targetX: clampedX,
        targetY: clampedY,
        startTime: performance.now(),
      };
      this.ensureAnimLoop();
    } else {
      this.camWorldX = clampedX;
      this.camWorldY = clampedY;
    }
  }

  private zoomAt(newZoom: number, screenCssX: number, screenCssY: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (z === this.zoom) return;
    // Keep the world-point under the cursor stable.
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const worldX = this.camWorldX + (screenCssX - cw / 2) / this.zoom;
    const worldY = this.camWorldY + (screenCssY - ch / 2) / this.zoom;
    this.zoom = z;
    this.camWorldX = worldX - (screenCssX - cw / 2) / z;
    this.camWorldY = worldY - (screenCssY - ch / 2) / z;
    this.springAnim = null;
    this.persistZoom();
    this.requestRender();
  }

  private persistZoom(): void {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(this.zoom)); } catch { /* ignore */ }
  }

  private loadPersistedZoom(): number | null {
    try {
      const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
      if (raw === null) return null;
      const z = parseFloat(raw);
      if (!Number.isFinite(z)) return null;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    } catch { return null; }
  }

  // ─── Resize ────────────────────────────────────────────────

  private canvasCssWidth(): number {
    return this.container.clientWidth;
  }

  private canvasCssHeight(): number {
    return this.container.clientHeight;
  }

  private handleResize(): void {
    const w = this.canvasCssWidth();
    const h = this.canvasCssHeight();
    if (w <= 0 || h <= 0) return;

    this.renderer.setSize(w, h, false);
    // Camera frustum spans the CSS pixel viewport (so screen-pixel math
    // matches the DOM overlay 1:1).
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();

    if (!this.hasInitializedView) {
      this.zoom = this.loadPersistedZoom() ?? this.computeInitialZoom();
    }
    if (this.partyRendered && this.hasInitializedView) {
      this.centerOnParty();
    }

    this.requestRender();
  }

  // ─── Input ─────────────────────────────────────────────────

  private attachInput(): void {
    this.canvas.addEventListener('mousedown', e => {
      this.pointerActive = true;
      this.onPointerDown(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mousemove', e => {
      this.onPointerMove(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverCol = null;
      this.hoverRow = null;
      this.hideTooltip();
      this.updateHoverOverlay();
    });
    window.addEventListener('mousemove', e => {
      if (!this.pointerActive) return;
      this.onPointerMove(e.clientX, e.clientY);
    });
    window.addEventListener('mouseup', e => {
      if (!this.pointerActive) return;
      this.pointerActive = false;
      this.onPointerUp(e.clientX, e.clientY);
    });

    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const target = this.nextZoomStep(this.zoom, e.deltaY > 0 ? -1 : 1);
      this.zoomAt(target, cx, cy);
    }, { passive: false });

    this.canvas.addEventListener('touchstart', e => {
      if (e.touches.length === 1) {
        const t = e.touches[0];
        this.onPointerDown(t.clientX, t.clientY);
        this.lastTouch = { x: t.clientX, y: t.clientY };
      } else if (e.touches.length === 2) {
        this.beginPinch(e);
      }
    }, { passive: false });

    this.canvas.addEventListener('touchmove', e => {
      e.preventDefault();
      if (e.touches.length === 2 && this.isPinching) {
        this.updatePinch(e);
      } else if (e.touches.length === 1 && this.lastTouch) {
        const t = e.touches[0];
        this.onPointerMove(t.clientX, t.clientY);
        this.lastTouch = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });

    this.canvas.addEventListener('touchend', e => {
      e.preventDefault();
      if (e.touches.length === 0) {
        if (this.lastTouch) {
          this.onPointerUp(this.lastTouch.x, this.lastTouch.y);
          this.lastTouch = null;
        }
        this.isPinching = false;
      } else if (e.touches.length === 1 && this.isPinching) {
        this.isPinching = false;
        const t = e.touches[0];
        this.lastTouch = { x: t.clientX, y: t.clientY };
        this.dragStartClientX = t.clientX;
        this.dragStartClientY = t.clientY;
        this.dragStartCamX = this.camWorldX;
        this.dragStartCamY = this.camWorldY;
        this.isDragging = true;
        this.dragDistance = 0;
      }
    });
  }

  private beginPinch(e: TouchEvent): void {
    if (e.touches.length < 2) return;
    const a = e.touches[0];
    const b = e.touches[1];
    this.pinchStartDistance = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    this.pinchStartZoom = this.zoom;
    const rect = this.canvas.getBoundingClientRect();
    this.pinchStartCenterX = (a.clientX + b.clientX) / 2 - rect.left;
    this.pinchStartCenterY = (a.clientY + b.clientY) / 2 - rect.top;
    this.pinchStartCamX = this.camWorldX;
    this.pinchStartCamY = this.camWorldY;
    this.isPinching = true;
    this.isDragging = false;
  }

  private updatePinch(e: TouchEvent): void {
    if (e.touches.length < 2) return;
    const a = e.touches[0];
    const b = e.touches[1];
    const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    if (this.pinchStartDistance <= 0) return;
    const ratio = dist / this.pinchStartDistance;
    const newZoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, this.pinchStartZoom * ratio));
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const worldX = this.pinchStartCamX + (this.pinchStartCenterX - cw / 2) / this.pinchStartZoom;
    const worldY = this.pinchStartCamY + (this.pinchStartCenterY - ch / 2) / this.pinchStartZoom;
    this.zoom = newZoom;
    this.camWorldX = worldX - (this.pinchStartCenterX - cw / 2) / newZoom;
    this.camWorldY = worldY - (this.pinchStartCenterY - ch / 2) / newZoom;
    this.springAnim = null;
    this.persistZoom();
    this.requestRender();
  }

  private onPointerDown(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.dragStartClientX = clientX;
    this.dragStartClientY = clientY;
    this.dragStartCamX = this.camWorldX;
    this.dragStartCamY = this.camWorldY;
    this.dragDistance = 0;
    this.springAnim = null;
  }

  private onPointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mousePixelX = clientX - rect.left;
    this.mousePixelY = clientY - rect.top;

    if (this.isDragging) {
      const dxClient = clientX - this.dragStartClientX;
      const dyClient = clientY - this.dragStartClientY;
      this.dragDistance = Math.max(this.dragDistance, Math.abs(dxClient) + Math.abs(dyClient));
      // Drag moves camera in WORLD units = client delta / zoom (inverted —
      // dragging right pans the world right, which means the camera moves
      // LEFT in world coords).
      this.camWorldX = this.dragStartCamX - dxClient / this.zoom;
      this.camWorldY = this.dragStartCamY - dyClient / this.zoom;
      this.clampCamWithOverdrag();
      this.requestRender();
    } else {
      this.updateHover();
    }
  }

  private onPointerUp(clientX: number, clientY: number): void {
    const wasDragging = this.dragDistance > DRAG_THRESHOLD;
    this.isDragging = false;
    this.springBackIfNeeded();

    if (!wasDragging) {
      this.handleClick(clientX, clientY);
    }
  }

  // ─── Hover / click handlers ───────────────────────────────

  /** Convert a CSS-pixel point on the canvas to a world-coord point. */
  private screenToWorld(px: number, py: number): { x: number; y: number } {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    return {
      x: this.camWorldX + (px - cw / 2) / this.zoom,
      y: this.camWorldY + (py - ch / 2) / this.zoom,
    };
  }

  private getTileAtScreenPx(px: number, py: number): HexTile | null {
    const w = this.screenToWorld(px, py);
    const cube = pixelToCube({ x: w.x, y: w.y });
    return this.grid.getTile(cube) ?? null;
  }

  private updateHover(): void {
    const tile = this.getTileAtScreenPx(this.mousePixelX, this.mousePixelY);
    if (!tile) {
      this.hoverCol = null;
      this.hoverRow = null;
      this.hideTooltip();
      this.updateHoverOverlay();
      return;
    }
    const off = cubeToOffset(tile.coord);
    this.hoverCol = off.col;
    this.hoverRow = off.row;
    this.showTooltip(tile);
    this.updateHoverOverlay();
  }

  private showTooltip(tile: HexTile): void {
    if (!tile.isTraversable) {
      this.hideTooltip();
      return;
    }
    const off = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${off.col},${off.row}`);
    const isUnlocked = this.worldCache.isUnlocked(off.col, off.row);
    const zoneName = def?.zoneName ?? def?.zone ?? tile.zone;
    // Unexplored traversable tiles still get a tooltip — matches the room
    // popup, which labels them "{zone}: Unexplored Room".
    const roomName = isUnlocked && def?.name ? def.name : 'Unexplored Room';
    const label = `${zoneName}: ${roomName}`;

    this.tooltipEl.textContent = label;
    this.tooltipEl.style.left = `${this.mousePixelX + 12}px`;
    this.tooltipEl.style.top = `${this.mousePixelY - 32}px`;
    this.tooltipEl.style.display = 'block';
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  private handleClick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const tile = this.getTileAtScreenPx(px, py);
    if (!tile) return;

    if (!tile.isTraversable) return;

    const offset = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const isUnlocked = this.worldCache.isUnlocked(offset.col, offset.row);
    const isSameZone = tile.zone === this.currentZone;
    const isCurrentTile = offset.col === this.playerCol && offset.row === this.playerRow;

    const zoneName = def?.zoneName ?? def?.zone ?? tile.zone;
    const roomName = isUnlocked && def?.name
      ? def.name
      : (!isUnlocked && tile.isTraversable) ? 'Unexplored Room' : '';

    const playersHere = isSameZone
      ? this.lastOtherPlayers
        .filter(p => p.col === offset.col && p.row === offset.row)
        .map(p => ({ username: p.username, className: p.className, partyId: p.partyId }))
      : [];

    if (this.onTileClickFn) {
      this.onTileClickFn({
        col: offset.col,
        row: offset.row,
        tileType: this.worldCache.getTileTypeDef(tile.type)?.name ?? tile.type,
        zoneName,
        roomName,
        zoneId: tile.zone,
        isTraversable: tile.isTraversable,
        isUnlocked,
        isSameZone,
        isCurrentTile,
        playersHere,
        partyMemberUsernames: this.partyMemberUsernames,
        dungeonId: def?.dungeonId,
      });
    } else {
      this.sendMoveFn?.(offset.col, offset.row);
    }
  }

  // ─── Party state / animation ──────────────────────────────

  private applyPartyState(party: ServerPartyState, snap: boolean): void {
    if (!this.partyRendered) {
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyRendered = true;
      // First-ever placement should always snap — no transition from
      // (0,0). The data attribute below is read by CSS to disable the
      // transition for this one render.
      this.partyEl.dataset.snap = '1';
      return;
    }
    const posChanged = party.col !== this.partyTargetCol || party.row !== this.partyTargetRow;
    if (!posChanged) return;
    this.partyTargetCol = party.col;
    this.partyTargetRow = party.row;
    this.partyEl.dataset.snap = snap ? '1' : '0';
  }

  // ─── Render loop (on-demand) ──────────────────────────────

  /**
   * Schedule a single render for the next animation frame. Coalesces
   * multiple requests in the same frame into one render.
   */
  private requestRender(): void {
    if (this.destroyed) return;
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      if (this.destroyed) return;
      this.render();
    });
  }

  /**
   * Continuous animation loop, used only while the spring-back is active.
   * Party movement uses a CSS transition on the DOM party element, so it
   * doesn't need this loop at all. Self-cancels when the spring lands.
   */
  private ensureAnimLoop(): void {
    if (this.destroyed) return;
    if (this.animRafId !== null) return;
    const tick = () => {
      if (this.destroyed) { this.animRafId = null; return; }
      if (!this.springAnim) { this.animRafId = null; return; }
      const now = performance.now();
      const t = Math.min(1, (now - this.springAnim.startTime) / SPRING_DURATION);
      const e = easeOutCubic(t);
      this.camWorldX = this.springAnim.startX + (this.springAnim.targetX - this.springAnim.startX) * e;
      this.camWorldY = this.springAnim.startY + (this.springAnim.targetY - this.springAnim.startY) * e;
      const done = t >= 1;
      if (done) this.springAnim = null;
      this.render();
      this.animRafId = done ? null : requestAnimationFrame(tick);
    };
    this.animRafId = requestAnimationFrame(tick);
  }

  /**
   * Single render pass. Re-bakes any stale textures, updates the camera +
   * scene-mesh positions, refreshes the DOM overlay transform, and tells
   * three.js to draw.
   */
  private render(): void {
    if (this.destroyed) return;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    if (cw <= 0 || ch <= 0) return;

    if (this.staticDirty || !this.staticCanvas || !this.staticBounds) {
      this.bakeStaticLayer();
      this.updateStaticMesh();
    }
    if (!this.shadowCanvas || !this.shadowBlurredCanvas || !this.shadowBounds) {
      this.bakeShadow();
      this.updateShadowMesh();
    }
    this.updateParchmentMesh();

    // Camera: world Y flipped so positive world-Y reads as "down" on
    // screen, matching the canvas pixelPosition convention.
    this.camera.position.x = this.camWorldX;
    this.camera.position.y = -this.camWorldY;
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    // Parchment parallax: it follows the camera at a reduced rate so it
    // reads as a deeper layer behind the map.
    if (this.parchmentMesh) {
      this.parchmentMesh.position.x = this.camWorldX * (1 - PARCHMENT_PARALLAX);
      this.parchmentMesh.position.y = -this.camWorldY * (1 - PARCHMENT_PARALLAX);
    }

    this.renderer.render(this.scene, this.camera);

    this.updateOverlayTransform();
    // The hover highlight is overlay-positioned; keep it pinned to the
    // current tile as the camera moves.
    this.updateHoverOverlay();
  }

  // ─── Mesh / texture management ────────────────────────────

  private updateStaticMesh(): void {
    if (!this.staticBounds || !this.staticCanvas) {
      if (this.staticMesh) { this.scene.remove(this.staticMesh); this.staticMesh = null; }
      return;
    }
    const b = this.staticBounds;

    // (Re)build the texture; CanvasTexture wraps the offscreen canvas
    // and uploads to the GPU. `needsUpdate = true` triggers a re-upload
    // when the underlying canvas bytes change.
    if (this.staticTexture) this.staticTexture.dispose();
    this.staticTexture = new THREE.CanvasTexture(this.staticCanvas);
    this.staticTexture.colorSpace = THREE.SRGBColorSpace;
    this.staticTexture.minFilter = THREE.LinearFilter;
    this.staticTexture.magFilter = THREE.LinearFilter;
    this.staticMaterial.map = this.staticTexture;
    this.staticMaterial.needsUpdate = true;

    if (this.staticMesh) { this.scene.remove(this.staticMesh); this.staticMesh.geometry.dispose(); }
    const geom = new THREE.PlaneGeometry(b.w, b.h);
    this.staticMesh = new THREE.Mesh(geom, this.staticMaterial);
    // Place the mesh centered on the bounds midpoint; Y flipped for
    // canvas → three.js convention.
    this.staticMesh.position.set(b.minX + b.w / 2, -(b.minY + b.h / 2), 2);
    this.scene.add(this.staticMesh);
  }

  private updateShadowMesh(): void {
    if (!this.shadowBounds || !this.shadowBlurredCanvas) {
      if (this.shadowMesh) { this.scene.remove(this.shadowMesh); this.shadowMesh = null; }
      return;
    }
    const b = this.shadowBounds;
    const pad = SHADOW_BLUR_PAD;
    const padded = { w: b.w + 2 * pad, h: b.h + 2 * pad };

    if (this.shadowTexture) this.shadowTexture.dispose();
    this.shadowTexture = new THREE.CanvasTexture(this.shadowBlurredCanvas);
    this.shadowTexture.colorSpace = THREE.SRGBColorSpace;
    this.shadowTexture.minFilter = THREE.LinearFilter;
    this.shadowTexture.magFilter = THREE.LinearFilter;
    // The shadow material is black; we use the texture as alpha so the
    // material's `opacity` × the texture's RGB gives the final cast.
    this.shadowMaterial.map = this.shadowTexture;
    this.shadowMaterial.needsUpdate = true;

    if (this.shadowMesh) { this.scene.remove(this.shadowMesh); this.shadowMesh.geometry.dispose(); }
    const geom = new THREE.PlaneGeometry(padded.w, padded.h);
    this.shadowMesh = new THREE.Mesh(geom, this.shadowMaterial);
    // The padded blurred canvas extends pad units around the silhouette
    // bounds; centerpoint stays at the bounds midpoint + shadow offset.
    this.shadowMesh.position.set(
      b.minX + b.w / 2 + SHADOW_OFFSET_X_WORLD,
      -(b.minY + b.h / 2 + SHADOW_OFFSET_Y_WORLD),
      1,
    );
    this.scene.add(this.shadowMesh);
  }

  private updateParchmentMesh(): void {
    if (this.parchmentMesh) return;
    // Sized large enough to always cover the viewport at min zoom even
    // when the camera is at the map's far corner. 8000×8000 world units
    // is plenty for any practical map size.
    const geom = new THREE.PlaneGeometry(8000, 8000);
    this.parchmentMesh = new THREE.Mesh(geom, this.parchmentMaterial);
    this.parchmentMesh.position.set(0, 0, 0);
    this.scene.add(this.parchmentMesh);
  }

  // ─── Bakes ────────────────────────────────────────────────

  /**
   * Bake the static map composite (tile fills + artwork + outlines +
   * zone overlay + zone borders) into an offscreen canvas at zoom=1 in
   * world coords. Three.js then uploads this as a texture; pan/zoom is
   * a free GPU-side matrix update.
   */
  private bakeStaticLayer(): void {
    const tiles = this.grid.getAllTiles().filter(t => t.type !== 'void');
    if (tiles.length === 0) {
      this.staticCanvas = null;
      this.staticBounds = null;
      this.staticDirty = false;
      return;
    }

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const p = t.pixelPosition;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const margin = HEX_SIZE + 8;
    const bx = Math.floor(minX - margin);
    const by = Math.floor(minY - margin);
    const bw = Math.ceil(maxX - minX + margin * 2);
    const bh = Math.ceil(maxY - minY + margin * 2);

    if (!this.staticCanvas) this.staticCanvas = document.createElement('canvas');
    this.staticCanvas.width = bw;
    this.staticCanvas.height = bh;
    const ctx = this.staticCanvas.getContext('2d');
    if (!ctx) {
      this.staticDirty = false;
      return;
    }
    ctx.clearRect(0, 0, bw, bh);

    const corners = getHexCorners(HEX_SIZE);
    const bakeOx = -bx;
    const bakeOy = -by;
    const bakeZ = 1;

    for (const tile of tiles) {
      this.drawTile(ctx, tile, corners, bakeOx, bakeOy, bakeZ);
    }
    this.drawZoneOverlay(ctx, corners, bakeOx, bakeOy, bakeZ);
    this.drawZoneBorders(ctx, corners, bakeOx, bakeOy, bakeZ);

    this.staticBounds = { minX: bx, minY: by, w: bw, h: bh };
    this.staticDirty = false;
  }

  private bakeShadow(): void {
    const tiles = this.grid.getAllTiles().filter(t => t.type !== 'void');
    if (tiles.length === 0) {
      this.shadowCanvas = null;
      this.shadowBlurredCanvas = null;
      this.shadowBounds = null;
      return;
    }
    const corners = getHexCorners(HEX_SIZE);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const t of tiles) {
      const p = t.pixelPosition;
      if (p.x < minX) minX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.x > maxX) maxX = p.x;
      if (p.y > maxY) maxY = p.y;
    }
    const margin = HEX_SIZE + 2;
    const bx = Math.floor(minX - margin);
    const by = Math.floor(minY - margin);
    const bw = Math.ceil(maxX - minX + margin * 2);
    const bh = Math.ceil(maxY - minY + margin * 2);

    if (!this.shadowCanvas) this.shadowCanvas = document.createElement('canvas');
    this.shadowCanvas.width = bw;
    this.shadowCanvas.height = bh;
    const sctx = this.shadowCanvas.getContext('2d');
    if (!sctx) return;

    sctx.clearRect(0, 0, bw, bh);
    sctx.fillStyle = '#000';
    sctx.beginPath();
    for (const tile of tiles) {
      const p = tile.pixelPosition;
      const sx = p.x - bx;
      const sy = p.y - by;
      for (let i = 0; i < 6; i++) {
        const cx = sx + corners[i].x;
        const cy = sy + corners[i].y;
        if (i === 0) sctx.moveTo(cx, cy); else sctx.lineTo(cx, cy);
      }
      sctx.closePath();
    }
    sctx.fill('nonzero');

    // Pre-blurred copy: pad on each side so the blur halo isn't cropped.
    const pad = SHADOW_BLUR_PAD;
    const blurred = document.createElement('canvas');
    blurred.width = bw + pad * 2;
    blurred.height = bh + pad * 2;
    const bctx = blurred.getContext('2d');
    if (bctx) {
      bctx.filter = `blur(${SHADOW_BLUR_RADIUS}px)`;
      bctx.drawImage(this.shadowCanvas, pad, pad);
      bctx.filter = 'none';
    }
    this.shadowBlurredCanvas = blurred;
    this.shadowBounds = { minX: bx, minY: by, w: bw, h: bh };
  }

  // ─── Bake helpers (Canvas2D draws into the offscreen bake) ───

  private drawTile(
    ctx: CanvasRenderingContext2D,
    tile: HexTile, corners: { x: number; y: number }[], ox: number, oy: number, z: number,
  ): void {
    const p = tile.pixelPosition;
    const sx = p.x * z + ox;
    const sy = p.y * z + oy;

    const offset = cubeToOffset(tile.coord);
    const isNonTraversable = !tile.isTraversable;
    const isUnlocked = isNonTraversable ? false : this.worldCache.isUnlocked(offset.col, offset.row);
    const isZoneUnlocked = isNonTraversable ? false : this.worldCache.isZoneUnlocked(tile.zone);

    const darkenFactor = isNonTraversable ? 0.42 : isUnlocked ? 1 : isZoneUnlocked ? 0.55 : 0.32;
    const fillColor = darkenFactor >= 0.999
      ? this.colorToHex(tile.color)
      : this.darkenColorHex(this.colorToHex(tile.color), darkenFactor);

    ctx.save();
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const cx = sx + corners[i].x * z;
      const cy = sy + corners[i].y * z;
      if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
    }
    ctx.closePath();
    ctx.fillStyle = fillColor;
    ctx.fill();

    const drewArtwork = this.tryDrawTileArtwork(ctx, tile, sx, sy, z);

    ctx.strokeStyle = isUnlocked ? 'rgba(26,26,46,0.5)' : 'rgba(10,10,30,0.3)';
    ctx.lineWidth = Math.max(1, 2 * z);
    ctx.stroke();

    ctx.restore();

    if (!drewArtwork) {
      this.drawTileIcon(ctx, tile, sx, sy, z, darkenFactor);
    }
  }

  private tryDrawTileArtwork(
    ctx: CanvasRenderingContext2D,
    tile: HexTile, sx: number, sy: number, z: number,
  ): boolean {
    const offset = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const tileId = def?.id ?? '';

    const candidates: string[] = [];
    if (tileId) candidates.push(artworkUrl('tile', tileId));
    candidates.push(artworkUrl('tile-type', tile.type));

    let img: HTMLImageElement | null = null;
    let imgUrl = '';
    for (const url of candidates) {
      img = this.imageCache.get(url, null, () => {
        this.staticDirty = true;
        this.requestRender();
      });
      if (img) { imgUrl = url; break; }
    }
    if (!img) return false;

    const sprite = this.getHexSprite(imgUrl, img);
    const w = HEX_SIZE * 2 * z;
    const h = Math.sqrt(3) * HEX_SIZE * z;
    ctx.drawImage(sprite, sx - w / 2, sy - h / 2, w, h);
    return true;
  }

  private getHexSprite(url: string, img: HTMLImageElement): HTMLCanvasElement {
    const cached = this.hexSpriteCache.get(url);
    if (cached) return cached;
    const SPRITE_W = HEX_SIZE * 4;
    const SPRITE_H = Math.round(SPRITE_W * Math.sqrt(3) / 2);
    const canvas = document.createElement('canvas');
    canvas.width = SPRITE_W;
    canvas.height = SPRITE_H;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      this.hexSpriteCache.set(url, canvas);
      return canvas;
    }
    const s = SPRITE_W / 2;
    const cx = SPRITE_W / 2;
    const cy = SPRITE_H / 2;
    const cors = getHexCorners(s);
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
      const x = cx + cors[i].x;
      const y = cy + cors[i].y;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.clip();
    ctx.drawImage(img, 0, 0, SPRITE_W, SPRITE_H);
    this.hexSpriteCache.set(url, canvas);
    return canvas;
  }

  private drawTileIcon(
    ctx: CanvasRenderingContext2D,
    tile: HexTile, sx: number, sy: number, z: number, darkenFactor: number,
  ): void {
    const typeDef = this.worldCache.getTileTypeDef(tile.type);
    const icon = typeDef?.icon;
    if (!icon) return;
    ctx.save();
    ctx.globalAlpha = Math.max(0.35, darkenFactor);
    ctx.font = `${Math.round(24 * z)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, sx, sy);
    ctx.restore();
  }

  private drawZoneOverlay(
    ctx: CanvasRenderingContext2D,
    corners: { x: number; y: number }[], ox: number, oy: number, z: number,
  ): void {
    if (!this.currentZone) return;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.4)';
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      if (!tile.isTraversable) continue;
      if (tile.zone === this.currentZone) continue;
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const cx = sx + corners[i].x * z;
        const cy = sy + corners[i].y * z;
        if (i === 0) ctx.moveTo(cx, cy); else ctx.lineTo(cx, cy);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  private drawZoneBorders(
    ctx: CanvasRenderingContext2D,
    corners: { x: number; y: number }[], ox: number, oy: number, z: number,
  ): void {
    const processed = new Set<string>();
    ctx.save();
    ctx.lineCap = 'round';

    ctx.strokeStyle = 'rgba(255,170,0,0.3)';
    ctx.lineWidth = Math.max(2, 4 * z);
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const neighbors = getNeighbors(tile.coord);
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      for (let dir = 0; dir < 6; dir++) {
        const nb = this.grid.getTile(neighbors[dir]);
        if (!nb || nb.zone === tile.zone) continue;
        const key = tile.key < nb.key ? `${tile.key}|${nb.key}` : `${nb.key}|${tile.key}`;
        if (processed.has(key)) continue;
        processed.add(key);
        const [ci0, ci1] = DIR_TO_EDGE[dir];
        ctx.beginPath();
        ctx.moveTo(sx + corners[ci0].x * z, sy + corners[ci0].y * z);
        ctx.lineTo(sx + corners[ci1].x * z, sy + corners[ci1].y * z);
        ctx.stroke();
      }
    }

    processed.clear();
    ctx.strokeStyle = 'rgba(255,204,68,0.7)';
    ctx.lineWidth = Math.max(1.5, 2 * z);
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const neighbors = getNeighbors(tile.coord);
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      for (let dir = 0; dir < 6; dir++) {
        const nb = this.grid.getTile(neighbors[dir]);
        if (!nb || nb.zone === tile.zone) continue;
        const key = tile.key < nb.key ? `${tile.key}|${nb.key}` : `${nb.key}|${tile.key}`;
        if (processed.has(key)) continue;
        processed.add(key);
        const [ci0, ci1] = DIR_TO_EDGE[dir];
        ctx.beginPath();
        ctx.moveTo(sx + corners[ci0].x * z, sy + corners[ci0].y * z);
        ctx.lineTo(sx + corners[ci1].x * z, sy + corners[ci1].y * z);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ─── DOM overlay ───────────────────────────────────────────

  /**
   * Apply a single transform on the overlay so children positioned in
   * world coords (left:Xpx, top:Ypx) appear at the right screen position.
   * Formula: translate(W/2, H/2) · scale(zoom) · translate(-camX, -camY).
   */
  private updateOverlayTransform(): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    this.overlay.style.transform =
      `translate(${cw / 2}px, ${ch / 2}px) scale(${this.zoom}) translate(${-this.camWorldX}px, ${-this.camWorldY}px)`;
  }

  private updatePartyOverlay(): void {
    if (!this.partyRendered) {
      this.partyEl.style.display = 'none';
      return;
    }
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.partyEl.style.display = '';
    this.partyEl.style.left = `${px.x}px`;
    this.partyEl.style.top = `${px.y}px`;
    // Allow the snap-to-position render to land, then re-enable the
    // transition so the next move tweens. Reset on the following frame.
    if (this.partyEl.dataset.snap === '1') {
      requestAnimationFrame(() => { this.partyEl.dataset.snap = '0'; });
    }
  }

  private updateBattleVisualClass(): void {
    this.partyEl.dataset.visual = this.currentBattleVisual;
  }

  private updateHoverOverlay(): void {
    if (this.hoverCol === null || this.hoverRow === null) {
      this.hoverEl.style.display = 'none';
      return;
    }
    const tile = this.grid.getTile(offsetToCube({ col: this.hoverCol, row: this.hoverRow }));
    if (!tile) {
      this.hoverEl.style.display = 'none';
      return;
    }
    const p = tile.pixelPosition;
    this.hoverEl.style.display = '';
    this.hoverEl.style.left = `${p.x}px`;
    this.hoverEl.style.top = `${p.y}px`;
    this.hoverEl.dataset.traversable = tile.isTraversable ? '1' : '0';
  }

  private updatePathOverlay(): void {
    const html: string[] = [];
    for (let i = 0; i < this.serverPath.length; i++) {
      const step = this.serverPath[i];
      const p = cubeToPixel(offsetToCube({ col: step.col, row: step.row }));
      const isDest = i === this.serverPath.length - 1;
      if (isDest) {
        html.push(`<div class="three-map-path-dest" style="left:${p.x}px;top:${p.y}px"></div>`);
      } else {
        html.push(`<div class="three-map-path-step" style="left:${p.x}px;top:${p.y}px"></div>`);
      }
    }
    this.pathEl.innerHTML = html.join('');
  }

  private updateFlagsOverlay(): void {
    if (!this.currentZone) {
      this.flagsEl.innerHTML = '';
      return;
    }

    const partySet = new Set(this.partyMemberUsernames);
    const tileGroups = new Map<string, { col: number; row: number; count: number }>();
    for (const other of this.lastOtherPlayers) {
      if (other.zone !== this.currentZone) continue;
      if (partySet.has(other.username)) continue;
      const key = `${other.col},${other.row}`;
      const existing = tileGroups.get(key);
      if (existing) existing.count++;
      else tileGroups.set(key, { col: other.col, row: other.row, count: 1 });
    }

    const html: string[] = [];
    for (const group of tileGroups.values()) {
      const p = cubeToPixel(offsetToCube({ col: group.col, row: group.row }));
      const isOwnTile = group.col === this.playerCol && group.row === this.playerRow;
      const hue = this.hashHue(`${group.col},${group.row}`);
      if (isOwnTile) {
        html.push(
          `<div class="three-map-badge" style="left:${p.x + HEX_SIZE * 0.55}px;top:${p.y + HEX_SIZE * 0.55}px">+${group.count}</div>`,
        );
      } else {
        const flagColor = `hsl(${hue}, 70%, 55%)`;
        html.push(
          `<div class="three-map-flag" style="left:${p.x}px;top:${p.y - HEX_SIZE * 0.3}px">
            <svg viewBox="0 0 24 32" width="24" height="32">
              <line x1="12" y1="2" x2="12" y2="26" stroke="#3a2a1a" stroke-width="1.5" stroke-linecap="round"/>
              <polygon points="12,2 24,7 12,12" fill="${flagColor}" stroke="rgba(0,0,0,0.6)" stroke-width="1"/>
            </svg>
          </div>`,
        );
        if (group.count > 1) {
          html.push(
            `<div class="three-map-badge" style="left:${p.x + HEX_SIZE * 0.55}px;top:${p.y + HEX_SIZE * 0.55}px">×${group.count}</div>`,
          );
        }
      }
    }
    this.flagsEl.innerHTML = html.join('');
  }

  // ─── Misc helpers ─────────────────────────────────────────

  private colorToHex(color: number): string {
    return '#' + color.toString(16).padStart(6, '0');
  }

  private darkenColorHex(hex: string, factor: number): string {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = Math.floor(((n >> 16) & 0xff) * factor);
    const g = Math.floor(((n >> 8) & 0xff) * factor);
    const b = Math.floor((n & 0xff) * factor);
    return '#' + ((r << 16) | (g << 8) | b).toString(16).padStart(6, '0');
  }

  private hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  private loadParchment(): void {
    if (this.parchmentLoading) return;
    this.parchmentLoading = true;
    const loader = new THREE.TextureLoader();
    const url = artworkUrl('parchment', 'overworld');
    const fallback = placeholderUrl('parchment', { w: 256, h: 256, bg: '3a2a1a', fg: '5a4a3a' });
    const onLoaded = (tex: THREE.Texture) => {
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      // Repeat across the large parchment plane so the texture tiles.
      tex.repeat.set(8000 / 256, 8000 / 256);
      this.parchmentTexture = tex;
      this.parchmentMaterial.map = tex;
      // Once textured, clear the fallback solid color (otherwise it tints
      // the texture).
      this.parchmentMaterial.color.setHex(0xffffff);
      this.parchmentMaterial.needsUpdate = true;
      this.requestRender();
    };
    loader.load(url, onLoaded, undefined, () => {
      loader.load(fallback, onLoaded, undefined, () => { /* keep solid color */ });
    });
  }
}
