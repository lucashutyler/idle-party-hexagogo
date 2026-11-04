import * as THREE from 'three';
import {
  HexGrid,
  HexTile,
  HEX_SIZE,
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
import { classIconHtml } from '@idle-party-rpg/shared';
import type { WorldCache } from '../network/WorldCache';
import { artworkUrl, placeholderInitials, renderTrackedImg } from './assets';
import { COAST_OFFSET_Y, COAST_PAD, MapBaker, SEA_COLOR, createSeaFallbackCanvas } from './MapBaker';
import type { BakeRoom } from './MapBaker';
import { hexVariant, isLandmarkType, lodForZoom, outsideFollowFrame, pickZoneLabels, terrainMaterial, zoneLabelAnchors } from './mapTerrain';
import type { LabelObstacle, ZoneLabelAnchor } from './mapTerrain';
import { reducedMotion } from './motion';
import { escapeHtml } from './ItemIcon';
import { setHtml } from './render';
import { ROOM_ICONS, getRoomActions, questMarks, questPipClass } from './RoomActions';
import type { QuestMarks, RoomAction } from './RoomActions';
import { pendingVisitTargets, questMarkerKey } from './QuestTargets';

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
  playersHere: { username: string; className?: string; partyId?: string; dungeonName?: string }[];
  partyMemberUsernames: string[];
  dungeonId?: string;
}

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 2.5;
const ZOOM_STEPS = [0.4, 0.65, 1.0, 1.5, 2.5] as const;
const ZOOM_STORAGE_KEY = 'mapZoom2';
const PHONE_DEFAULT_ZOOM = 0.65;
const DESKTOP_DEFAULT_ZOOM = 1;
const PHONE_SHORT_SIDE_PX = 600;

const OVERDRAG_FACTOR = 0.25;
const SPRING_DURATION = 250;
const FOLLOW_TWEEN_MS = 300;
const ZOOM_TWEEN_MS = 140;
const DRAG_THRESHOLD = 5;

const BAKE_BUDGET_MS = 8;
const ART_PATCH_MS = 200;
/** Each upload is the whole terrain texture, so art waits for a lull in arrivals, up to the longest wait. */
const ART_UPLOAD_QUIET_MS = 1500;
const ART_UPLOAD_MAX_WAIT_MS = 5000;
const ART_UPLOAD_RETRY_MS = 300;
const MAX_DPR = 2;
const FALLBACK_MAX_TEXTURE = 8192;

const PARCHMENT_MIN_SIZE = 8000;
const PARCHMENT_TILE_PX = 256;
/** Share of the camera's motion the sea plane absorbs, so it reads as a deeper layer. */
const PARCHMENT_PARALLAX = 0.3;
const PARCHMENT_VIEW_MARGIN = 2500;

/** World units around the view that room art loads ahead of a pan. */
const ART_VIEW_MARGIN = HEX_SIZE * 2;

const LABEL_CLEAR_X_PX = 72;
const LABEL_CLEAR_Y_PX = 30;
const MAX_MARKER_ICONS = 3;
const MARKER_ICON_HALF_W = 9;
const MARKER_PAD_HALF_W = 6;
const MARKER_HALF_H = 11;
const MARKER_PIP_HALF = 6;
const MARKER_GROW_ZOOM = 0.75;
const MARKER_MAX_GROW = 1.8;
const TOOLTIP_MARGIN = 4;
const QUEST_TARGET_ICON = '📜';

interface TileOccupancy {
  col: number;
  row: number;
  count: number;
  inDungeon: boolean;
}

interface CameraAnim {
  startX: number;
  startY: number;
  startZoom: number;
  targetX: number;
  targetY: number;
  targetZoom: number;
  startTime: number;
  duration: number;
}

function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

/** How far the camera must move for a screen position to clear the edges of a span; centres it when it can't fit. */
function revealNudge(pos: number, span: number, margin: number): number {
  if (span < margin * 2) return pos - span / 2;
  if (pos + margin > span) return pos + margin - span;
  return pos < margin ? pos - margin : 0;
}

function hexOutlineSvg(strokeAttrs = ''): string {
  return `<svg viewBox="-40 -35 80 70" width="80" height="70" preserveAspectRatio="xMidYMid meet">
    <polygon points="40,0 20,34.64 -20,34.64 -40,0 -20,-34.64 20,-34.64" fill="none" stroke="currentColor" stroke-width="3"${strokeAttrs} />
  </svg>`;
}

export class ThreeWorldMap {
  private container: HTMLElement;
  private worldCache: WorldCache;

  private canvas: HTMLCanvasElement;
  private overlay: HTMLDivElement;
  private partyEl: HTMLDivElement;
  private partyInnerEl: HTMLDivElement;
  private hoverEl: HTMLDivElement;
  private selectedEl: HTMLDivElement;
  private pathEl: HTMLDivElement;
  private questTargetsEl: HTMLDivElement;
  private markersEl: HTMLDivElement;
  private flagsEl: HTMLDivElement;
  private labelsEl: HTMLDivElement;
  private tooltipEl: HTMLDivElement;
  private tooltipKey = '';

  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.OrthographicCamera;

  private parchmentMesh: THREE.Mesh | null = null;
  private parchmentMaterial: THREE.MeshBasicMaterial;
  private parchmentTexture: THREE.Texture | null = null;
  private parchmentSize = PARCHMENT_MIN_SIZE;
  private parchmentMapId: string | null = null;
  private seaIsFallback = false;

  private coastMesh: THREE.Mesh | null = null;
  private coastMaterial: THREE.MeshBasicMaterial;
  private coastTexture: THREE.CanvasTexture | null = null;
  private terrainMesh: THREE.Mesh | null = null;
  private terrainMaterial: THREE.MeshBasicMaterial;
  private terrainTexture: THREE.CanvasTexture | null = null;
  private terrainTextureSize = '';
  private fogMesh: THREE.Mesh | null = null;
  private fogMaterial: THREE.MeshBasicMaterial;
  private fogTexture: THREE.CanvasTexture | null = null;
  private fogTextureSize = '';
  private meshBoundsKey = '';

  private baker: MapBaker;
  private terrainDirty = true;
  private coastDirty = true;
  private fogDirty = true;
  private terrainReady = false;
  private bakeRafId: number | null = null;
  private paused = false;
  private sizedWidth = 0;
  private sizedHeight = 0;
  private artPatchTimer: ReturnType<typeof setTimeout> | null = null;
  private artUploadTimer: ReturnType<typeof setTimeout> | null = null;
  private artUploadDeadline: number | null = null;
  private artUploadPending = false;

  private grid: HexGrid = new HexGrid();
  private worldTileDefs = new Map<string, WorldTileDefinition>();

  /** World point at screen centre. Maps to camera.position (x, -y) and camera.zoom. */
  private camWorldX = 0;
  private camWorldY = 0;
  private zoom = 1;
  private zoomInitialized = false;
  private lod = '';
  private settledZoom = '';
  private camAnim: CameraAnim | null = null;
  private following = true;
  private onFollowChangeFn?: (following: boolean) => void;

  private playerCol = 0;
  private playerRow = 0;
  private currentZone = '';
  private partyMemberUsernames: string[] = [];
  private lastOtherPlayers: OtherPlayerState[] = [];
  /** Players outside the viewer's party, per "col,row" in the current zone. */
  private othersByTile = new Map<string, TileOccupancy>();
  private currentBattleVisual: BattleVisual = 'none';

  /** Room-action markers on explored rooms, keyed by "col,row". */
  private roomActions = new Map<string, RoomAction[]>();
  private questMarks: QuestMarks = questMarks();
  /** Quest names sending the party to each room, keyed by room GUID. */
  private questTargets = new Map<string, string[]>();
  /** The same, for rooms on the current map, keyed by "col,row". */
  private questTargetsByRoom = new Map<string, string[]>();
  private questMarkerKey = '';
  private markersDirty = true;
  private zoneAnchors: ZoneLabelAnchor[] = [];
  private markerSpots: { x: number; y: number; icons: number }[] = [];

  private partyRendered = false;
  private partyTargetCol = 0;
  private partyTargetRow = 0;
  private serverPath: { col: number; row: number }[] = [];

  private hoverCol: number | null = null;
  private hoverRow: number | null = null;
  private mousePixelX = 0;
  private mousePixelY = 0;

  private pointerActive = false;
  private isDragging = false;
  private dragStartClientX = 0;
  private dragStartClientY = 0;
  private dragStartCamX = 0;
  private dragStartCamY = 0;
  private dragDistance = 0;

  private pinchStartDistance = 0;
  private pinchStartZoom = 1;
  private pinchStartCenterX = 0;
  private pinchStartCenterY = 0;
  private pinchStartCamX = 0;
  private pinchStartCamY = 0;
  private isPinching = false;
  /** A touch sequence that ever had two fingers down must never end in a tap. */
  private pinchedThisTouch = false;
  private lastTouch: { x: number; y: number } | null = null;

  private sendMoveFn?: (col: number, row: number) => void;
  private onTileClickFn?: (info: TileClickInfo) => void;
  private onBackgroundClickFn?: (blocked: boolean) => void;

  private destroyed = false;
  private isFirstState = true;
  private resizeObserver?: ResizeObserver;
  private resizeHandler: () => void;
  private windowMouseMove: (e: MouseEvent) => void;
  private windowMouseUp: (e: MouseEvent) => void;

  private renderQueued = false;
  private animRafId: number | null = null;

  constructor(container: HTMLElement, worldCache: WorldCache) {
    this.container = container;
    this.worldCache = worldCache;

    this.canvas = document.createElement('canvas');
    this.canvas.className = 'three-world-map';
    this.container.appendChild(this.canvas);

    this.overlay = document.createElement('div');
    this.overlay.className = 'three-map-overlay';
    this.container.appendChild(this.overlay);

    this.hoverEl = this.addOverlayLayer('three-map-hover');
    this.hoverEl.innerHTML = hexOutlineSvg();
    this.hoverEl.style.display = 'none';

    this.selectedEl = this.addOverlayLayer('three-map-selected');
    this.selectedEl.innerHTML = hexOutlineSvg();
    this.selectedEl.style.display = 'none';

    this.pathEl = this.addOverlayLayer('three-map-path');
    this.questTargetsEl = this.addOverlayLayer('three-map-quest-targets');
    this.labelsEl = this.addOverlayLayer('three-map-zone-labels');
    this.markersEl = this.addOverlayLayer('three-map-markers');
    this.flagsEl = this.addOverlayLayer('three-map-flags');

    this.partyEl = this.addOverlayLayer('three-map-party');
    this.partyInnerEl = document.createElement('div');
    this.partyInnerEl.className = 'three-map-party-inner';
    this.partyEl.appendChild(this.partyInnerEl);
    this.partyEl.style.display = 'none';

    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'canvas-map-tooltip';
    this.tooltipEl.style.display = 'none';
    this.container.appendChild(this.tooltipEl);

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: false,
      alpha: false,
      depth: false,
      stencil: false,
    });
    this.renderer.setClearColor(new THREE.Color(SEA_COLOR), 1);
    this.renderer.setPixelRatio(Math.min(MAX_DPR, window.devicePixelRatio || 1));

    this.scene = new THREE.Scene();
    // The frustum spans CSS pixels, so screen math matches the DOM overlay 1:1.
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 1000);
    this.camera.position.z = 100;

    this.parchmentMaterial = new THREE.MeshBasicMaterial({
      color: new THREE.Color(SEA_COLOR),
      depthWrite: false,
      transparent: false,
    });
    this.coastMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      depthWrite: false,
    });
    this.terrainMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });
    this.fogMaterial = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, depthWrite: false });

    this.baker = new MapBaker(() => this.scheduleArtPatch());
    this.grid = this.buildGridFromCache(true);
    this.loadParchment(this.worldCache.getCurrentMapId());

    this.windowMouseMove = (e) => {
      if (this.pointerActive) this.onPointerMove(e.clientX, e.clientY);
    };
    this.windowMouseUp = (e) => {
      if (!this.pointerActive) return;
      this.pointerActive = false;
      this.onPointerUp(e.clientX, e.clientY);
    };
    this.attachInput();

    this.canvas.addEventListener('webglcontextrestored', () => {
      this.coastDirty = true;
      this.requestRender();
    });

    this.resizeHandler = () => this.handleResize();
    window.addEventListener('resize', this.resizeHandler);
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => this.handleResize());
      this.resizeObserver.observe(this.container);
    }
    this.handleResize();
  }


  setSendMove(fn: (col: number, row: number) => void): void {
    this.sendMoveFn = fn;
  }

  setOnTileClick(fn: (info: TileClickInfo) => void): void {
    this.onTileClickFn = fn;
  }

  /** Taps on the sea or on nothing at all, and on a room that can't be walked into (`blocked`). */
  setOnBackgroundClick(fn: (blocked: boolean) => void): void {
    this.onBackgroundClickFn = fn;
  }

  /** Told whenever the camera starts or stops following the party. */
  setOnFollowChange(fn: (following: boolean) => void): void {
    this.onFollowChangeFn = fn;
    fn(this.following);
  }

  /** The room outlined as selected; null clears it. */
  setSelectedRoom(room: { col: number; row: number } | null): void {
    if (!room) {
      this.selectedEl.style.display = 'none';
      return;
    }
    const p = cubeToPixel(offsetToCube(room));
    this.selectedEl.style.display = '';
    this.selectedEl.style.left = `${p.x}px`;
    this.selectedEl.style.top = `${p.y}px`;
  }

  /** Moves the view by screen pixels, for keyboard panning. */
  panBy(dx: number, dy: number): void {
    this.setFollowing(false);
    this.camAnim = null;
    this.camWorldX += dx / this.zoom;
    this.camWorldY += dy / this.zoom;
    this.clampCamWithOverdrag();
    this.springBackIfNeeded();
    this.requestRender();
  }

  adjustZoom(delta: number): void {
    const target = this.nextZoomStep(this.camAnim?.targetZoom ?? this.zoom, delta > 0 ? 1 : -1);
    this.zoomAt(target, this.canvasCssWidth() / 2, this.canvasCssHeight() / 2);
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
    // A map switch never tweens: the two grids are unrelated.
    const mapChanged = this.worldCache.setCurrentMap(state.currentMapId);
    const firstState = this.isFirstState;
    const shouldSnap = !!snap || firstState || mapChanged;
    if (mapChanged) {
      this.loadParchment(state.currentMapId);
      this.grid = this.buildGridFromCache(true);
    }

    const unlockedChanged = this.worldCache.updateUnlocked(state.unlocked);
    if (unlockedChanged) {
      this.fogDirty = true;
      this.markersDirty = true;
      if (this.terrainReady) this.requestViewArt();
    }

    const partyMoved = this.applyPartyState(state.party, shouldSnap);
    this.currentBattleVisual = state.battle.visual;
    this.partyEl.dataset.dungeon = state.dungeon ? '1' : '0';
    this.updatePartyToken(state);

    this.playerCol = state.party.col;
    this.playerRow = state.party.row;
    const myTile = this.grid.getTile(offsetToCube({ col: state.party.col, row: state.party.row }));
    const prevZone = this.currentZone;
    this.currentZone = myTile?.zone ?? '';
    const zoneChanged = this.currentZone !== prevZone;
    if (zoneChanged) this.fogDirty = true;

    this.partyMemberUsernames = (state.social?.party?.members ?? []).map(m => m.username);
    this.lastOtherPlayers = state.otherPlayers.filter(p => !p.mapId || p.mapId === state.currentMapId);
    this.othersByTile = this.groupOtherPlayers();
    this.serverPath = state.party.path ?? [];

    const marks = questMarks(state);
    const targets = pendingVisitTargets(state.activeQuests, state.questDefinitions);
    const markerKey = questMarkerKey(marks, targets);
    if (markerKey !== this.questMarkerKey) {
      this.questMarkerKey = markerKey;
      this.questMarks = marks;
      this.questTargets = targets;
      this.markersDirty = true;
    }

    const viewChanged = firstState || mapChanged;
    if (viewChanged) this.setFollowing(true);
    if (viewChanged || (shouldSnap && this.following)) {
      this.centerOnParty();
    } else if (partyMoved && this.following) {
      this.followParty();
    }

    this.isFirstState = false;

    this.updatePartyOverlay();
    this.updatePathOverlay();
    const markersRebuilt = this.markersDirty;
    if (markersRebuilt) this.updateMarkersOverlay();
    if (markersRebuilt || zoneChanged || partyMoved) this.refreshZoneLabels();
    this.updateFlagsOverlay();
    this.updateBattleVisualClass();
    if (this.tooltipEl.style.display !== 'none') this.updateHover();
    if (this.fogDirty || viewChanged || this.terrainDirty) this.requestRender();
  }

  rebuildFromCache(): void {
    this.baker.forgetFailedArt();
    this.grid = this.buildGridFromCache(false);
    this.refreshZoneLabels();
    this.requestRender();
  }

  /** What a click on this room would report; null for rooms that can't be entered. */
  getTileInfo(col: number, row: number): TileClickInfo | null {
    const tile = this.grid.getTile(offsetToCube({ col, row }));
    if (!tile?.isTraversable) return null;

    const def = this.worldTileDefs.get(`${col},${row}`);
    const isUnlocked = this.worldCache.isUnlocked(col, row);
    const isSameZone = tile.zone === this.currentZone;
    const playersHere = isSameZone
      ? this.lastOtherPlayers
        .filter(p => p.col === col && p.row === row)
        .map(p => ({ username: p.username, className: p.className, partyId: p.partyId, dungeonName: p.dungeonName }))
      : [];

    return {
      col,
      row,
      tileType: this.worldCache.getTileTypeDef(tile.type)?.name ?? tile.type,
      zoneName: def?.zoneName ?? def?.zone ?? tile.zone,
      roomName: isUnlocked ? def?.name ?? '' : 'Unexplored Room',
      zoneId: tile.zone,
      isTraversable: tile.isTraversable,
      isUnlocked,
      isSameZone,
      isCurrentTile: col === this.playerCol && row === this.playerRow,
      playersHere,
      partyMemberUsernames: this.partyMemberUsernames,
      dungeonId: def?.dungeonId,
    };
  }

  /** Players outside the viewer's party in this room, by the same rules as the map flags. */
  countOthersAt(col: number, row: number): number {
    return this.othersByTile.get(`${col},${row}`)?.count ?? 0;
  }

  destroy(): void {
    this.destroyed = true;
    this.cancelFrames();
    if (this.artPatchTimer !== null) clearTimeout(this.artPatchTimer);
    if (this.artUploadTimer !== null) clearTimeout(this.artUploadTimer);

    window.removeEventListener('resize', this.resizeHandler);
    window.removeEventListener('mousemove', this.windowMouseMove);
    window.removeEventListener('mouseup', this.windowMouseUp);
    this.resizeObserver?.disconnect();

    this.terrainTexture?.dispose();
    this.coastTexture?.dispose();
    this.fogTexture?.dispose();
    this.parchmentTexture?.dispose();
    this.terrainMaterial.dispose();
    this.coastMaterial.dispose();
    this.fogMaterial.dispose();
    this.parchmentMaterial.dispose();
    this.renderer.dispose();

    this.canvas.remove();
    this.overlay.remove();
    this.tooltipEl.remove();
  }

  pause(): void {
    this.paused = true;
    this.cancelFrames();
    this.finishCameraAnim();
  }

  resume(): void {
    if (this.destroyed) return;
    this.paused = false;
    this.handleResize();
    if (this.baker.isBaking) this.scheduleBakeSlice();
    if (this.baker.hasPendingArt) this.scheduleArtPatch();
    if (this.artUploadPending) this.queueTerrainUpload();
    this.requestRender();
  }

  recenterOnPlayer(): void {
    this.setFollowing(true);
    if (!this.partyRendered) return;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.animateCamera(px.x, px.y, this.zoom, FOLLOW_TWEEN_MS);
  }

  /** Pans to a room and leaves the camera there, even if the party walks on. */
  focusOn(col: number, row: number): void {
    this.setFollowing(false);
    const px = cubeToPixel(offsetToCube({ col, row }));
    this.animateCamera(px.x, px.y, this.zoom, FOLLOW_TWEEN_MS);
  }

  /** Nudges the camera just enough that a room clears the panel docked at the right or bottom. */
  revealRoom(col: number, row: number, insets: { right: number; bottom: number }): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    if (cw <= 0 || ch <= 0) return;
    const p = cubeToPixel(offsetToCube({ col, row }));
    const margin = HEX_SIZE * this.zoom + 8;
    const sx = cw / 2 + (p.x - this.camWorldX) * this.zoom;
    const sy = ch / 2 + (p.y - this.camWorldY) * this.zoom;
    const dx = revealNudge(sx, cw - insets.right, margin);
    const dy = revealNudge(sy, ch - insets.bottom, margin);
    if (dx === 0 && dy === 0) return;
    this.animateCamera(this.camWorldX + dx / this.zoom, this.camWorldY + dy / this.zoom, this.zoom, SPRING_DURATION);
  }


  private buildGridFromCache(mapChanged: boolean): HexGrid {
    const grid = new HexGrid();
    this.worldTileDefs.clear();

    for (const tileDef of this.worldCache.getTiles()) {
      const coord = offsetToCube({ col: tileDef.col, row: tileDef.row });
      const tileTypeDef = this.worldCache.getTileTypeDef(tileDef.type);
      const tile = new HexTile(coord, tileDef.type, tileDef.zone, tileDef.id, tileDef.requiredItemId, tileTypeDef, tileDef.entryRequirements);
      grid.addTile(tile);
      this.worldTileDefs.set(`${tileDef.col},${tileDef.row}`, tileDef);
    }

    const { rooms, landmarks } = this.buildBakeRooms(grid);
    this.baker.setRooms(rooms, landmarks, room => this.worldCache.isUnlocked(room.col, room.row), mapChanged);
    if (mapChanged) this.terrainReady = false;
    this.terrainDirty = true;
    this.coastDirty = true;
    this.fogDirty = true;
    this.markersDirty = true;

    return grid;
  }

  private buildBakeRooms(grid: HexGrid): { rooms: BakeRoom[]; landmarks: Set<string> } {
    const byTile = new Map<HexTile, BakeRoom>();
    const typeCounts = new Map<string, number>();
    for (const tile of grid.getAllTiles()) {
      if (tile.type === 'void') continue;
      const { col, row } = cubeToOffset(tile.coord);
      const { x, y } = tile.pixelPosition;
      const color = tile.color;
      byTile.set(tile, {
        index: byTile.size,
        col, row, x, y,
        type: tile.type,
        zone: tile.zone,
        guid: this.worldTileDefs.get(`${col},${row}`)?.id ?? '',
        color,
        traversable: tile.isTraversable,
        material: terrainMaterial(color, tile.isTraversable),
        icon: this.worldCache.getTileTypeDef(tile.type)?.icon ?? '',
        variant: hexVariant(col, row),
        neighbors: [],
      });
      typeCounts.set(tile.type, (typeCounts.get(tile.type) ?? 0) + 1);
    }
    for (const [tile, room] of byTile) {
      room.neighbors = getNeighbors(tile.coord).map(coord => {
        const nb = grid.getTile(coord);
        return nb ? byTile.get(nb) ?? null : null;
      });
    }
    const landmarks = new Set<string>();
    for (const [type, count] of typeCounts) {
      if (isLandmarkType(count, byTile.size)) landmarks.add(type);
    }
    return { rooms: [...byTile.values()], landmarks };
  }


  private centerOnParty(): void {
    if (!this.partyRendered) return;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.camWorldX = px.x;
    this.camWorldY = px.y;
    this.camAnim = null;
    this.endGesture();
    this.requestRender();
  }

  private partyLeftFollowFrame(): boolean {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    if (cw <= 0 || ch <= 0 || !this.partyRendered) return false;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    const sx = cw / 2 + (px.x - this.camWorldX) * this.zoom;
    const sy = ch / 2 + (px.y - this.camWorldY) * this.zoom;
    return outsideFollowFrame(sx, sy, cw, ch);
  }

  /** One tween, and only when the party has left the inner frame. */
  private followParty(): void {
    if (!this.partyLeftFollowFrame()) return;
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.animateCamera(px.x, px.y, this.zoom, FOLLOW_TWEEN_MS);
  }

  private setFollowing(following: boolean): void {
    if (this.following === following) return;
    this.following = following;
    this.onFollowChangeFn?.(following);
  }

  private defaultZoom(): number {
    const shortSide = Math.min(window.innerWidth, window.innerHeight);
    return shortSide < PHONE_SHORT_SIDE_PX ? PHONE_DEFAULT_ZOOM : DESKTOP_DEFAULT_ZOOM;
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

  /** Camera limits that keep two rooms' width of map on screen, so the land can't be scrolled away. */
  private getCamBounds(): { minX: number; maxX: number; minY: number; maxY: number } {
    const b = this.getMapBounds();
    const z = this.zoom;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const halfW = cw / 2 / z;
    const halfH = ch / 2 / z;
    const tilePx = HEX_SIZE * 2;
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
      this.animateCamera(clampedX, clampedY, this.zoom, SPRING_DURATION);
    } else {
      this.camWorldX = clampedX;
      this.camWorldY = clampedY;
    }
  }

  private animateCamera(targetX: number, targetY: number, targetZoom: number, duration: number): void {
    if (this.destroyed) return;
    if (reducedMotion() || this.paused || this.canvasCssWidth() <= 0) {
      this.camWorldX = targetX;
      this.camWorldY = targetY;
      this.zoom = targetZoom;
      this.camAnim = null;
      this.endGesture();
      this.settleZoom();
      this.requestRender();
      return;
    }
    this.beginGesture();
    this.camAnim = {
      startX: this.camWorldX,
      startY: this.camWorldY,
      startZoom: this.zoom,
      targetX,
      targetY,
      targetZoom,
      startTime: performance.now(),
      duration,
    };
    this.ensureAnimLoop();
  }

  /** Holds the camera where it was last drawn, so that a press hits what the player is looking at. */
  private stopCameraAnim(): void {
    if (!this.camAnim) return;
    if (this.camAnim.startZoom !== this.camAnim.targetZoom) this.persistZoom(this.zoom);
    this.camAnim = null;
    this.endGesture();
    this.settleZoom();
    this.requestRender();
  }

  private finishCameraAnim(): void {
    if (!this.camAnim) return;
    this.camWorldX = this.camAnim.targetX;
    this.camWorldY = this.camAnim.targetY;
    this.zoom = this.camAnim.targetZoom;
    this.camAnim = null;
    this.endGesture();
    this.settleZoom();
  }

  private zoomAt(newZoom: number, screenCssX: number, screenCssY: number): void {
    const z = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, newZoom));
    if (z === (this.camAnim?.targetZoom ?? this.zoom)) return;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    const worldX = this.camWorldX + (screenCssX - cw / 2) / this.zoom;
    const worldY = this.camWorldY + (screenCssY - ch / 2) / this.zoom;
    const targetX = worldX - (screenCssX - cw / 2) / z;
    const targetY = worldY - (screenCssY - ch / 2) / z;
    this.persistZoom(z);
    this.animateCamera(targetX, targetY, z, ZOOM_TWEEN_MS);
  }

  private persistZoom(zoom: number): void {
    try { localStorage.setItem(ZOOM_STORAGE_KEY, String(zoom)); } catch { /* ignore */ }
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
    if (w === this.sizedWidth && h === this.sizedHeight) return;
    const firstSize = this.sizedWidth === 0;
    this.sizedWidth = w;
    this.sizedHeight = h;

    this.renderer.setSize(w, h, false);
    this.camera.left = -w / 2;
    this.camera.right = w / 2;
    this.camera.top = h / 2;
    this.camera.bottom = -h / 2;
    this.camera.updateProjectionMatrix();

    if (!this.zoomInitialized) {
      this.zoomInitialized = true;
      this.zoom = this.loadPersistedZoom() ?? this.defaultZoom();
      this.settleZoom();
    }

    if (this.terrainReady || this.baker.isBaking) this.requestViewArt();
    // setSize cleared the canvas: a deferred draw would paint one empty frame first.
    if (firstSize || this.paused) this.requestRender();
    else this.render();
  }


  private attachInput(): void {
    this.canvas.addEventListener('mousedown', e => {
      this.pointerActive = true;
      this.onPointerDown(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mousemove', e => {
      if (!this.pointerActive) this.onPointerMove(e.clientX, e.clientY);
    });
    this.canvas.addEventListener('mouseleave', () => {
      this.hoverCol = null;
      this.hoverRow = null;
      this.hideTooltip();
      this.updateHoverOverlay();
    });
    window.addEventListener('mousemove', this.windowMouseMove);
    window.addEventListener('mouseup', this.windowMouseUp);

    this.canvas.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      const cx = e.clientX - rect.left;
      const cy = e.clientY - rect.top;
      const target = this.nextZoomStep(this.camAnim?.targetZoom ?? this.zoom, e.deltaY > 0 ? -1 : 1);
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
        this.endTouch(true);
      } else if (e.touches.length === 1 && this.isPinching) {
        this.endPinch();
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

    this.canvas.addEventListener('touchcancel', () => this.endTouch(false));
  }

  private endTouch(allowTap: boolean): void {
    if (this.isPinching) this.endPinch();
    if (this.lastTouch) {
      if (allowTap && !this.pinchedThisTouch) {
        this.onPointerUp(this.lastTouch.x, this.lastTouch.y);
      } else {
        this.isDragging = false;
        this.endGesture();
        this.springBackIfNeeded();
      }
    }
    this.lastTouch = null;
    this.pinchedThisTouch = false;
  }

  private endPinch(): void {
    this.isPinching = false;
    this.persistZoom(this.zoom);
    this.endGesture();
    this.settleZoom();
    if (this.following && this.partyLeftFollowFrame()) this.setFollowing(false);
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
    this.pinchedThisTouch = true;
    this.isDragging = false;
    this.camAnim = null;
    this.beginGesture();
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
    this.requestRender();
  }

  private onPointerDown(clientX: number, clientY: number): void {
    this.stopCameraAnim();
    this.isDragging = true;
    this.dragStartClientX = clientX;
    this.dragStartClientY = clientY;
    this.dragStartCamX = this.camWorldX;
    this.dragStartCamY = this.camWorldY;
    this.dragDistance = 0;
  }

  private onPointerMove(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    this.mousePixelX = clientX - rect.left;
    this.mousePixelY = clientY - rect.top;

    if (this.isDragging) {
      const dxClient = clientX - this.dragStartClientX;
      const dyClient = clientY - this.dragStartClientY;
      this.dragDistance = Math.max(this.dragDistance, Math.abs(dxClient) + Math.abs(dyClient));
      if (this.dragDistance > DRAG_THRESHOLD) {
        this.setFollowing(false);
        this.beginGesture();
      }
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
    this.endGesture();
    this.springBackIfNeeded();

    if (!wasDragging) {
      this.handleClick(clientX, clientY);
    }
  }

  private beginGesture(): void {
    if (this.overlay.style.willChange !== 'transform') this.overlay.style.willChange = 'transform';
  }

  /** Lets the browser re-rasterize overlay text at the settled zoom, so it isn't left blurry. */
  private endGesture(): void {
    if (this.camAnim || this.isPinching) return;
    if (this.overlay.style.willChange) this.overlay.style.willChange = '';
    if (!this.isDragging && (this.terrainReady || this.baker.isBaking)) this.requestViewArt();
  }

  private requestViewArt(): void {
    this.baker.requestArt({
      x: this.camWorldX,
      y: this.camWorldY,
      halfW: this.canvasCssWidth() / 2 / this.zoom + ART_VIEW_MARGIN,
      halfH: this.canvasCssHeight() / 2 / this.zoom + ART_VIEW_MARGIN,
    });
  }

  private get gestureActive(): boolean {
    return this.isPinching || this.camAnim !== null || (this.isDragging && this.dragDistance > DRAG_THRESHOLD);
  }

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
    const lines = this.tooltipLines(tile);
    const key = lines.join('\n');
    if (key !== this.tooltipKey) {
      this.tooltipKey = key;
      this.tooltipEl.replaceChildren(...lines.map((text, i) => {
        const line = document.createElement('div');
        if (i === 0) line.className = 'canvas-map-tooltip-title';
        line.textContent = text;
        return line;
      }));
    }
    this.tooltipEl.style.display = 'block';
    this.positionTooltip();
  }

  /** Room name, then what the room offers and how many others stand there — counts only, never names. */
  private tooltipLines(tile: HexTile): string[] {
    const off = cubeToOffset(tile.coord);
    const key = `${off.col},${off.row}`;
    const def = this.worldTileDefs.get(key);
    const zoneName = def?.zoneName ?? def?.zone ?? tile.zone;
    if (!this.worldCache.isUnlocked(off.col, off.row)) return [`${zoneName}: Unexplored Room`];

    const questLines = (this.questTargetsByRoom.get(key) ?? []).map(name => `${QUEST_TARGET_ICON} ${name}`);
    const lines = [`${zoneName}: ${def?.name || 'Unexplored Room'}`];
    for (const action of this.roomActions.get(key) ?? []) {
      lines.push(`${action.icon} ${action.name}${action.detail ? ` · ${action.detail}` : ''}`);
    }
    lines.push(...questLines);
    const others = this.countOthersAt(off.col, off.row);
    if (others > 0) lines.push(`${ROOM_ICONS.players} ${others} ${others === 1 ? 'player' : 'players'} here`);
    return lines;
  }

  private positionTooltip(): void {
    const w = this.tooltipEl.offsetWidth;
    const h = this.tooltipEl.offsetHeight;
    const right = this.mousePixelX + 12;
    const left = right + w + TOOLTIP_MARGIN > this.canvasCssWidth() ? this.mousePixelX - 12 - w : right;
    const above = this.mousePixelY - 8 - h;
    const top = above < TOOLTIP_MARGIN ? this.mousePixelY + 20 : above;
    const maxTop = this.canvasCssHeight() - h - TOOLTIP_MARGIN;
    this.tooltipEl.style.left = `${Math.max(TOOLTIP_MARGIN, left)}px`;
    this.tooltipEl.style.top = `${Math.max(TOOLTIP_MARGIN, Math.min(top, maxTop))}px`;
  }

  private hideTooltip(): void {
    this.tooltipEl.style.display = 'none';
  }

  private handleClick(clientX: number, clientY: number): void {
    const rect = this.canvas.getBoundingClientRect();
    const tile = this.getTileAtScreenPx(clientX - rect.left, clientY - rect.top);
    const offset = tile ? cubeToOffset(tile.coord) : null;
    const info = offset ? this.getTileInfo(offset.col, offset.row) : null;
    if (!offset || !info) {
      this.onBackgroundClickFn?.(!!tile && tile.type !== 'void');
      return;
    }

    if (this.onTileClickFn) {
      this.onTileClickFn(info);
    } else {
      this.sendMoveFn?.(offset.col, offset.row);
    }
  }

  /** Returns whether the party changed rooms. */
  private applyPartyState(party: ServerPartyState, snap: boolean): boolean {
    if (!this.partyRendered) {
      this.partyTargetCol = party.col;
      this.partyTargetRow = party.row;
      this.partyRendered = true;
      this.partyEl.dataset.snap = '1';
      return true;
    }
    const posChanged = party.col !== this.partyTargetCol || party.row !== this.partyTargetRow;
    if (snap) this.partyEl.dataset.snap = '1';
    if (!posChanged) return false;
    this.partyTargetCol = party.col;
    this.partyTargetRow = party.row;
    if (!snap) this.partyEl.dataset.snap = '0';
    return true;
  }

  private updatePartyToken(state: ServerStateMessage): void {
    const className = state.character?.className;
    const face = className
      ? `<span class="three-map-party-icon">${classIconHtml(className)}</span>`
        + renderTrackedImg(artworkUrl('class', className), { className: 'three-map-party-art', alt: '' })
      : `<span class="three-map-party-initials">${escapeHtml(placeholderInitials(state.username ?? ''))}</span>`;
    setHtml(this.partyInnerEl, `<span class="three-map-party-face">${face}</span>`);
  }


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

  private ensureAnimLoop(): void {
    if (this.destroyed || this.animRafId !== null) return;
    const tick = () => {
      this.animRafId = null;
      if (this.destroyed || !this.camAnim) return;
      const anim = this.camAnim;
      const t = Math.min(1, (performance.now() - anim.startTime) / anim.duration);
      const e = easeOutCubic(t);
      this.camWorldX = anim.startX + (anim.targetX - anim.startX) * e;
      this.camWorldY = anim.startY + (anim.targetY - anim.startY) * e;
      this.zoom = anim.startZoom + (anim.targetZoom - anim.startZoom) * e;
      if (t >= 1) {
        this.camAnim = null;
        this.endGesture();
        this.settleZoom();
        if (this.following && this.partyLeftFollowFrame()) this.setFollowing(false);
      }
      this.render();
      if (t < 1) this.animRafId = requestAnimationFrame(tick);
    };
    this.animRafId = requestAnimationFrame(tick);
  }

  private cancelFrames(): void {
    if (this.animRafId !== null) cancelAnimationFrame(this.animRafId);
    this.animRafId = null;
    if (this.bakeRafId !== null) cancelAnimationFrame(this.bakeRafId);
    this.bakeRafId = null;
  }

  private render(): void {
    if (this.destroyed) return;
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    if (cw <= 0 || ch <= 0) return;

    if (this.terrainDirty) this.startTerrainBake();
    if (this.coastDirty) this.uploadCoast();
    if (this.fogDirty && this.terrainReady) this.uploadFog();
    this.updateParchmentMesh();

    this.camera.position.x = this.camWorldX;
    this.camera.position.y = -this.camWorldY;
    this.camera.zoom = this.zoom;
    this.camera.updateProjectionMatrix();

    if (this.parchmentMesh) {
      this.parchmentMesh.position.x = this.camWorldX * (1 - PARCHMENT_PARALLAX);
      this.parchmentMesh.position.y = -this.camWorldY * (1 - PARCHMENT_PARALLAX);
    }

    this.renderer.render(this.scene, this.camera);

    this.updateOverlayTransform();
    this.updateHoverOverlay();
  }

  private startTerrainBake(): void {
    this.terrainDirty = false;
    if (!this.terrainReady) {
      if (this.terrainMesh) this.terrainMesh.visible = false;
      if (this.fogMesh) this.fogMesh.visible = false;
    }
    const maxTexture = this.renderer.capabilities?.maxTextureSize ?? FALLBACK_MAX_TEXTURE;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    const begun = this.baker.beginTerrain(maxTexture, dpr);
    this.requestViewArt();
    if (!begun) {
      delete this.container.dataset.charting;
      return;
    }
    if (!this.terrainReady) this.container.dataset.charting = '1';
    this.scheduleBakeSlice();
  }

  private scheduleBakeSlice(): void {
    if (this.bakeRafId !== null || this.destroyed || this.paused) return;
    this.bakeRafId = requestAnimationFrame(() => {
      this.bakeRafId = null;
      if (!this.destroyed) this.runBakeSlice();
    });
  }

  private runBakeSlice(): void {
    if (this.baker.isBaking) {
      if (!this.baker.stepTerrain(BAKE_BUDGET_MS)) {
        this.scheduleBakeSlice();
        return;
      }
      this.uploadTerrain();
      this.terrainReady = true;
      this.fogDirty = true;
      delete this.container.dataset.charting;
      if (this.terrainMesh) this.terrainMesh.visible = true;
      this.requestRender();
      if (this.baker.hasPendingArt) this.scheduleArtPatch();
      return;
    }
    if (!this.baker.hasPendingArt) return;
    const done = this.baker.stepArt(BAKE_BUDGET_MS);
    this.queueTerrainUpload();
    if (!done) this.scheduleBakeSlice();
  }

  /** Paints arrived art into the retained canvas, never while the map is moving. Uploading it is a separate, rarer step. */
  private scheduleArtPatch(): void {
    if (this.artPatchTimer !== null || this.destroyed) return;
    this.artPatchTimer = setTimeout(() => {
      this.artPatchTimer = null;
      if (this.destroyed || this.paused || !this.baker.hasPendingArt) return;
      if (this.gestureActive || this.baker.isBaking || this.bakeRafId !== null) {
        this.scheduleArtPatch();
      } else if (this.baker.shouldRebakeForArt()) {
        this.terrainDirty = true;
        this.requestRender();
      } else {
        this.scheduleBakeSlice();
      }
    }, ART_PATCH_MS);
  }

  private queueTerrainUpload(): void {
    if (this.destroyed) return;
    this.artUploadPending = true;
    const now = performance.now();
    this.artUploadDeadline ??= now + ART_UPLOAD_MAX_WAIT_MS;
    if (this.artUploadTimer !== null) clearTimeout(this.artUploadTimer);
    this.artUploadTimer = setTimeout(() => this.flushTerrainUpload(), Math.max(0, Math.min(ART_UPLOAD_QUIET_MS, this.artUploadDeadline - now)));
  }

  private flushTerrainUpload(): void {
    this.artUploadTimer = null;
    if (this.destroyed || this.paused || !this.artUploadPending) return;
    if (this.gestureActive || this.baker.isBaking) {
      this.artUploadTimer = setTimeout(() => this.flushTerrainUpload(), ART_UPLOAD_RETRY_MS);
      return;
    }
    this.uploadTerrain();
    this.requestRender();
  }

  private syncLayerMeshes(): void {
    const b = this.baker.bounds;
    if (!b) return;
    const key = `${b.minX},${b.minY},${b.w},${b.h}`;
    if (key === this.meshBoundsKey && this.terrainMesh && this.fogMesh && this.coastMesh) return;
    this.meshBoundsKey = key;
    const cx = b.minX + b.w / 2;
    const cy = -(b.minY + b.h / 2);
    this.terrainMesh = this.replaceMesh(this.terrainMesh, this.terrainMaterial, b.w, b.h, cx, cy, 2);
    this.fogMesh = this.replaceMesh(this.fogMesh, this.fogMaterial, b.w, b.h, cx, cy, 3);
    this.coastMesh = this.replaceMesh(this.coastMesh, this.coastMaterial, b.w + COAST_PAD * 2, b.h + COAST_PAD * 2, cx, cy - COAST_OFFSET_Y, 1);
    this.fogMesh.visible = this.terrainReady;
    this.terrainMesh.visible = this.terrainReady;
  }

  private replaceMesh(
    existing: THREE.Mesh | null,
    material: THREE.MeshBasicMaterial,
    w: number, h: number, x: number, y: number, z: number,
  ): THREE.Mesh {
    if (existing) {
      this.scene.remove(existing);
      existing.geometry.dispose();
    }
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), material);
    mesh.position.set(x, y, z);
    this.scene.add(mesh);
    return mesh;
  }

  private canvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.magFilter = THREE.LinearFilter;
    return texture;
  }

  private uploadTerrain(): void {
    this.artUploadPending = false;
    this.artUploadDeadline = null;
    const canvas = this.baker.terrainCanvas;
    if (!canvas) return;
    this.syncLayerMeshes();
    const size = `${canvas.width}x${canvas.height}`;
    if (this.terrainTexture && size === this.terrainTextureSize) {
      this.terrainTexture.needsUpdate = true;
      return;
    }
    this.terrainTexture?.dispose();
    this.terrainTexture = this.canvasTexture(canvas);
    this.terrainTextureSize = size;
    this.terrainMaterial.map = this.terrainTexture;
    this.terrainMaterial.needsUpdate = true;
  }

  private uploadFog(): void {
    this.fogDirty = false;
    this.baker.bakeFog(this.currentZone, zone => this.worldCache.isZoneUnlocked(zone));
    const canvas = this.baker.fogCanvas;
    if (!canvas) return;
    this.syncLayerMeshes();
    const size = `${canvas.width}x${canvas.height}`;
    if (this.fogTexture && size === this.fogTextureSize) {
      this.fogTexture.needsUpdate = true;
    } else {
      this.fogTexture?.dispose();
      this.fogTexture = this.canvasTexture(canvas);
      this.fogTextureSize = size;
      this.fogMaterial.map = this.fogTexture;
      this.fogMaterial.needsUpdate = true;
    }
    if (this.fogMesh) this.fogMesh.visible = true;
  }

  private uploadCoast(): void {
    this.coastDirty = false;
    this.baker.bakeCoast(this.seaIsFallback);
    const canvas = this.baker.coastCanvas;
    if (!canvas || !this.baker.bounds) return;
    this.syncLayerMeshes();
    this.coastTexture?.dispose();
    this.coastTexture = this.canvasTexture(canvas);
    this.coastMaterial.map = this.coastTexture;
    this.coastMaterial.needsUpdate = true;
  }

  private updateParchmentMesh(): void {
    const b = this.baker.bounds;
    const reach = b ? Math.max(Math.abs(b.minX), Math.abs(b.minX + b.w), Math.abs(b.minY), Math.abs(b.minY + b.h)) : 0;
    const size = Math.max(PARCHMENT_MIN_SIZE, 2 * (reach * PARCHMENT_PARALLAX + PARCHMENT_VIEW_MARGIN));
    if (this.parchmentMesh && size === this.parchmentSize) return;
    this.parchmentSize = size;
    if (this.parchmentMesh) {
      this.scene.remove(this.parchmentMesh);
      this.parchmentMesh.geometry.dispose();
    }
    this.parchmentMesh = new THREE.Mesh(new THREE.PlaneGeometry(size, size), this.parchmentMaterial);
    this.parchmentMesh.position.set(0, 0, 0);
    this.scene.add(this.parchmentMesh);
    this.parchmentTexture?.repeat.set(size / PARCHMENT_TILE_PX, size / PARCHMENT_TILE_PX);
  }


  private addOverlayLayer(className: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = className;
    this.overlay.appendChild(el);
    return el;
  }

  /** The overlay mirrors the camera, so one style write moves every world-positioned child. */
  private updateOverlayTransform(): void {
    const cw = this.canvasCssWidth();
    const ch = this.canvasCssHeight();
    this.overlay.style.transform =
      `translate(${cw / 2}px, ${ch / 2}px) scale(${this.zoom}) translate(${-this.camWorldX}px, ${-this.camWorldY}px)`;
    this.partyInnerEl.style.setProperty('--party-scale', String(1 / this.zoom));
    const lod = lodForZoom(this.zoom);
    if (lod !== this.lod) {
      this.lod = lod;
      this.overlay.dataset.lod = lod;
    }
  }

  /** Inherited through the whole overlay, so written once a zoom settles rather than every frame. */
  private settleZoom(): void {
    const zoom = String(this.zoom);
    if (zoom === this.settledZoom) return;
    this.settledZoom = zoom;
    this.overlay.style.setProperty('--map-zoom', zoom);
    this.refreshZoneLabels();
  }

  /** Whether a label centred on this world point would run under the party token, at the current zoom. */
  private nearPartyToken(x: number, y: number): boolean {
    if (!this.partyRendered) return false;
    const party = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    return Math.abs(x - party.x) * this.zoom < LABEL_CLEAR_X_PX && Math.abs(y - party.y) * this.zoom < LABEL_CLEAR_Y_PX;
  }

  private refreshZoneLabels(): void {
    const explored = [];
    for (const room of this.baker.rooms) {
      if (!room.traversable || !this.worldCache.isUnlocked(room.col, room.row)) continue;
      const def = this.worldTileDefs.get(`${room.col},${room.row}`);
      const busy = this.roomActions.has(`${room.col},${room.row}`) || this.nearPartyToken(room.x, room.y);
      explored.push({ zone: room.zone, zoneName: def?.zoneName ?? def?.zone ?? room.zone, x: room.x, y: room.y, busy });
    }
    this.zoneAnchors = zoneLabelAnchors(explored);
    this.updateZoneLabels();
  }

  /** Where each room's markers draw, in world units: their CSS scales them up when zoomed far out. */
  private markerBoxes(): LabelObstacle[] {
    const far = lodForZoom(this.zoom) === 'far';
    const grow = Math.min(MARKER_MAX_GROW, Math.max(1, MARKER_GROW_ZOOM / this.zoom));
    return this.markerSpots.map(({ x, y, icons }) => ({
      x,
      y,
      halfW: (far ? MARKER_PIP_HALF : icons * MARKER_ICON_HALF_W + MARKER_PAD_HALF_W) * grow,
      halfH: (far ? MARKER_PIP_HALF : MARKER_HALF_H) * grow,
    }));
  }

  private updateZoneLabels(): void {
    const html = pickZoneLabels(this.zoneAnchors, this.zoom, this.currentZone, this.markerBoxes()).map(anchor => {
      const current = anchor.zone === this.currentZone ? ' data-current="1"' : '';
      return `<div class="three-map-zone-label"${current} style="left:${anchor.x}px;top:${anchor.y}px">${escapeHtml(anchor.name)}</div>`;
    });
    setHtml(this.labelsEl, html.join(''));
  }

  private updatePartyOverlay(): void {
    if (!this.partyRendered) {
      this.partyEl.style.display = 'none';
      return;
    }
    const px = cubeToPixel(offsetToCube({ col: this.partyTargetCol, row: this.partyTargetRow }));
    this.partyEl.style.display = '';
    this.partyEl.style.transform = `translate(${px.x}px, ${px.y}px)`;
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
    if (this.serverPath.length === 0) {
      setHtml(this.pathEl, '');
      return;
    }
    const points = [{ col: this.partyTargetCol, row: this.partyTargetRow }, ...this.serverPath]
      .map(step => cubeToPixel(offsetToCube(step)));
    const line = points.map(p => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
    const dest = points[points.length - 1];
    setHtml(this.pathEl,
      `<svg class="three-map-route" width="1" height="1" aria-hidden="true">`
      + `<polyline class="three-map-route-under" points="${line}"/><polyline class="three-map-route-line" points="${line}"/></svg>`
      + `<div class="three-map-path-dest" style="left:${dest.x}px;top:${dest.y}px">`
      + '<svg viewBox="0 0 24 32" width="24" height="32" aria-hidden="true">'
      + '<path d="M12 31C12 31 22 18.5 22 11A10 10 0 0 0 2 11C2 18.5 12 31 12 31Z" fill="#ffcb3d" stroke="#060918" stroke-width="2"/>'
      + '<circle cx="12" cy="11" r="3.6" fill="#060918"/></svg></div>');
  }

  private groupOtherPlayers(): Map<string, TileOccupancy> {
    const groups = new Map<string, TileOccupancy>();
    if (!this.currentZone) return groups;

    const partySet = new Set(this.partyMemberUsernames);
    for (const other of this.lastOtherPlayers) {
      if (other.zone !== this.currentZone) continue;
      if (partySet.has(other.username)) continue;
      const key = `${other.col},${other.row}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
        if (other.inDungeon) existing.inDungeon = true;
      } else {
        groups.set(key, { col: other.col, row: other.row, count: 1, inDungeon: !!other.inDungeon });
      }
    }
    return groups;
  }

  private updateFlagsOverlay(): void {
    const html: string[] = [];
    for (const [key, group] of this.othersByTile) {
      const p = cubeToPixel(offsetToCube({ col: group.col, row: group.row }));
      const isOwnTile = group.col === this.playerCol && group.row === this.playerRow;
      const badgePos = `left:${p.x + HEX_SIZE * 0.35}px;top:${p.y - HEX_SIZE * 0.5}px`;
      if (isOwnTile) {
        html.push(`<div class="three-map-badge" style="${badgePos}">+${group.count}</div>`);
      } else {
        const flagColor = `hsl(${this.hashHue(key)}, 70%, 55%)`;
        html.push(
          `<div class="three-map-flag" style="left:${p.x}px;top:${p.y - HEX_SIZE * 0.3}px">
            <svg viewBox="0 0 24 32" width="24" height="32">
              <line x1="12" y1="2" x2="12" y2="26" stroke="#3a2a1a" stroke-width="1.5" stroke-linecap="round"/>
              <polygon points="12,2 24,7 12,12" fill="${flagColor}" stroke="rgba(0,0,0,0.6)" stroke-width="1"/>
            </svg>
          </div>`,
        );
        if (group.count > 1) {
          html.push(`<div class="three-map-badge" style="${badgePos}">×${group.count}</div>`);
        }
      }
      if (group.inDungeon) {
        html.push(
          `<div class="three-map-dungeon-key" title="A party is in the dungeon" style="left:${p.x - HEX_SIZE * 0.5}px;top:${p.y - HEX_SIZE * 0.45}px">${ROOM_ICONS.dungeon}</div>`,
        );
      }
    }
    setHtml(this.flagsEl, html.join(''));
  }

  private updateMarkersOverlay(): void {
    this.markersDirty = false;
    this.roomActions.clear();
    this.markerSpots = [];
    const markers = document.createDocumentFragment();
    for (const [key, def] of this.worldTileDefs) {
      if (!this.worldCache.isUnlocked(def.col, def.row)) continue;
      const actions = getRoomActions(def, this.worldCache, this.questMarks);
      if (actions.length === 0) continue;
      this.roomActions.set(key, actions);
      markers.appendChild(this.buildMarker(def.col, def.row, actions));
    }
    this.markersEl.replaceChildren(markers);
    this.updateQuestTargetsOverlay();
  }

  /** Outlines every explored room on this map that an active quest still sends the party to. */
  private updateQuestTargetsOverlay(): void {
    this.questTargetsByRoom.clear();
    const outlines = document.createDocumentFragment();
    const mapId = this.worldCache.getCurrentMapId();
    for (const [tileId, questNames] of this.questTargets) {
      const def = this.worldCache.getTileByGuid(tileId);
      if (!def || def.mapId !== mapId || !this.worldCache.isUnlocked(def.col, def.row)) continue;
      this.questTargetsByRoom.set(`${def.col},${def.row}`, questNames);
      outlines.appendChild(this.buildQuestTarget(def.col, def.row));
    }
    this.questTargetsEl.replaceChildren(outlines);
  }

  private buildQuestTarget(col: number, row: number): HTMLElement {
    const p = cubeToPixel(offsetToCube({ col, row }));
    const el = document.createElement('div');
    el.className = 'three-map-quest-target';
    el.style.left = `${p.x}px`;
    el.style.top = `${p.y}px`;
    el.innerHTML = hexOutlineSvg(' stroke-dasharray="8 6"');
    return el;
  }

  private buildMarker(col: number, row: number, actions: RoomAction[]): HTMLElement {
    const p = cubeToPixel(offsetToCube({ col, row }));
    const marker = document.createElement('div');
    marker.className = 'three-map-marker';
    marker.style.left = `${p.x}px`;
    marker.style.top = `${p.y + HEX_SIZE * 0.55}px`;

    const firstExit = actions.find(a => a.kind === 'travel');
    const icons = [...actions.filter(a => a.kind !== 'travel'), ...(firstExit ? [firstExit] : [])];
    this.markerSpots.push({ x: p.x, y: p.y + HEX_SIZE * 0.55, icons: Math.min(icons.length, MAX_MARKER_ICONS + 1) });
    for (const action of icons.slice(0, MAX_MARKER_ICONS)) {
      const icon = document.createElement('span');
      icon.className = ['three-map-marker-icon', questPipClass(action)].filter(Boolean).join(' ');
      icon.textContent = action.icon;
      marker.appendChild(icon);
    }
    if (icons.length > MAX_MARKER_ICONS) {
      const more = document.createElement('span');
      more.className = 'three-map-marker-more';
      more.textContent = `+${icons.length - MAX_MARKER_ICONS}`;
      marker.appendChild(more);
    }
    return marker;
  }

  private hashHue(s: string): number {
    let h = 0;
    for (let i = 0; i < s.length; i++) {
      h = (h * 31 + s.charCodeAt(i)) >>> 0;
    }
    return h % 360;
  }

  /** Per-map sea art wins; a load superseded by another map switch is dropped. */
  private loadParchment(mapId: string): void {
    if (this.parchmentMapId === mapId) return;
    this.parchmentMapId = mapId;
    const loader = new THREE.TextureLoader();
    const url = artworkUrl('parchment', mapId);
    const onLoaded = (tex: THREE.Texture, isFallback: boolean) => {
      if (this.parchmentMapId !== mapId) { tex.dispose(); return; }
      this.seaIsFallback = isFallback;
      this.coastDirty = true;
      tex.wrapS = THREE.RepeatWrapping;
      tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.repeat.set(this.parchmentSize / PARCHMENT_TILE_PX, this.parchmentSize / PARCHMENT_TILE_PX);
      this.parchmentTexture?.dispose();
      this.parchmentTexture = tex;
      this.parchmentMaterial.map = tex;
      // A leftover base colour would tint the texture.
      this.parchmentMaterial.color.setHex(0xffffff);
      this.parchmentMaterial.needsUpdate = true;
      this.requestRender();
    };
    loader.load(
      url,
      tex => onLoaded(tex, false),
      undefined,
      () => onLoaded(new THREE.CanvasTexture(createSeaFallbackCanvas()), true),
    );
  }
}
