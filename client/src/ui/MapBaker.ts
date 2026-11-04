import { HEX_SIZE, getHexCorners } from '@idle-party-rpg/shared';
import { artworkUrl } from './assets';
import {
  bakeScale,
  colorToRgb,
  computeFogLevels,
  coverFit,
  fogAlpha,
  hslCss,
  rgbToHsl,
  variantLightness,
} from './mapTerrain';
import type { FogRoom, Hsl, TerrainMaterial } from './mapTerrain';

export const SEA_COLOR = '#0a1128';
const FOG_INK = '#060a1c';
const FOAM = 'rgba(244, 236, 214, 0.62)';
const ZONE_BORDER = 'rgba(248, 240, 220, 0.62)';
const ZONE_BORDER_UNDER = 'rgba(6, 10, 28, 0.28)';

const HEX_W = HEX_SIZE * 2;
const HEX_H = Math.sqrt(3) * HEX_SIZE;
const SPRITE_PAD = 2;
const PEAK_HEADROOM = 16;
const SKIRT = 7;
const WATER_SKIRT = 4;
const BAKE_MARGIN = HEX_SIZE + PEAK_HEADROOM;
const FOG_RESOLUTION = 0.25;
const COAST_RESOLUTION = 0.125;
export const COAST_OFFSET_Y = 14;
/** Room the shallows glow needs beyond the map's own bounds. */
export const COAST_PAD = 72;
const COAST_SHADOW = 'rgba(0, 0, 0, 0.5)';
const SHALLOWS_COLOR = 'rgba(70, 150, 196, 0.11)';
const SHALLOWS_WIDTHS = [96, 40] as const;
const EDGE_BATCH = 96;
/** Past this share of the map, a full re-bake is cheaper than patching rooms one by one. */
const REBAKE_SHARE = 0.3;
/** Most room images in memory at once, loading or waiting to be painted. */
const ROOM_ART_HELD_MAX = 12;
const SEA_TILE_PX = 256;

const CORNERS = getHexCorners(HEX_SIZE);
/** Corner pair for the edge facing each neighbour direction of `getNeighbors`. */
const DIR_TO_EDGE: readonly (readonly [number, number])[] = [[0, 1], [5, 0], [4, 5], [3, 4], [2, 3], [1, 2]];
const LOWER_DIRS = new Set([0, 4, 5]);
const DIR_TOP = 2;
const DIR_BOTTOM = 5;

export interface BakeRoom {
  index: number;
  col: number;
  row: number;
  x: number;
  y: number;
  type: string;
  zone: string;
  guid: string;
  color: number;
  traversable: boolean;
  material: TerrainMaterial;
  icon: string;
  variant: number;
  /** One entry per `getNeighbors` direction; null where the map has no room. */
  neighbors: (BakeRoom | null)[];
}

export interface BakeBounds { minX: number; minY: number; w: number; h: number }

interface Sprite { canvas: HTMLCanvasElement; ox: number; oy: number }

interface ArtEntry { img: HTMLImageElement | null; state: 'loading' | 'ready' | 'painted' | 'failed' }

/** The world area the camera shows, plus whatever margin art should load ahead of. */
export interface ArtView { x: number; y: number; halfW: number; halfH: number }

type Ctx = CanvasRenderingContext2D;

function newCanvas(w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.ceil(w));
  canvas.height = Math.max(1, Math.ceil(h));
  return canvas;
}

function traceHex(ctx: CanvasRenderingContext2D | Path2D, x: number, y: number, radius = HEX_SIZE): void {
  const k = radius / HEX_SIZE;
  for (let i = 0; i < 6; i++) {
    const cx = x + CORNERS[i].x * k;
    const cy = y + CORNERS[i].y * k;
    if (i === 0) ctx.moveTo(cx, cy);
    else ctx.lineTo(cx, cy);
  }
  ctx.closePath();
}

function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashText(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

function scatter(rand: () => number, count: number, reach: number): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let guard = count * 24;
  while (points.length < count && guard-- > 0) {
    const x = (rand() * 2 - 1) * reach;
    const y = (rand() * 2 - 1) * reach * 0.86;
    if (Math.abs(x) * 0.5 + Math.abs(y) * 0.866 > reach * 0.866) continue;
    points.push({ x, y });
  }
  return points;
}

function shift(base: Hsl, lightness: number, saturation = 1): string {
  return hslCss({ h: base.h, s: base.s * saturation, l: base.l * lightness });
}

function drawSpeckle(ctx: Ctx, rand: () => number, base: Hsl, count: number, reach: number): void {
  for (const p of scatter(rand, count, reach)) {
    ctx.fillStyle = rand() < 0.5 ? shift(base, 0.82) : shift(base, 1.14);
    const size = 0.8 + rand() * 1.2;
    ctx.fillRect(p.x, p.y, size, size);
  }
}

function stampWater(ctx: Ctx, rand: () => number, base: Hsl): void {
  ctx.lineCap = 'round';
  const crests = scatter(rand, 5, 30);
  for (const p of crests) {
    const w = 5 + rand() * 4;
    const wave = new Path2D();
    wave.moveTo(p.x - w, p.y);
    wave.quadraticCurveTo(p.x - w / 2, p.y - 3.2, p.x, p.y);
    wave.quadraticCurveTo(p.x + w / 2, p.y + 2.4, p.x + w, p.y - 0.6);
    ctx.translate(0, 1.4);
    ctx.strokeStyle = shift(base, 0.78);
    ctx.lineWidth = 1.5;
    ctx.stroke(wave);
    ctx.translate(0, -1.4);
    ctx.strokeStyle = shift(base, 1.42, 0.82);
    ctx.lineWidth = 1.3;
    ctx.stroke(wave);
  }
}

function drawCanopy(ctx: Ctx, base: Hsl, x: number, y: number, r: number): void {
  ctx.fillStyle = 'rgba(4, 12, 10, 0.3)';
  ctx.beginPath();
  ctx.ellipse(x + 1.2, y + r * 0.72, r * 1.05, r * 0.5, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shift(base, 0.68);
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shift(base, 1.06);
  ctx.beginPath();
  ctx.arc(x - r * 0.2, y - r * 0.24, r * 0.68, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shift(base, 1.42, 0.9);
  ctx.beginPath();
  ctx.arc(x - r * 0.36, y - r * 0.42, r * 0.28, 0, Math.PI * 2);
  ctx.fill();
}

function stampFoliage(ctx: Ctx, rand: () => number, base: Hsl, traversable: boolean): void {
  if (base.l >= 0.48 && traversable) {
    drawSpeckle(ctx, rand, base, 18, 32);
    ctx.lineCap = 'round';
    for (const p of scatter(rand, 9, 30)) {
      ctx.strokeStyle = rand() < 0.65 ? shift(base, 0.7) : shift(base, 1.24);
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      ctx.moveTo(p.x - 2.2, p.y - 2.4);
      ctx.lineTo(p.x, p.y + 1.4);
      ctx.lineTo(p.x + 2.4, p.y - 3);
      ctx.stroke();
    }
    return;
  }
  const trees = scatter(rand, traversable ? 7 : 12, traversable ? 28 : 31).sort((a, b) => a.y - b.y);
  const size = traversable ? 5.6 : 8;
  for (const t of trees) drawCanopy(ctx, base, t.x, t.y, size + rand() * 3);
}

function drawPeak(ctx: Ctx, base: Hsl, x: number, baseY: number, halfW: number, height: number, lean: number): void {
  const tipX = x + lean;
  const tipY = baseY - height;
  ctx.fillStyle = 'rgba(4, 8, 18, 0.32)';
  ctx.beginPath();
  ctx.ellipse(x + 2, baseY + 0.5, halfW * 1.1, 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = shift(base, 1.34, 0.88);
  ctx.beginPath();
  ctx.moveTo(x - halfW, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(x + lean * 0.3 + 1, baseY);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = shift(base, 0.62);
  ctx.beginPath();
  ctx.moveTo(x + lean * 0.3 + 1, baseY);
  ctx.lineTo(tipX, tipY);
  ctx.lineTo(x + halfW, baseY);
  ctx.closePath();
  ctx.fill();
  const capH = height * 0.26;
  const k = capH / height;
  ctx.fillStyle = hslCss({ h: base.h, s: base.s * 0.3, l: Math.min(0.94, base.l * 1.7 + 0.2) });
  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(tipX + (x + halfW - tipX) * k, tipY + capH);
  ctx.lineTo(tipX + (x + lean * 0.3 - tipX) * k + 1, tipY + capH * 1.28);
  ctx.lineTo(tipX + (x - halfW - tipX) * k, tipY + capH);
  ctx.closePath();
  ctx.fill();
}

function stampRock(ctx: Ctx, rand: () => number, base: Hsl): void {
  drawSpeckle(ctx, rand, base, 14, 32);
  const lean = () => (rand() - 0.5) * 6;
  drawPeak(ctx, base, -13 - rand() * 4, 6, 15 + rand() * 3, 26 + rand() * 7, lean());
  drawPeak(ctx, base, 15 + rand() * 4, 10, 15 + rand() * 3, 25 + rand() * 7, lean());
  drawPeak(ctx, base, 1 + (rand() - 0.5) * 6, 25, 19 + rand() * 3, 36 + rand() * 9, lean());
}

function stampSand(ctx: Ctx, rand: () => number, base: Hsl): void {
  ctx.lineCap = 'round';
  const rows = [-18 - rand() * 4, 2 + rand() * 3, 20 + rand() * 3];
  for (const y of rows) {
    const left = -26 - rand() * 6;
    const right = 26 + rand() * 6;
    const crest = y - 5 - rand() * 3;
    const curve = (dy: number) => {
      ctx.beginPath();
      ctx.moveTo(left, y + dy);
      ctx.quadraticCurveTo((left + right) / 2 + (rand() - 0.5) * 10, crest + dy, right, y + dy);
    };
    curve(1.5);
    ctx.strokeStyle = shift(base, 1.08);
    ctx.lineWidth = 1.2;
    ctx.stroke();
    curve(0);
    ctx.strokeStyle = shift(base, 0.8);
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
  drawSpeckle(ctx, rand, base, 12, 30);
}

function stampEmber(ctx: Ctx, rand: () => number): void {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (let c = 0; c < 3; c++) {
    const crack = new Path2D();
    let x = -30 + rand() * 18;
    let y = -22 + c * 18 + rand() * 6;
    crack.moveTo(x, y);
    for (let s = 0; s < 5; s++) {
      x += 9 + rand() * 6;
      y += (rand() - 0.5) * 14;
      crack.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(255, 96, 26, 0.55)';
    ctx.lineWidth = 3.6;
    ctx.stroke(crack);
    ctx.strokeStyle = '#ffc24d';
    ctx.lineWidth = 1.3;
    ctx.stroke(crack);
  }
}

function stampPlain(ctx: Ctx, rand: () => number, base: Hsl): void {
  drawSpeckle(ctx, rand, base, 34, 34);
  for (const p of scatter(rand, 5, 28)) {
    const r = 1.6 + rand() * 1.8;
    ctx.fillStyle = shift(base, 0.74);
    ctx.beginPath();
    ctx.ellipse(p.x, p.y + 0.8, r * 1.2, r * 0.8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = shift(base, 1.16);
    ctx.beginPath();
    ctx.ellipse(p.x - 0.4, p.y, r, r * 0.62, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawRim(ctx: Ctx, flat: boolean): void {
  const inset = HEX_SIZE - 1;
  const k = inset / HEX_SIZE;
  const line = (a: number, b: number, c: number, d: number) => {
    ctx.beginPath();
    ctx.moveTo(CORNERS[a].x * k, CORNERS[a].y * k);
    ctx.lineTo(CORNERS[b].x * k, CORNERS[b].y * k);
    ctx.lineTo(CORNERS[c].x * k, CORNERS[c].y * k);
    ctx.lineTo(CORNERS[d].x * k, CORNERS[d].y * k);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 2;
  ctx.strokeStyle = flat ? 'rgba(255, 255, 255, 0.09)' : 'rgba(255, 250, 235, 0.3)';
  line(3, 4, 5, 0);
  ctx.strokeStyle = flat ? 'rgba(4, 8, 24, 0.1)' : 'rgba(4, 8, 24, 0.24)';
  line(0, 1, 2, 3);
}

function fillBase(ctx: Ctx, base: Hsl, material: TerrainMaterial): void {
  const gradient = ctx.createLinearGradient(0, -HEX_H / 2, 0, HEX_H / 2);
  const span = material === 'water' ? 0.06 : 0.1;
  gradient.addColorStop(0, shift(base, 1 + span));
  gradient.addColorStop(0.55, shift(base, 1));
  gradient.addColorStop(1, shift(base, 1 - span));
  ctx.fillStyle = gradient;
  ctx.beginPath();
  traceHex(ctx, 0, 0, HEX_SIZE + 0.5);
  ctx.fill();
}

/** Authored colour nudged per material so stamps read: lava goes dark so its cracks glow, blocked land sits lower. */
function roomTint(color: number, material: TerrainMaterial, traversable: boolean, variant: number): Hsl {
  const hsl = rgbToHsl(colorToRgb(color));
  let l = hsl.l * variantLightness(variant);
  if (material === 'ember') l *= 0.66;
  else if (!traversable && material !== 'water') l *= 0.8;
  return { h: hsl.h, s: hsl.s, l };
}

/** Paints all map layers except the sea to offscreen canvases. Owns no GPU state; the map uploads the results. */
export class MapBaker {
  rooms: BakeRoom[] = [];
  bounds: BakeBounds | null = null;
  scale = 1;
  terrainCanvas: HTMLCanvasElement | null = null;
  fogCanvas: HTMLCanvasElement | null = null;
  coastCanvas: HTMLCanvasElement | null = null;

  private ordered: BakeRoom[] = [];
  private landmarkTypes = new Set<string>();
  private isExplored: (room: BakeRoom) => boolean = () => false;
  private sprites = new Map<string, Sprite>();
  private rimSprite: Sprite | null = null;
  private artSprites = new Map<string, Sprite>();
  private art = new Map<string, ArtEntry>();
  private roomArtQueue: BakeRoom[] = [];
  private heldRoomArt = new Set<ArtEntry>();
  private typeArtDirty = false;

  private ctx: Ctx | null = null;
  private bakeCursor = -1;
  private edgeCursor = -1;
  private dirtyRooms = new Set<BakeRoom>();
  private onArtReady: () => void;

  constructor(onArtReady: () => void) {
    this.onArtReady = onArtReady;
  }

  get isBaking(): boolean {
    return this.bakeCursor >= 0 || this.edgeCursor >= 0;
  }

  get hasPendingArt(): boolean {
    return this.dirtyRooms.size > 0;
  }

  /** Replaces the map's rooms. Sprites of the previous map are dropped when `mapChanged`. */
  setRooms(rooms: BakeRoom[], landmarkTypes: Set<string>, isExplored: (room: BakeRoom) => boolean, mapChanged: boolean): void {
    this.rooms = rooms;
    this.ordered = [...rooms].sort((a, b) => a.y - b.y || a.x - b.x);
    this.landmarkTypes = landmarkTypes;
    this.isExplored = isExplored;
    this.sprites.clear();
    this.artSprites.clear();
    this.dirtyRooms.clear();
    this.roomArtQueue = [];
    this.typeArtDirty = false;
    if (mapChanged) this.forgetLoadedArt();
    this.bounds = this.computeBounds();
    this.bakeCursor = -1;
    this.edgeCursor = -1;
  }

  /** Forget failed art so newly uploaded files are tried again. */
  forgetFailedArt(): void {
    for (const [url, entry] of this.art) {
      if (entry.state === 'failed') this.art.delete(url);
    }
  }

  /**
   * Requests type art for every type, and room art for explored rooms in `view`, nearest first.
   * No list says which rooms have art, so each request may be a 404: the failed ones are remembered for the session.
   */
  requestArt(view: ArtView): void {
    const queue: { room: BakeRoom; dist: number }[] = [];
    const types = new Set<string>();
    for (const room of this.rooms) {
      types.add(room.type);
      const dx = Math.abs(room.x - view.x);
      const dy = Math.abs(room.y - view.y);
      if (!room.guid || dx > view.halfW || dy > view.halfH || !this.isExplored(room)) continue;
      if (!this.art.has(artworkUrl('tile', room.guid))) queue.push({ room, dist: dx * dx + dy * dy });
    }
    for (const type of types) this.loadTypeArt(type);
    this.roomArtQueue = queue.sort((a, b) => b.dist - a.dist).map(item => item.room);
    this.pumpRoomArt();
  }

  beginTerrain(maxTextureSize: number, devicePixelRatio: number): boolean {
    if (!this.bounds) return false;
    const { w, h } = this.bounds;
    const scale = bakeScale(w, h, maxTextureSize, devicePixelRatio);
    if (scale !== this.scale) {
      this.sprites.clear();
      this.artSprites.clear();
      this.rimSprite = null;
    }
    this.scale = scale;
    const bw = Math.ceil(w * scale);
    const bh = Math.ceil(h * scale);
    if (!this.terrainCanvas) this.terrainCanvas = newCanvas(bw, bh);
    if (this.terrainCanvas.width !== bw || this.terrainCanvas.height !== bh) {
      this.terrainCanvas.width = bw;
      this.terrainCanvas.height = bh;
    }
    this.ctx = this.terrainCanvas.getContext('2d');
    if (!this.ctx) return false;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, bw, bh);
    this.dirtyRooms.clear();
    this.typeArtDirty = false;
    this.forgetPaintedArt();
    this.bakeCursor = 0;
    this.edgeCursor = -1;
    return true;
  }

  /** Runs for about `budgetMs`. Returns true once the terrain canvas is complete. */
  stepTerrain(budgetMs: number): boolean {
    const ctx = this.ctx;
    if (!ctx) return true;
    const deadline = performance.now() + budgetMs;
    while (this.bakeCursor >= 0) {
      if (this.bakeCursor >= this.ordered.length) {
        this.bakeCursor = -1;
        this.edgeCursor = 0;
        break;
      }
      this.paintRoom(ctx, this.ordered[this.bakeCursor++]);
      if (performance.now() >= deadline) return false;
    }
    while (this.edgeCursor >= 0 && this.edgeCursor < this.rooms.length) {
      this.drawEdges(ctx, this.rooms.slice(this.edgeCursor, this.edgeCursor + EDGE_BATCH));
      this.edgeCursor += EDGE_BATCH;
      if (this.edgeCursor < this.rooms.length && performance.now() >= deadline) return false;
    }
    this.edgeCursor = -1;
    return true;
  }

  /**
   * Whether the queued art is better served by a full re-bake than room-by-room patches.
   * Only for type art: a re-bake forgets painted room art, so doing it for room art would never settle.
   */
  shouldRebakeForArt(): boolean {
    return this.typeArtDirty && this.dirtyRooms.size > this.rooms.length * REBAKE_SHARE;
  }

  /** Patches queued art rooms into the retained canvas for about `budgetMs`. Returns true when none remain. */
  stepArt(budgetMs: number): boolean {
    const ctx = this.ctx;
    if (!ctx) { this.dirtyRooms.clear(); return true; }
    const deadline = performance.now() + budgetMs;
    for (const room of this.dirtyRooms) {
      this.dirtyRooms.delete(room);
      this.repaintRoom(ctx, room);
      if (performance.now() >= deadline) break;
    }
    if (this.dirtyRooms.size > 0) return false;
    this.typeArtDirty = false;
    return true;
  }

  /** The land's cast shadow, plus a shallows glow when the sea is the plain procedural one. */
  bakeCoast(withShallows: boolean): void {
    if (!this.bounds) return;
    const { minX, minY, w, h } = this.bounds;
    if (!this.coastCanvas) this.coastCanvas = newCanvas(1, 1);
    this.coastCanvas.width = Math.ceil((w + COAST_PAD * 2) * COAST_RESOLUTION);
    this.coastCanvas.height = Math.ceil((h + COAST_PAD * 2) * COAST_RESOLUTION);
    const ctx = this.coastCanvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(COAST_RESOLUTION, 0, 0, COAST_RESOLUTION, (COAST_PAD - minX) * COAST_RESOLUTION, (COAST_PAD - minY) * COAST_RESOLUTION);
    const silhouette = new Path2D();
    for (const room of this.rooms) traceHex(silhouette, room.x, room.y);
    if (withShallows) {
      ctx.lineJoin = 'round';
      ctx.translate(0, -COAST_OFFSET_Y);
      ctx.strokeStyle = SHALLOWS_COLOR;
      for (const width of SHALLOWS_WIDTHS) {
        ctx.lineWidth = width;
        ctx.stroke(silhouette);
      }
      ctx.translate(0, COAST_OFFSET_Y);
    }
    ctx.fillStyle = COAST_SHADOW;
    ctx.fill(silhouette);
  }

  /** Fog is nested punches out of one full-map ink fill, so neighbouring rooms never show a seam. */
  bakeFog(currentZone: string, isZoneKnown: (zone: string) => boolean): void {
    if (!this.bounds) return;
    const { minX, minY, w, h } = this.bounds;
    const scale = Math.min(FOG_RESOLUTION, FOG_RESOLUTION * this.scale);
    const fw = Math.max(1, Math.ceil(w * scale));
    const fh = Math.max(1, Math.ceil(h * scale));
    if (!this.fogCanvas) this.fogCanvas = newCanvas(fw, fh);
    if (this.fogCanvas.width !== fw || this.fogCanvas.height !== fh) {
      this.fogCanvas.width = fw;
      this.fogCanvas.height = fh;
    }
    const ctx = this.fogCanvas.getContext('2d');
    if (!ctx) return;
    const fogRooms: FogRoom[] = this.rooms.map(room => ({
      traversable: room.traversable,
      explored: this.isExplored(room),
      zone: room.zone,
      neighbors: room.neighbors.flatMap(n => (n ? [n.index] : [])),
    }));
    const levels = computeFogLevels(fogRooms, currentZone, isZoneKnown);

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, fw, fh);
    ctx.setTransform(scale, 0, 0, scale, -minX * scale, -minY * scale);
    ctx.fillStyle = FOG_INK;

    const shape = (maxLevel: number): Path2D => {
      const path = new Path2D();
      for (const room of this.rooms) {
        if (levels[room.index] <= maxLevel) this.traceFogRoom(path, room);
      }
      return path;
    };
    ctx.globalAlpha = fogAlpha(3);
    ctx.fill(shape(3));
    ctx.globalCompositeOperation = 'destination-out';
    let current = fogAlpha(3);
    for (const level of [2, 1, 0]) {
      const target = fogAlpha(level);
      ctx.globalAlpha = 1 - target / current;
      ctx.fill(shape(level));
      current = target;
      if (target === 0) break;
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private traceFogRoom(path: Path2D, room: BakeRoom): void {
    traceHex(path, room.x, room.y);
    if (!room.neighbors[DIR_BOTTOM]) traceHex(path, room.x, room.y + SKIRT);
    if (!room.neighbors[DIR_TOP] && room.material === 'rock') traceHex(path, room.x, room.y - PEAK_HEADROOM);
  }

  private computeBounds(): BakeBounds | null {
    if (this.rooms.length === 0) return null;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const { x, y } of this.rooms) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
    const bx = Math.floor(minX - BAKE_MARGIN);
    const by = Math.floor(minY - BAKE_MARGIN);
    return { minX: bx, minY: by, w: Math.ceil(maxX - bx + BAKE_MARGIN), h: Math.ceil(maxY - by + BAKE_MARGIN) };
  }

  private toBake(room: BakeRoom): { x: number; y: number } {
    const { minX, minY } = this.bounds!;
    return { x: Math.round((room.x - minX) * this.scale), y: Math.round((room.y - minY) * this.scale) };
  }

  private paintRoom(ctx: Ctx, room: BakeRoom): void {
    const { x, y } = this.toBake(room);
    const entry = this.roomArt(room);
    if (entry?.state === 'ready' && entry.img && this.isExplored(room)) {
      this.drawRoomArt(ctx, entry.img, x, y);
      this.releaseRoomArt(entry);
      return;
    }
    const typeArt = this.typeArtSprite(room.type);
    const sprite = typeArt ?? this.proceduralSprite(room);
    ctx.drawImage(sprite.canvas, x - sprite.ox, y - sprite.oy);
  }

  private roomArt(room: BakeRoom): ArtEntry | undefined {
    return room.guid ? this.art.get(artworkUrl('tile', room.guid)) : undefined;
  }

  /** The terrain canvas keeps the pixels, so the image can go. A re-bake loads it again from the HTTP cache. */
  private releaseRoomArt(entry: ArtEntry): void {
    entry.state = 'painted';
    entry.img = null;
    this.heldRoomArt.delete(entry);
    this.pumpRoomArt();
  }

  private forgetPaintedArt(): void {
    for (const [url, entry] of this.art) {
      if (entry.state === 'painted') this.art.delete(url);
    }
  }

  /** Failed lookups stay, so that coming back to a map doesn't ask again for art that isn't there. */
  private forgetLoadedArt(): void {
    for (const [url, entry] of this.art) {
      if (entry.state !== 'failed') this.art.delete(url);
    }
    this.heldRoomArt.clear();
  }

  private readyTypeArt(type: string): HTMLImageElement | null {
    const entry = this.art.get(artworkUrl('tile-type', type));
    return entry?.state === 'ready' ? entry.img : null;
  }

  private loadTypeArt(type: string): void {
    const url = artworkUrl('tile-type', type);
    if (this.art.has(url)) return;
    this.loadImage(url, () => {
      this.typeArtDirty = true;
      for (const room of this.rooms) {
        if (room.type === type) this.dirtyRooms.add(room);
      }
      this.artSprites.delete(type);
      this.onArtReady();
    });
  }

  private pumpRoomArt(): void {
    while (this.heldRoomArt.size < ROOM_ART_HELD_MAX) {
      const room = this.roomArtQueue.pop();
      if (!room) return;
      const url = artworkUrl('tile', room.guid);
      if (this.art.has(url)) continue;
      const entry = this.loadImage(url, () => {
        this.dirtyRooms.add(room);
        this.onArtReady();
      }, () => {
        this.heldRoomArt.delete(entry);
        this.pumpRoomArt();
      });
      this.heldRoomArt.add(entry);
    }
  }

  /** Decodes before reporting ready, so that the draw in a bake slice doesn't decode on the main thread. */
  private loadImage(url: string, onReady: () => void, onFailed?: () => void): ArtEntry {
    const img = new Image();
    const entry: ArtEntry = { img, state: 'loading' };
    this.art.set(url, entry);
    const ready = () => {
      if (this.art.get(url) !== entry) return;
      entry.state = 'ready';
      onReady();
    };
    img.onload = () => {
      if (typeof img.decode === 'function') img.decode().then(ready, ready);
      else ready();
    };
    img.onerror = () => {
      entry.state = 'failed';
      entry.img = null;
      onFailed?.();
    };
    img.src = url;
    return entry;
  }

  private drawCover(ctx: Ctx, img: HTMLImageElement, x: number, y: number): void {
    const s = this.scale;
    const w = (HEX_W + 1) * s;
    const h = (HEX_H + 1) * s;
    const { sx, sy, sw, sh } = coverFit(img.naturalWidth, img.naturalHeight, w, h);
    ctx.save();
    ctx.beginPath();
    traceHex(ctx, x, y, (HEX_SIZE + 0.5) * s);
    ctx.clip();
    ctx.drawImage(img, sx, sy, sw, sh, x - w / 2, y - h / 2, w, h);
    ctx.restore();
  }

  private drawRoomArt(ctx: Ctx, img: HTMLImageElement, x: number, y: number): void {
    this.drawCover(ctx, img, x, y);
    const rim = this.rim();
    ctx.drawImage(rim.canvas, x - rim.ox, y - rim.oy);
  }

  private typeArtSprite(type: string): Sprite | null {
    const cached = this.artSprites.get(type);
    if (cached) return cached;
    const img = this.readyTypeArt(type);
    if (!img) return null;
    const sprite = this.newSprite();
    const ctx = sprite.canvas.getContext('2d');
    if (ctx) {
      this.drawCover(ctx, img, sprite.ox, sprite.oy);
      ctx.setTransform(this.scale, 0, 0, this.scale, sprite.ox, sprite.oy);
      drawRim(ctx, false);
    }
    this.artSprites.set(type, sprite);
    return sprite;
  }

  private rim(): Sprite {
    if (this.rimSprite) return this.rimSprite;
    const sprite = this.newSprite();
    const ctx = sprite.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(this.scale, 0, 0, this.scale, sprite.ox, sprite.oy);
      drawRim(ctx, false);
    }
    this.rimSprite = sprite;
    return sprite;
  }

  private newSprite(): Sprite {
    const s = this.scale;
    const canvas = newCanvas((HEX_W + SPRITE_PAD * 2) * s, (HEX_H + SPRITE_PAD * 2 + PEAK_HEADROOM) * s);
    return { canvas, ox: Math.round((HEX_SIZE + SPRITE_PAD) * s), oy: Math.round((HEX_H / 2 + SPRITE_PAD + PEAK_HEADROOM) * s) };
  }

  private proceduralSprite(room: BakeRoom): Sprite {
    const key = `${room.type}|${room.variant}`;
    const cached = this.sprites.get(key);
    if (cached) return cached;
    const sprite = this.newSprite();
    const ctx = sprite.canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(this.scale, 0, 0, this.scale, sprite.ox, sprite.oy);
      this.drawProcedural(ctx, room);
    }
    this.sprites.set(key, sprite);
    return sprite;
  }

  private drawProcedural(ctx: Ctx, room: BakeRoom): void {
    const base = roomTint(room.color, room.material, room.traversable, room.variant);
    const rand = seededRandom(hashText(room.type) + room.variant * 7919);
    fillBase(ctx, base, room.material);
    if (room.material === 'rock') drawRim(ctx, false);
    ctx.save();
    if (room.material !== 'rock') {
      ctx.beginPath();
      traceHex(ctx, 0, 0, HEX_SIZE);
      ctx.clip();
    }
    switch (room.material) {
      case 'water': stampWater(ctx, rand, base); break;
      case 'foliage': stampFoliage(ctx, rand, base, room.traversable); break;
      case 'rock': stampRock(ctx, rand, base); break;
      case 'sand': stampSand(ctx, rand, base); break;
      case 'ember': stampEmber(ctx, rand); break;
      case 'plain': stampPlain(ctx, rand, base); break;
    }
    ctx.restore();
    if (room.material !== 'rock') drawRim(ctx, room.material === 'water');
    if (room.icon && this.landmarkTypes.has(room.type)) this.drawLandmark(ctx, room.icon);
  }

  private drawLandmark(ctx: Ctx, icon: string): void {
    ctx.fillStyle = 'rgba(4, 8, 24, 0.32)';
    ctx.beginPath();
    ctx.ellipse(0, 13, 16, 5, 0, 0, Math.PI * 2);
    ctx.fill();
    // Colour emoji ignore the fill's colour but keep its alpha.
    ctx.fillStyle = '#fff';
    ctx.font = '32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(icon, 0, 0);
  }

  private repaintRoom(ctx: Ctx, room: BakeRoom): void {
    if (this.roomArt(room)?.state === 'painted') return;
    const { x, y } = this.toBake(room);
    // A neighbour with its own art shows at most a hairline under this clip, and may no longer have an image to draw.
    const near = [room, ...room.neighbors.filter((n): n is BakeRoom => n !== null && !this.hasOwnArt(n))];
    near.sort((a, b) => a.y - b.y || a.x - b.x);
    ctx.save();
    ctx.beginPath();
    traceHex(ctx, x, y, (HEX_SIZE + 0.5) * this.scale);
    ctx.clip();
    for (const each of near) this.paintRoom(ctx, each);
    this.drawEdges(ctx, near);
    ctx.restore();
  }

  private hasOwnArt(room: BakeRoom): boolean {
    const state = this.roomArt(room)?.state;
    return state === 'ready' || state === 'painted';
  }

  /** Each shared edge belongs to the lower-indexed room, so a patch redraws it exactly once. */
  private drawEdges(ctx: Ctx, rooms: readonly BakeRoom[]): void {
    const { minX, minY } = this.bounds!;
    const s = this.scale;
    const px = (v: number) => (v - minX) * s;
    const py = (v: number) => (v - minY) * s;
    const same = new Path2D();
    const different = new Path2D();
    const foam = new Path2D();
    const zone = new Path2D();
    const addLine = (path: Path2D, x0: number, y0: number, x1: number, y1: number) => {
      path.moveTo(px(x0), py(y0));
      path.lineTo(px(x1), py(y1));
    };

    for (const room of rooms) {
      const isWater = room.material === 'water';
      for (let dir = 0; dir < 6; dir++) {
        const nb = room.neighbors[dir];
        const [c0, c1] = DIR_TO_EDGE[dir];
        const x0 = room.x + CORNERS[c0].x;
        const y0 = room.y + CORNERS[c0].y;
        const x1 = room.x + CORNERS[c1].x;
        const y1 = room.y + CORNERS[c1].y;
        const isLower = LOWER_DIRS.has(dir);
        const nbIsWater = nb?.material === 'water';
        if (isLower && (!nb || (nbIsWater && !isWater))) {
          const drop = isWater ? WATER_SKIRT : SKIRT;
          ctx.fillStyle = this.skirtColor(room);
          ctx.beginPath();
          ctx.moveTo(px(x0), py(y0));
          ctx.lineTo(px(x1), py(y1));
          ctx.lineTo(px(x1), py(y1 + drop));
          ctx.lineTo(px(x0), py(y0 + drop));
          ctx.closePath();
          ctx.fill();
          if (nb) addLine(foam, x0, y0 + drop, x1, y1 + drop);
        }
        if (!nb || room.index > nb.index) continue;
        if (isWater !== nbIsWater) {
          const waterIsAbove = isLower ? isWater : nbIsWater;
          if (waterIsAbove) addLine(foam, x0, y0, x1, y1);
        } else {
          addLine(room.type === nb.type ? same : different, x0, y0, x1, y1);
        }
        if (room.zone !== nb.zone && room.traversable && nb.traversable) addLine(zone, x0, y0, x1, y1);
      }
    }

    ctx.lineCap = 'round';
    ctx.strokeStyle = 'rgba(6, 10, 28, 0.1)';
    ctx.lineWidth = Math.max(1, s);
    ctx.stroke(same);
    ctx.strokeStyle = 'rgba(6, 10, 28, 0.28)';
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.stroke(different);
    ctx.strokeStyle = FOAM;
    ctx.lineWidth = Math.max(1, 1.5 * s);
    ctx.stroke(foam);
    ctx.strokeStyle = ZONE_BORDER_UNDER;
    ctx.lineWidth = Math.max(1, 3.5 * s);
    ctx.stroke(zone);
    ctx.setLineDash([6 * s, 5 * s]);
    ctx.strokeStyle = ZONE_BORDER;
    ctx.lineWidth = Math.max(1, 2 * s);
    ctx.stroke(zone);
    ctx.setLineDash([]);
  }

  private skirtColor(room: BakeRoom): string {
    const base = roomTint(room.color, room.material, room.traversable, room.variant);
    return shift(base, room.material === 'water' ? 0.46 : 0.5, 0.86);
  }
}

/** Seamless ink-navy noise for maps without sea artwork. */
export function createSeaFallbackCanvas(): HTMLCanvasElement {
  const size = SEA_TILE_PX;
  const canvas = newCanvas(size, size);
  const ctx = canvas.getContext('2d');
  if (!ctx) return canvas;
  const rand = seededRandom(0x9a7c3e);
  const octaves = [4, 8, 16, 32].map((cells, i) => ({
    cells,
    amp: [0.5, 0.26, 0.15, 0.09][i],
    grid: Array.from({ length: cells * cells }, () => rand()),
  }));
  const img = ctx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let n = 0;
      for (const o of octaves) n += o.amp * periodicNoise(o.grid, o.cells, (x / size) * o.cells, (y / size) * o.cells);
      const shade = 0.7 + n * 0.6 + (rand() - 0.5) * 0.05;
      const i = (y * size + x) * 4;
      img.data[i] = 10 * shade;
      img.data[i + 1] = 19 * shade;
      img.data[i + 2] = 44 * shade;
      img.data[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function periodicNoise(grid: number[], cells: number, x: number, y: number): number {
  const x0 = Math.floor(x) % cells;
  const y0 = Math.floor(y) % cells;
  const x1 = (x0 + 1) % cells;
  const y1 = (y0 + 1) % cells;
  const fx = smooth(x - Math.floor(x));
  const fy = smooth(y - Math.floor(y));
  const top = grid[y0 * cells + x0] * (1 - fx) + grid[y0 * cells + x1] * fx;
  const bottom = grid[y1 * cells + x0] * (1 - fx) + grid[y1 * cells + x1] * fx;
  return top * (1 - fy) + bottom * fy;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}
