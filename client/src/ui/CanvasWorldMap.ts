/**
 * Canvas-based world map for the game client. Replaces the Phaser-based
 * WorldMapScene with a hand-rolled HTML5 Canvas implementation that supports
 * pan/zoom (mouse + touch + pinch), parchment background, per-tile artwork,
 * scroll bounce-back, smarter default zoom, and party flag rendering for
 * other players.
 *
 * Public API parity with WorldMapScene:
 *   setSendMove(fn), setOnTileClick(fn), adjustZoom(delta),
 *   applyServerState(state, snap?), rebuildFromCache()
 */

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
  MOVE_DURATION,
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
  playersHere: { username: string; className?: string }[];
  partyMemberUsernames: string[];
}

// ─── Render constants ─────────────────────────────────────────

const PARTY_COLOR_DEFAULT = '#44ff88';
const PARTY_COLOR_FIGHTING = '#ffaa44';
const PARTY_COLOR_DEFEAT = '#ff6b6b';

const PARCHMENT_FALLBACK_COLOR = '#3a2a1a';

const MIN_TILES_VISIBLE = 15;
const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
/** Five discrete zoom presets the +/- buttons (and wheel) snap between.
 *  Pinch zoom on mobile remains continuous; saved zoom restores exactly. */
const ZOOM_STEPS = [0.4, 0.7, 1.0, 1.5, 2.5] as const;
/** localStorage key for the user's preferred zoom level (per-browser, not synced). */
const ZOOM_STORAGE_KEY = 'mapZoom';

const OVERDRAG_FACTOR = 0.25;
const SPRING_DURATION = 250;

const DRAG_THRESHOLD = 5;

// Maps CUBE_DIRECTIONS index → hex corner indices for the shared edge.
const DIR_TO_EDGE: [number, number][] = [
  [0, 1],
  [5, 0],
  [4, 5],
  [3, 4],
  [2, 3],
  [1, 2],
];

// ─── Image cache ──────────────────────────────────────────────

interface CachedImage {
  img: HTMLImageElement;
  loaded: boolean;
  failed: boolean;
}

class ImageCache {
  private cache = new Map<string, CachedImage>();

  /** Get a cached image, kicking off async load on first request. Returns null until loaded. */
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

function easeInOutQuad(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

// ─── Main class ───────────────────────────────────────────────

export class CanvasWorldMap {
  private container: HTMLElement;
  private worldCache: WorldCache;
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private grid: HexGrid = new HexGrid();
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  // Pan/zoom state — offset in canvas pixels, zoom is a scalar multiplier.
  private offsetX = 0;
  private offsetY = 0;
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

  // Party rendering: lastCol/lastRow track where we are NOW (start of any active tween),
  // targetCol/targetRow are the destination, plus tween timing.
  private partyRendered = false;
  private partyLastCol = 0;
  private partyLastRow = 0;
  private partyTargetCol = 0;
  private partyTargetRow = 0;
  private partyTweenStart = 0;
  private partyTweenActive = false;

  // Server-provided path (col,row pairs).
  private serverPath: { col: number; row: number }[] = [];

  // Hover state.
  private hoverCol: number | null = null;
  private hoverRow: number | null = null;
  private mousePixelX = 0;
  private mousePixelY = 0;

  // Drag state.
  /** True while a pointer gesture that originated on the canvas is in flight.
   * Window-level mousemove/mouseup listeners gate on this so clicks on
   * overlays above the canvas can't fire phantom tile clicks. */
  private pointerActive = false;
  private isDragging = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private dragStartOffsetX = 0;
  private dragStartOffsetY = 0;
  private dragDistance = 0;

  // Pinch zoom state.
  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private pinchStartCenterX = 0;
  private pinchStartCenterY = 0;
  private pinchStartOffsetX = 0;
  private pinchStartOffsetY = 0;
  private isPinching = false;

  // Touch tracking.
  private lastTouch: { x: number; y: number } | null = null;

  // External callbacks.
  private sendMoveFn?: (col: number, row: number) => void;
  private onTileClickFn?: (info: TileClickInfo) => void;

  // Loop / lifecycle.
  private rafId: number | null = null;
  private destroyed = false;
  private isFirstState = true;
  private hasInitializedView = false;

  // Tooltip element (DOM, fixed-positioned over canvas).
  private tooltipEl: HTMLDivElement;

  // Resize observer.
  private resizeObserver?: ResizeObserver;
  private resizeHandler: () => void;

  // Image cache (shared across renders).
  private imageCache = new ImageCache();
  private parchmentPattern: CanvasPattern | null = null;
  private parchmentLoading = false;
  /** Cached silhouette of the entire map, baked at zoom=1 in world-coord
   *  space. Rebuilt only when the grid changes; on each frame we just blit
   *  it (translate + scale + blur) which is cheap. */
  private shadowCanvas: HTMLCanvasElement | null = null;
  /** World-space bounds the cached silhouette covers. */
  private shadowBounds: { minX: number; minY: number; w: number; h: number } | null = null;

  constructor(container: HTMLElement, worldCache: WorldCache) {
    this.container = container;
    this.worldCache = worldCache;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'canvas-world-map';
    this.container.appendChild(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('CanvasWorldMap: 2D context unavailable');
    this.ctx = ctx;

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'canvas-map-tooltip';
    this.tooltipEl.style.display = 'none';
    this.container.appendChild(this.tooltipEl);

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

    this.startRenderLoop();
  }

  // ─── Public API ─────────────────────────────────────────────

  setSendMove(fn: (col: number, row: number) => void): void {
    this.sendMoveFn = fn;
  }

  setOnTileClick(fn: (info: TileClickInfo) => void): void {
    this.onTileClickFn = fn;
  }

  /** Snap to the next/previous discrete zoom preset. `delta` is the *step*
   *  count (positive = zoom in, negative = zoom out), not a continuous value. */
  adjustZoom(delta: number): void {
    const cx = this.canvas.width / 2;
    const cy = this.canvas.height / 2;
    const target = this.nextZoomStep(this.zoom, delta > 0 ? 1 : -1);
    this.zoomAt(target, cx, cy);
  }

  /** Find the nearest preset step to `current`, then offset by `direction`
   *  (+1 = zoom in, -1 = zoom out). Returns the chosen preset value. */
  private nextZoomStep(current: number, direction: 1 | -1): number {
    let nearestIdx = 0;
    let bestDelta = Infinity;
    for (let i = 0; i < ZOOM_STEPS.length; i++) {
      const d = Math.abs(ZOOM_STEPS[i] - current);
      if (d < bestDelta) { bestDelta = d; nearestIdx = i; }
    }
    // If we're noticeably above/below the nearest preset, treat that nearest
    // step as a "free" stop so the user lands on it before stepping further.
    const STICKY_THRESHOLD = 0.02;
    if (bestDelta > STICKY_THRESHOLD) {
      // Snap toward the direction of travel — find the next preset in that direction.
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

    // Update party position with optional tween.
    this.applyPartyState(state.party, shouldSnap);
    this.currentBattleVisual = state.battle.visual;

    this.playerCol = state.party.col;
    this.playerRow = state.party.row;
    const myTile = this.grid.getTile(offsetToCube({ col: state.party.col, row: state.party.row }));
    this.currentZone = myTile?.zone ?? '';

    this.partyMemberUsernames = (state.social?.party?.members ?? []).map(m => m.username);
    this.lastOtherPlayers = state.otherPlayers;
    this.serverPath = state.party.path ?? [];

    if (shouldSnap || !this.hasInitializedView) {
      // Center camera on party.
      this.centerOnParty();
      this.hasInitializedView = true;
    }

    this.isFirstState = false;
  }

  /** Rebuild the grid from updated WorldCache data. */
  rebuildFromCache(): void {
    this.grid = this.buildGridFromCache();
    // Grid changed → silhouette is stale; rebake on next draw.
    this.shadowBounds = null;
  }

  /** Tear down listeners and stop rendering. */
  destroy(): void {
    this.destroyed = true;
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;

    window.removeEventListener('resize', this.resizeHandler);
    this.resizeObserver?.disconnect();

    this.canvas.remove();
    this.tooltipEl.remove();
  }

  /** Pause the render loop (call when screen is hidden). */
  pause(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  /** Resume the render loop. */
  resume(): void {
    if (this.rafId === null && !this.destroyed) {
      this.handleResize();
      this.startRenderLoop();
    }
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

    return grid;
  }

  // ─── Camera ────────────────────────────────────────────────

  private centerOnParty(): void {
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.offsetX = this.canvas.width / 2 - px.x * this.zoom;
    this.offsetY = this.canvas.height / 2 - px.y * this.zoom;
    this.springAnim = null;
  }

  /** Compute initial zoom: ensure at least MIN_TILES_VISIBLE tiles fit along the shorter dimension. */
  private computeInitialZoom(): number {
    const shorter = Math.min(this.canvas.width, this.canvas.height);
    if (shorter <= 0) return 1;
    const hexHeight = Math.sqrt(3) * HEX_SIZE; // pixel size of a hex along the shorter axis
    const tilesAtZoom1 = shorter / hexHeight;
    if (tilesAtZoom1 >= MIN_TILES_VISIBLE) return 1;
    return Math.max(MIN_ZOOM, tilesAtZoom1 / MIN_TILES_VISIBLE);
  }

  /** Compute the bounding box of all renderable tiles in world (pre-zoom) pixel coords. */
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
   * Compute the valid offset range so the camera always keeps at least
   * MIN_TILES_VISIBLE_FOR_BOUNDS tiles on screen (i.e. the user can't
   * scroll the map entirely off-canvas). Returns offset bounds.
   */
  private getOffsetBounds(): { minOffsetX: number; maxOffsetX: number; minOffsetY: number; maxOffsetY: number } {
    const b = this.getMapBounds();
    const z = this.zoom;
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    // Pixel margin equivalent to 2 tiles: must keep at least 2 tiles visible.
    const tilePx = HEX_SIZE * 2 * z;
    // The world rect on screen is [b.minX*z + offsetX, b.maxX*z + offsetX].
    // We need at least 2 tiles of overlap with [0, canvas.width]:
    //   maxOffsetX = canvas.width - tilePx - b.minX*z
    //   minOffsetX = tilePx - b.maxX*z
    const maxOffsetX = cw - tilePx - b.minX * z;
    const minOffsetX = tilePx - b.maxX * z;
    const maxOffsetY = ch - tilePx - b.minY * z;
    const minOffsetY = tilePx - b.maxY * z;
    return { minOffsetX, maxOffsetX, minOffsetY, maxOffsetY };
  }

  private clampOffsetWithOverdrag(): void {
    const b = this.getOffsetBounds();
    const overX = (b.maxOffsetX - b.minOffsetX) * OVERDRAG_FACTOR + this.canvas.width * OVERDRAG_FACTOR;
    const overY = (b.maxOffsetY - b.minOffsetY) * OVERDRAG_FACTOR + this.canvas.height * OVERDRAG_FACTOR;

    const lo = b.minOffsetX - overX;
    const hi = b.maxOffsetX + overX;
    if (this.offsetX < Math.min(lo, hi)) this.offsetX = Math.min(lo, hi);
    else if (this.offsetX > Math.max(lo, hi)) this.offsetX = Math.max(lo, hi);

    const loY = b.minOffsetY - overY;
    const hiY = b.maxOffsetY + overY;
    if (this.offsetY < Math.min(loY, hiY)) this.offsetY = Math.min(loY, hiY);
    else if (this.offsetY > Math.max(loY, hiY)) this.offsetY = Math.max(loY, hiY);
  }

  private springBackIfNeeded(): void {
    const b = this.getOffsetBounds();
    const targetX = Math.max(Math.min(b.maxOffsetX, b.minOffsetX), Math.min(Math.max(b.maxOffsetX, b.minOffsetX), this.offsetX));
    const targetY = Math.max(Math.min(b.maxOffsetY, b.minOffsetY), Math.min(Math.max(b.maxOffsetY, b.minOffsetY), this.offsetY));

    // Use [min, max] regardless of sign of bounds.
    const lo = Math.min(b.minOffsetX, b.maxOffsetX);
    const hi = Math.max(b.minOffsetX, b.maxOffsetX);
    const loY = Math.min(b.minOffsetY, b.maxOffsetY);
    const hiY = Math.max(b.minOffsetY, b.maxOffsetY);

    const clampedX = Math.max(lo, Math.min(hi, this.offsetX));
    const clampedY = Math.max(loY, Math.min(hiY, this.offsetY));

    if (Math.abs(clampedX - this.offsetX) > 0.5 || Math.abs(clampedY - this.offsetY) > 0.5) {
      this.springAnim = {
        startX: this.offsetX,
        startY: this.offsetY,
        targetX: clampedX,
        targetY: clampedY,
        startTime: performance.now(),
      };
    } else {
      this.offsetX = targetX;
      this.offsetY = targetY;
    }
  }

  private zoomAt(newZoom: number, cx: number, cy: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (z === this.zoom) return;
    // Keep the world-point under (cx,cy) stable.
    const worldX = (cx - this.offsetX) / this.zoom;
    const worldY = (cy - this.offsetY) / this.zoom;
    this.zoom = z;
    this.offsetX = cx - worldX * z;
    this.offsetY = cy - worldY * z;
    this.springAnim = null;
    this.persistZoom();
  }

  /** Save the current zoom level to localStorage so it sticks across reloads on this browser. */
  private persistZoom(): void {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(this.zoom)); } catch { /* ignore */ }
  }

  /** Load saved zoom from localStorage; returns null if absent or invalid. */
  private loadPersistedZoom(): number | null {
    try {
      const raw = localStorage.getItem(ZOOM_STORAGE_KEY);
      if (raw === null) return null;
      const z = parseFloat(raw);
      if (!Number.isFinite(z)) return null;
      return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z));
    } catch { return null; }
  }

  /** Public — center camera on the player's party (used when re-clicking the Map tab). */
  recenterOnPlayer(): void {
    this.centerOnParty();
  }

  // ─── Resize ────────────────────────────────────────────────

  private handleResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w <= 0 || h <= 0) return;
    const dpr = window.devicePixelRatio || 1;

    // Match the canvas's CSS size with its drawing buffer (scaled by DPR).
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);

    // Use untransformed pixel coords by setting transform from scratch each frame.
    // We simulate "logical" coords by storing offsets in DPR-scaled pixels.
    // For simplicity we always work in canvas-pixel coords (post-DPR).
    if (!this.hasInitializedView) {
      // Prefer the player's saved zoom on this browser; fall back to the
      // smarter default that fits ≥ MIN_TILES_VISIBLE tiles.
      this.zoom = this.loadPersistedZoom() ?? this.computeInitialZoom();
    }

    // If camera was centered on party, re-center on resize so it doesn't drift off.
    if (this.partyRendered && this.hasInitializedView) {
      // Keep the camera stable around the party.
      this.centerOnParty();
    }
  }

  // ─── Input ─────────────────────────────────────────────────

  private attachInput(): void {
    // mousedown is on the canvas only — that's how we distinguish a gesture
    // that started on the map from a click on a popup/overlay above it.
    // mousemove + mouseup are on window so panning still works when the
    // pointer drifts off the canvas mid-drag, but we gate them on the
    // `pointerActive` flag set by onPointerDown so a click on an overlay
    // (e.g. the RoomView modal) can't fire a phantom tile click on the map.
    this.canvas.addEventListener('mousedown', e => {
      this.pointerActive = true;
      this.onPointerDown(e.clientX, e.clientY);
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
      const dpr = window.devicePixelRatio || 1;
      const cx = (e.clientX - rect.left) * dpr;
      const cy = (e.clientY - rect.top) * dpr;
      // Wheel snaps to the same 5 presets as the +/- buttons.
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
      // Suppress the browser-synthesized click that fires ~300ms after
      // touchend at the same coords. Without this, the click lands on
      // whatever DOM element is at that position *now* — usually the modal
      // we just opened (running the user to the room or dismissing it).
      e.preventDefault();
      if (e.touches.length === 0) {
        if (this.lastTouch) {
          this.onPointerUp(this.lastTouch.x, this.lastTouch.y);
          this.lastTouch = null;
        }
        this.isPinching = false;
      } else if (e.touches.length === 1 && this.isPinching) {
        // Finished pinch but one finger still down — reset to drag.
        this.isPinching = false;
        const t = e.touches[0];
        this.lastTouch = { x: t.clientX, y: t.clientY };
        this.dragStartClientX = t.clientX;
        this.dragStartClientY = t.clientY;
        this.dragStartOffsetX = this.offsetX;
        this.dragStartOffsetY = this.offsetY;
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
    const dpr = window.devicePixelRatio || 1;
    this.pinchStartCenterX = ((a.clientX + b.clientX) / 2 - rect.left) * dpr;
    this.pinchStartCenterY = ((a.clientY + b.clientY) / 2 - rect.top) * dpr;
    this.pinchStartOffsetX = this.offsetX;
    this.pinchStartOffsetY = this.offsetY;
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
    // Reset transform from pinch start, then apply zoom around the pinch center.
    const worldX = (this.pinchStartCenterX - this.pinchStartOffsetX) / this.pinchStartZoom;
    const worldY = (this.pinchStartCenterY - this.pinchStartOffsetY) / this.pinchStartZoom;
    this.zoom = newZoom;
    this.offsetX = this.pinchStartCenterX - worldX * newZoom;
    this.offsetY = this.pinchStartCenterY - worldY * newZoom;
    this.springAnim = null;
    this.persistZoom();
  }

  private onPointerDown(clientX: number, clientY: number): void {
    this.isDragging = true;
    this.dragStartClientX = clientX;
    this.dragStartClientY = clientY;
    this.dragStartOffsetX = this.offsetX;
    this.dragStartOffsetY = this.offsetY;
    this.dragDistance = 0;
    this.springAnim = null;
  }

  private onPointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.mousePixelX = (clientX - rect.left) * dpr;
    this.mousePixelY = (clientY - rect.top) * dpr;

    if (this.isDragging) {
      const dxClient = clientX - this.dragStartClientX;
      const dyClient = clientY - this.dragStartClientY;
      this.dragDistance = Math.max(this.dragDistance, Math.abs(dxClient) + Math.abs(dyClient));
      this.offsetX = this.dragStartOffsetX + dxClient * dpr;
      this.offsetY = this.dragStartOffsetY + dyClient * dpr;
      this.clampOffsetWithOverdrag();
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

  private screenToWorld(px: number, py: number): { x: number; y: number } {
    return {
      x: (px - this.offsetX) / this.zoom,
      y: (py - this.offsetY) / this.zoom,
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
      return;
    }
    const off = cubeToOffset(tile.coord);
    this.hoverCol = off.col;
    this.hoverRow = off.row;
    this.showTooltip(tile);
  }

  private showTooltip(tile: HexTile): void {
    const off = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${off.col},${off.row}`);

    let label: string;
    if (!tile.isTraversable) {
      label = this.worldCache.getTileTypeDef(tile.type)?.name ?? tile.type;
    } else {
      const zoneName = def?.zoneName ?? def?.zone ?? tile.zone;
      const isSameZone = tile.zone === this.currentZone;
      if (isSameZone) {
        const isUnlocked = this.worldCache.isUnlocked(off.col, off.row);
        if (isUnlocked && def?.name) label = `${zoneName}\n${def.name}`;
        else label = `${zoneName}\nUndiscovered`;
      } else {
        label = zoneName;
      }
    }

    this.tooltipEl.textContent = label;
    const dpr = window.devicePixelRatio || 1;
    this.tooltipEl.style.left = `${this.mousePixelX / dpr + 12}px`;
    this.tooltipEl.style.top = `${this.mousePixelY / dpr - 32}px`;
    this.tooltipEl.style.display = 'block';
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  private handleClick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    const px = (clientX - rect.left) * dpr;
    const py = (clientY - rect.top) * dpr;
    const tile = this.getTileAtScreenPx(px, py);
    if (!tile) return;

    if (!tile.isTraversable) {
      // No flash effect — just ignore (matches Phaser version's red flash UX).
      return;
    }

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
        .map(p => ({ username: p.username, className: p.className }))
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
      });
    } else {
      this.sendMoveFn?.(offset.col, offset.row);
    }
  }

  // ─── Party state / animation ──────────────────────────────

  private applyPartyState(party: ServerPartyState, snap: boolean): void {
    if (!this.partyRendered) {
      this.partyLastCol = party.col;
      this.partyLastRow = party.row;
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyRendered = true;
      this.partyTweenActive = false;
      return;
    }

    const posChanged = party.col !== this.partyTargetCol || party.row !== this.partyTargetRow;
    if (!posChanged) return;

    if (snap) {
      this.partyLastCol = party.col;
      this.partyLastRow = party.row;
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyTweenActive = false;
    } else {
      // Start tween from current target → new target.
      this.partyLastCol = this.partyTargetCol;
      this.partyLastRow = this.partyTargetRow;
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyTweenStart = performance.now();
      this.partyTweenActive = true;
    }
  }

  private getPartyPixel(now: number): { x: number; y: number } {
    if (!this.partyTweenActive) {
      return cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    }
    const t = Math.min(1, (now - this.partyTweenStart) / MOVE_DURATION);
    if (t >= 1) {
      this.partyTweenActive = false;
      this.partyLastCol = this.partyTargetCol;
      this.partyLastRow = this.partyTargetRow;
      return cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    }
    const eased = easeInOutQuad(t);
    const a = cubeToPixel(offsetToCube({ col: this.partyLastCol, row: this.partyLastRow }));
    const b = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    return {
      x: a.x + (b.x - a.x) * eased,
      y: a.y + (b.y - a.y) * eased,
    };
  }

  // ─── Render loop ──────────────────────────────────────────

  private startRenderLoop(): void {
    const tick = () => {
      if (this.destroyed) return;
      this.advanceSpring();
      this.draw();
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  private advanceSpring(): void {
    if (!this.springAnim) return;
    const now = performance.now();
    const t = Math.min(1, (now - this.springAnim.startTime) / SPRING_DURATION);
    const e = easeOutCubic(t);
    this.offsetX = this.springAnim.startX + (this.springAnim.targetX - this.springAnim.startX) * e;
    this.offsetY = this.springAnim.startY + (this.springAnim.targetY - this.springAnim.startY) * e;
    if (t >= 1) this.springAnim = null;
  }

  private draw(): void {
    const c = this.ctx;
    const cw = this.canvas.width;
    const ch = this.canvas.height;

    // Background fill (always behind parchment so we never see "blank" briefly).
    c.fillStyle = PARCHMENT_FALLBACK_COLOR;
    c.fillRect(0, 0, cw, ch);

    // Parchment fill (if loaded). Drawn with a subtle parallax — the
    // pattern translates at ~30% of the camera offset, so as the map pans
    // the parchment appears further back, enhancing the "tiles floating
    // above" illusion.
    if (this.parchmentPattern) {
      const parallax = 0.3;
      c.fillStyle = this.parchmentPattern;
      c.save();
      c.translate(this.offsetX * parallax, this.offsetY * parallax);
      c.fillRect(-this.offsetX * parallax, -this.offsetY * parallax, cw, ch);
      c.restore();
    }

    const corners = getHexCorners(HEX_SIZE);
    const z = this.zoom;
    const ox = this.offsetX;
    const oy = this.offsetY;

    // Map-wide drop shadow: render the unioned silhouette of every tile to
    // an offscreen buffer, then blit it onto the main canvas with offset
    // and blur. This produces ONE shadow for the whole island rather than a
    // per-tile shadow that bleeds between adjacent hexes. Tiles drawn on
    // top remain fully opaque.
    this.drawMapShadow(corners, ox, oy, z);

    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      this.drawTile(tile, corners, ox, oy, z);
    }

    // Zone overlay (darken non-current-zone traversable tiles).
    this.drawZoneOverlay(corners, ox, oy, z);

    // Zone borders.
    this.drawZoneBorders(corners, ox, oy, z);

    // Path trail.
    this.drawPath(ox, oy, z);

    // Other players (party flags + count badges).
    this.drawOtherPlayers(ox, oy, z);

    // Hover highlight.
    this.drawHoverHighlight(corners, ox, oy, z);

    // Player party.
    this.drawParty(ox, oy, z);
  }

  /**
   * Drop shadow of the entire map silhouette, drawn as a single shape.
   *
   * Optimization: the silhouette is baked once at zoom=1 in *world* coords
   * (sized to the grid's bounding box, NOT the canvas) and cached. On each
   * frame we only do a single blurred drawImage with a translate + scale —
   * no path rebuilding, no per-frame canvas resize. Rebakes only when the
   * grid itself changes (rebuildFromCache invalidates `shadowBounds`).
   */
  private drawMapShadow(corners: { x: number; y: number }[], ox: number, oy: number, z: number): void {
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw <= 0 || ch <= 0) return;

    // (Re)bake the silhouette in world coords if missing/stale.
    if (!this.shadowCanvas || !this.shadowBounds) {
      this.bakeShadowSilhouette(corners);
    }
    const bounds = this.shadowBounds;
    const buf = this.shadowCanvas;
    if (!bounds || !buf) return;

    const SHADOW_OFFSET_X = 40;
    const SHADOW_OFFSET_Y = 60;
    const SHADOW_SCALE = 0.88;

    // World → screen for the buffer's top-left corner, then add shadow offset
    // and a center-nudge to shrink the silhouette around its own center.
    const screenX = bounds.minX * z + ox + SHADOW_OFFSET_X;
    const screenY = bounds.minY * z + oy + SHADOW_OFFSET_Y;
    const drawW = bounds.w * z * SHADOW_SCALE;
    const drawH = bounds.h * z * SHADOW_SCALE;
    const centerNudgeX = (bounds.w * z - drawW) / 2;
    const centerNudgeY = (bounds.h * z - drawH) / 2;

    const c = this.ctx;
    c.save();
    c.globalAlpha = 0.5;
    c.filter = `blur(${Math.max(4, 10 * z)}px)`;
    c.drawImage(buf, screenX + centerNudgeX, screenY + centerNudgeY, drawW, drawH);
    c.restore();
  }

  /**
   * Bake the unioned hex silhouette in world coordinates (one pixel = one
   * world unit at zoom=1). Buffer is sized to the grid's tight bounding box
   * plus a small margin to fit hex corners. Cheap to scale + blur each frame.
   */
  private bakeShadowSilhouette(corners: { x: number; y: number }[]): void {
    const tiles = this.grid.getAllTiles().filter(t => t.type !== 'void');
    if (tiles.length === 0) {
      this.shadowCanvas = null;
      this.shadowBounds = null;
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
    // Expand by HEX_SIZE on each side to fit hex corners that extend past
    // the center pixel position.
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

    this.shadowBounds = { minX: bx, minY: by, w: bw, h: bh };
  }

  private drawTile(tile: HexTile, corners: { x: number; y: number }[], ox: number, oy: number, z: number): void {
    const p = tile.pixelPosition;
    const sx = p.x * z + ox;
    const sy = p.y * z + oy;
    if (!this.inCanvasBounds(sx, sy, z)) return;

    const offset = cubeToOffset(tile.coord);
    const isNonTraversable = !tile.isTraversable;
    const isUnlocked = isNonTraversable ? false : this.worldCache.isUnlocked(offset.col, offset.row);
    const isZoneUnlocked = isNonTraversable ? false : this.worldCache.isZoneUnlocked(tile.zone);

    // Tiles must always be opaque — fog/zone-locked / non-traversable dim is
    // baked into the color rather than applied via globalAlpha. The map's
    // drop shadow needs a solid silhouette to render against the parchment;
    // any tile transparency would let parchment show *through* the map.
    const darkenFactor = isNonTraversable ? 0.42 : isUnlocked ? 1 : isZoneUnlocked ? 0.55 : 0.32;
    const fillColor = darkenFactor >= 0.999
      ? this.colorToHex(tile.color)
      : this.darkenColorHex(this.colorToHex(tile.color), darkenFactor);

    const c = this.ctx;
    c.save();

    // Build hex path
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const cx = sx + corners[i].x * z;
      const cy = sy + corners[i].y * z;
      if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
    }
    c.closePath();

    // Try per-tile artwork for unlocked traversable tiles.
    let drewArtwork = false;
    if (isUnlocked && tile.isTraversable) {
      drewArtwork = this.tryDrawTileArtwork(tile, sx, sy, z, corners);
    }

    if (!drewArtwork) {
      c.fillStyle = fillColor;
      c.fill();
    }

    // Outline.
    c.strokeStyle = isUnlocked ? 'rgba(26,26,46,0.5)' : 'rgba(10,10,30,0.3)';
    c.lineWidth = Math.max(1, 2 * z);
    c.stroke();

    c.restore();

    // Icon (drawn on top of tile fill — fall-back when no artwork).
    if (!drewArtwork) {
      this.drawTileIcon(tile, sx, sy, z, isNonTraversable, isZoneUnlocked, isUnlocked);
    }
  }

  /** Try to draw per-tile or per-type artwork. Returns true if drawn. */
  private tryDrawTileArtwork(
    tile: HexTile, sx: number, sy: number, z: number,
    corners: { x: number; y: number }[],
  ): boolean {
    const offset = cubeToOffset(tile.coord);
    const def = this.worldTileDefs.get(`${offset.col},${offset.row}`);
    const tileId = def?.id ?? '';

    const candidates: { url: string; fallback: string | null }[] = [];
    if (tileId) {
      const real = artworkUrl('tile', tileId);
      const ph = placeholderUrl(tileId, { w: 128, h: 128 });
      candidates.push({ url: real, fallback: ph });
    }
    const typeReal = artworkUrl('tile-type', tile.type);
    candidates.push({ url: typeReal, fallback: null });

    let img: HTMLImageElement | null = null;
    for (const cand of candidates) {
      img = this.imageCache.get(cand.url, cand.fallback, () => { /* repaint on next RAF */ });
      if (img) break;
    }
    if (!img) return false;

    const c = this.ctx;
    c.save();
    c.clip();
    // Hex bounding box width = 2*size, height = sqrt(3)*size.
    const w = HEX_SIZE * 2 * z;
    const h = Math.sqrt(3) * HEX_SIZE * z;
    c.drawImage(img, sx - w / 2, sy - h / 2, w, h);
    c.restore();
    // Re-stroke handled by caller via the closed path stroking below tryDrawTileArtwork.
    // The caller used save+beginPath+closePath, so calling clip() consumed the path.
    // Rebuild the path for the outline stroke now.
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const cx = sx + corners[i].x * z;
      const cy = sy + corners[i].y * z;
      if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
    }
    c.closePath();
    return true;
  }

  private drawTileIcon(
    _tile: HexTile, _sx: number, _sy: number, _z: number,
    _isNonTraversable: boolean, _isZoneUnlocked: boolean, _isUnlocked: boolean,
  ): void {
    // Emoji glyphs are no longer used as tile icons. Tile artwork (when
    // present) is rendered via the per-tile <img> art layer; foggy and
    // un-art'd tiles fall back to the colored hex without a glyph overlay.
  }

  private drawZoneOverlay(corners: { x: number; y: number }[], ox: number, oy: number, z: number): void {
    if (!this.currentZone) return;
    const c = this.ctx;
    c.save();
    c.fillStyle = 'rgba(0,0,0,0.4)';
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      if (!tile.isTraversable) continue;
      if (tile.zone === this.currentZone) continue;
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      if (!this.inCanvasBounds(sx, sy, z)) continue;

      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const cx = sx + corners[i].x * z;
        const cy = sy + corners[i].y * z;
        if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
      }
      c.closePath();
      c.fill();
    }
    c.restore();
  }

  private drawZoneBorders(corners: { x: number; y: number }[], ox: number, oy: number, z: number): void {
    const c = this.ctx;
    const processed = new Set<string>();

    c.save();
    c.lineCap = 'round';

    // Outer glow pass.
    c.strokeStyle = 'rgba(255,170,0,0.3)';
    c.lineWidth = Math.max(2, 4 * z);
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const neighbors = getNeighbors(tile.coord);
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      if (!this.inCanvasBounds(sx, sy, z, 3)) continue;
      for (let dir = 0; dir < 6; dir++) {
        const nb = this.grid.getTile(neighbors[dir]);
        if (!nb || nb.zone === tile.zone) continue;
        const key = tile.key < nb.key ? `${tile.key}|${nb.key}` : `${nb.key}|${tile.key}`;
        if (processed.has(key)) continue;
        processed.add(key);
        const [ci0, ci1] = DIR_TO_EDGE[dir];
        c.beginPath();
        c.moveTo(sx + corners[ci0].x * z, sy + corners[ci0].y * z);
        c.lineTo(sx + corners[ci1].x * z, sy + corners[ci1].y * z);
        c.stroke();
      }
    }

    // Inner bright pass.
    processed.clear();
    c.strokeStyle = 'rgba(255,204,68,0.7)';
    c.lineWidth = Math.max(1.5, 2 * z);
    for (const tile of this.grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const neighbors = getNeighbors(tile.coord);
      const p = tile.pixelPosition;
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      if (!this.inCanvasBounds(sx, sy, z, 3)) continue;
      for (let dir = 0; dir < 6; dir++) {
        const nb = this.grid.getTile(neighbors[dir]);
        if (!nb || nb.zone === tile.zone) continue;
        const key = tile.key < nb.key ? `${tile.key}|${nb.key}` : `${nb.key}|${tile.key}`;
        if (processed.has(key)) continue;
        processed.add(key);
        const [ci0, ci1] = DIR_TO_EDGE[dir];
        c.beginPath();
        c.moveTo(sx + corners[ci0].x * z, sy + corners[ci0].y * z);
        c.lineTo(sx + corners[ci1].x * z, sy + corners[ci1].y * z);
        c.stroke();
      }
    }

    c.restore();
  }

  private drawPath(ox: number, oy: number, z: number): void {
    if (this.serverPath.length === 0) return;
    const c = this.ctx;
    const pathCorners = getHexCorners(HEX_SIZE * 0.3);

    c.save();
    c.fillStyle = 'rgba(255,255,0,0.4)';
    for (const step of this.serverPath) {
      const p = cubeToPixel(offsetToCube({ col: step.col, row: step.row }));
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      c.beginPath();
      for (let i = 0; i < 6; i++) {
        const cx = sx + pathCorners[i].x * z;
        const cy = sy + pathCorners[i].y * z;
        if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
      }
      c.closePath();
      c.fill();
    }

    const dest = this.serverPath[this.serverPath.length - 1];
    const dp = cubeToPixel(offsetToCube({ col: dest.col, row: dest.row }));
    c.fillStyle = 'rgba(0,255,0,0.6)';
    c.beginPath();
    c.arc(dp.x * z + ox, dp.y * z + oy, 8 * z, 0, Math.PI * 2);
    c.fill();
    c.restore();
  }

  private drawOtherPlayers(ox: number, oy: number, z: number): void {
    if (!this.currentZone) return;
    const c = this.ctx;

    // Group by tile (only same-zone, non-party-member players).
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

    for (const group of tileGroups.values()) {
      const p = cubeToPixel(offsetToCube({ col: group.col, row: group.row }));
      const sx = p.x * z + ox;
      const sy = p.y * z + oy;
      if (!this.inCanvasBounds(sx, sy, z)) continue;

      const isOwnTile = group.col === this.playerCol && group.row === this.playerRow;
      if (isOwnTile) {
        // Player's tile: small "+N" badge bottom-right since the party bubble
        // obscures other-player flags.
        const bx = sx + HEX_SIZE * 0.55 * z;
        const by = sy + HEX_SIZE * 0.55 * z;
        this.drawCountBadge(c, bx, by, `+${group.count}`, z);
      } else {
        // Render flag (one banner — color hashed from tile key, since we lack partyId).
        this.drawPartyFlag(c, sx, sy, z, `${group.col},${group.row}`);
        if (group.count > 1) {
          const bx = sx + HEX_SIZE * 0.55 * z;
          const by = sy + HEX_SIZE * 0.55 * z;
          this.drawCountBadge(c, bx, by, `×${group.count}`, z);
        }
      }
    }
  }

  private drawPartyFlag(c: CanvasRenderingContext2D, sx: number, sy: number, z: number, hashSeed: string): void {
    const hue = this.hashHue(hashSeed);
    const flagColor = `hsl(${hue}, 70%, 55%)`;
    const poleColor = '#3a2a1a';

    const poleH = 22 * z;
    const flagW = 14 * z;
    const flagH = 10 * z;
    const poleX = sx;
    const poleTopY = sy - HEX_SIZE * 0.45 * z;
    const poleBottomY = poleTopY + poleH;

    c.save();
    // Pole.
    c.strokeStyle = poleColor;
    c.lineWidth = Math.max(1, 1.5 * z);
    c.beginPath();
    c.moveTo(poleX, poleTopY);
    c.lineTo(poleX, poleBottomY);
    c.stroke();

    // Triangular flag.
    c.fillStyle = flagColor;
    c.strokeStyle = 'rgba(0,0,0,0.6)';
    c.lineWidth = Math.max(0.5, 1 * z);
    c.beginPath();
    c.moveTo(poleX, poleTopY);
    c.lineTo(poleX + flagW, poleTopY + flagH / 2);
    c.lineTo(poleX, poleTopY + flagH);
    c.closePath();
    c.fill();
    c.stroke();
    c.restore();
  }

  private drawCountBadge(c: CanvasRenderingContext2D, x: number, y: number, text: string, z: number): void {
    const fontSize = Math.max(8, 10 * z);
    c.save();
    c.font = `bold ${fontSize}px 'Press Start 2P', monospace`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    const metrics = c.measureText(text);
    const padX = 4 * z;
    const padY = 2 * z;
    const w = metrics.width + padX * 2;
    const h = fontSize + padY * 2;
    c.fillStyle = '#4a90d9';
    c.fillRect(x - w / 2, y - h / 2, w, h);
    c.fillStyle = '#ffffff';
    c.fillText(text, x, y);
    c.restore();
  }

  private drawHoverHighlight(corners: { x: number; y: number }[], ox: number, oy: number, z: number): void {
    if (this.hoverCol === null || this.hoverRow === null) return;
    const tile = this.grid.getTile(offsetToCube({ col: this.hoverCol, row: this.hoverRow }));
    if (!tile) return;
    const p = tile.pixelPosition;
    const sx = p.x * z + ox;
    const sy = p.y * z + oy;
    const c = this.ctx;
    c.save();
    c.strokeStyle = tile.isTraversable ? 'rgba(255,255,255,0.8)' : 'rgba(255,102,102,0.8)';
    c.lineWidth = Math.max(2, 3 * z);
    c.beginPath();
    for (let i = 0; i < 6; i++) {
      const cx = sx + corners[i].x * z;
      const cy = sy + corners[i].y * z;
      if (i === 0) c.moveTo(cx, cy); else c.lineTo(cx, cy);
    }
    c.closePath();
    c.stroke();
    c.restore();
  }

  private drawParty(ox: number, oy: number, z: number): void {
    if (!this.partyRendered) return;
    const now = performance.now();
    const px = this.getPartyPixel(now);
    const sx = px.x * z + ox;
    const sy = px.y * z + oy;

    let color: string;
    switch (this.currentBattleVisual) {
      case 'fighting': color = PARTY_COLOR_FIGHTING; break;
      case 'defeat': color = PARTY_COLOR_DEFEAT; break;
      default: color = PARTY_COLOR_DEFAULT;
    }

    // Idle pulse / fighting throb.
    const t = now / 1000;
    let scale = 1;
    if (this.currentBattleVisual === 'fighting') {
      scale = 1 + 0.2 * Math.abs(Math.sin(t * 6.5));
    } else {
      scale = 1 + 0.08 * Math.sin(t * 2.5);
    }

    const r = 15 * z * scale;
    const c = this.ctx;
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.5)';
    c.shadowBlur = 6 * z;
    c.fillStyle = color;
    c.beginPath();
    c.arc(sx, sy, r, 0, Math.PI * 2);
    c.fill();
    c.lineWidth = Math.max(2, 3 * z);
    c.strokeStyle = '#ffffff';
    c.shadowColor = 'transparent';
    c.stroke();
    c.restore();
  }

  // ─── Helpers ───────────────────────────────────────────────

  private inCanvasBounds(sx: number, sy: number, z: number, pad = 2): boolean {
    const margin = HEX_SIZE * z * pad;
    return sx > -margin && sx < this.canvas.width + margin && sy > -margin && sy < this.canvas.height + margin;
  }

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
    const img = new Image();
    const url = artworkUrl('parchment', 'overworld');
    const fallback = placeholderUrl('parchment', { w: 256, h: 256, bg: '3a2a1a', fg: '5a4a3a' });
    img.onload = () => {
      const pat = this.ctx.createPattern(img, 'repeat');
      if (pat) this.parchmentPattern = pat;
    };
    img.onerror = () => {
      if (img.src !== fallback) {
        img.src = fallback;
      }
      // If both fail, parchmentPattern stays null and we use the flat color.
    };
    img.src = url;
  }
}
