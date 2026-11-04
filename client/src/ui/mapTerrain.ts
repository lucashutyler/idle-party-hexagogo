/** Pure decisions behind the world map's look. Canvas work lives in MapBaker. See docs/architecture/client.md. */

export type TerrainMaterial = 'water' | 'foliage' | 'rock' | 'sand' | 'ember' | 'plain';
export type MapLod = 'far' | 'mid' | 'near';

export interface Rgb { r: number; g: number; b: number }
export interface Hsl { h: number; s: number; l: number }

export const LOD_FAR_BELOW = 0.55;
export const LOD_NEAR_ABOVE = 1.2;
/** Share of the viewport, centred, the party may wander in before the camera follows. */
export const FOLLOW_INNER_FRACTION = 0.6;
/** Ink opacity per fog level, most revealed first. */
export const FOG_ALPHA = [0, 0.28, 0.62, 0.86] as const;
export type FogLevel = 0 | 1 | 2 | 3;

const LANDMARK_MAX_ROOMS = 4;
const LANDMARK_MAX_SHARE = 0.02;
const VARIANT_COUNT = 3;
const VARIANT_LIGHTNESS = [1, 1.04, 0.96] as const;
const MAX_TEXTURE_SIDE = 8192;
const MAX_BAKE_AREA = 16e6;
const COMFORT_BAKE_AREA = 6e6;
/** Below this, extra texels cost memory without looking any sharper. */
const MIN_SHARP_SCALE = 1.5;

export function colorToRgb(color: number): Rgb {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d + 6) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return { h: h * 60, s, l };
}

export function hslCss({ h, s, l }: Hsl, alpha = 1): string {
  const clamp = (v: number) => Math.max(0, Math.min(1, v));
  const base = `${h.toFixed(1)} ${(clamp(s) * 100).toFixed(1)}% ${(clamp(l) * 100).toFixed(1)}%`;
  return alpha >= 1 ? `hsl(${base})` : `hsl(${base} / ${alpha})`;
}

/** Which procedural surface a room type gets. Derived from authored colour, never a per-type table. */
export function terrainMaterial(color: number, traversable: boolean): TerrainMaterial {
  const { h, s, l } = rgbToHsl(colorToRgb(color));
  const isBlue = h >= 170 && h <= 260 && s >= 0.2;
  const isGreen = h >= 65 && h < 170 && s >= 0.15;
  const isEmber = (h < 28 || h > 345) && s >= 0.6 && l <= 0.6;
  const isPaleWarm = h >= 20 && h < 65 && s >= 0.2 && l >= 0.6;
  if (traversable) {
    if (isEmber) return 'ember';
    if (isGreen) return 'foliage';
    return isPaleWarm ? 'sand' : 'plain';
  }
  if (isBlue) return 'water';
  if (isGreen) return 'foliage';
  return isEmber ? 'ember' : 'rock';
}

/** Stable 0-2 per room, so the same room always looks the same. */
export function hexVariant(col: number, row: number): number {
  return ((Math.imul(col, 73856093) ^ Math.imul(row, 19349663)) >>> 0) % VARIANT_COUNT;
}

export function variantLightness(variant: number): number {
  return VARIANT_LIGHTNESS[variant] ?? 1;
}

/** A type rare enough on this map that its authored icon reads as a landmark rather than wallpaper. */
export function isLandmarkType(roomsOfType: number, roomsOnMap: number): boolean {
  return roomsOfType <= LANDMARK_MAX_ROOMS || roomsOfType / Math.max(1, roomsOnMap) <= LANDMARK_MAX_SHARE;
}

export interface FogRoom {
  traversable: boolean;
  explored: boolean;
  zone: string;
  /** Indices into the same list. */
  neighbors: readonly number[];
}

function walkableFog(room: FogRoom, currentZone: string, zoneKnown: (zone: string) => boolean): FogLevel {
  if (room.explored) return room.zone === currentZone ? 0 : 1;
  return zoneKnown(room.zone) ? 2 : 3;
}

/**
 * Fog level per room. A blocked room copies its most revealed walkable neighbour, so coasts open as
 * you explore; deeper blocked rooms fade out one level per ring.
 */
export function computeFogLevels(
  rooms: readonly FogRoom[],
  currentZone: string,
  zoneKnown: (zone: string) => boolean,
): Uint8Array {
  const levels = new Uint8Array(rooms.length).fill(3);
  const interior: number[] = [];
  rooms.forEach((room, i) => {
    if (room.traversable) levels[i] = walkableFog(room, currentZone, zoneKnown);
  });
  rooms.forEach((room, i) => {
    if (room.traversable) return;
    let best = 4;
    for (const n of room.neighbors) {
      if (rooms[n].traversable && levels[n] < best) best = levels[n];
    }
    if (best < 4) levels[i] = best;
    else interior.push(i);
  });
  for (let ring = 1; ring < FOG_ALPHA.length; ring++) {
    for (const i of interior) {
      for (const n of rooms[i].neighbors) {
        if (!rooms[n].traversable && levels[n] + 1 < levels[i]) levels[i] = levels[n] + 1;
      }
    }
  }
  return levels;
}

export function fogAlpha(level: number): number {
  return FOG_ALPHA[level] ?? FOG_ALPHA[FOG_ALPHA.length - 1];
}

/**
 * Bake texels per world unit. Never above the device's texture size or the area cap; small maps on
 * high-density screens earn extra sharpness, as long as they stay under a comfortable area.
 */
export function bakeScale(worldW: number, worldH: number, maxTextureSize: number, devicePixelRatio: number): number {
  const area = Math.max(1, worldW * worldH);
  const side = Math.max(1, worldW, worldH);
  const sideCap = Math.min(MAX_TEXTURE_SIDE, maxTextureSize || MAX_TEXTURE_SIDE) / side;
  const floor = Math.min(1, sideCap, Math.sqrt(MAX_BAKE_AREA / area));
  const wanted = devicePixelRatio >= 1.5 ? 2 : 1;
  const sharp = Math.min(wanted, sideCap, Math.sqrt(COMFORT_BAKE_AREA / area));
  return sharp >= MIN_SHARP_SCALE ? sharp : floor;
}

/** Source rectangle that makes an image cover a box without stretching. */
export function coverFit(srcW: number, srcH: number, boxW: number, boxH: number): { sx: number; sy: number; sw: number; sh: number } {
  const scale = Math.max(boxW / Math.max(1, srcW), boxH / Math.max(1, srcH));
  const sw = boxW / scale;
  const sh = boxH / scale;
  return { sx: (srcW - sw) / 2, sy: (srcH - sh) / 2, sw, sh };
}

export function lodForZoom(zoom: number): MapLod {
  if (zoom < LOD_FAR_BELOW) return 'far';
  return zoom > LOD_NEAR_ABOVE ? 'near' : 'mid';
}

/** Whether a screen point has left the inner frame the camera tolerates. */
export function outsideFollowFrame(screenX: number, screenY: number, viewW: number, viewH: number): boolean {
  const marginX = viewW * (1 - FOLLOW_INNER_FRACTION) / 2;
  const marginY = viewH * (1 - FOLLOW_INNER_FRACTION) / 2;
  return screenX < marginX || screenX > viewW - marginX || screenY < marginY || screenY > viewH - marginY;
}

export interface ZoneLabelRoom {
  zone: string;
  zoneName: string;
  x: number;
  y: number;
  /** Something else already draws here: the party, or the room's markers. */
  busy?: boolean;
}

export interface ZoneLabelAnchor {
  zone: string;
  name: string;
  x: number;
  y: number;
  rooms: number;
}

/** One anchor per zone: the free explored room nearest that zone's explored centroid. */
export function zoneLabelAnchors(exploredRooms: readonly ZoneLabelRoom[]): ZoneLabelAnchor[] {
  const zones = new Map<string, ZoneLabelRoom[]>();
  for (const room of exploredRooms) {
    const list = zones.get(room.zone);
    if (list) list.push(room);
    else zones.set(room.zone, [room]);
  }
  const anchors: ZoneLabelAnchor[] = [];
  for (const [zone, rooms] of zones) {
    const cx = rooms.reduce((sum, r) => sum + r.x, 0) / rooms.length;
    const cy = rooms.reduce((sum, r) => sum + r.y, 0) / rooms.length;
    let best = rooms[0];
    let bestDist = Infinity;
    for (const room of rooms) {
      const dist = (room.x - cx) ** 2 + (room.y - cy) ** 2 + (room.busy ? BUSY_ROOM_PENALTY : 0);
      if (dist < bestDist) { best = room; bestDist = dist; }
    }
    anchors.push({ zone, name: best.zoneName, x: best.x, y: best.y, rooms: rooms.length });
  }
  return anchors;
}

const BUSY_ROOM_PENALTY = 1e9;
const LABEL_CHAR_PX = 7.4;
const LABEL_PAD_PX = 14;
const LABEL_HEIGHT_PX = 20;

/** Labels that fit at this zoom without overlapping: the current zone first, then the most explored. */
export function pickZoneLabels(anchors: readonly ZoneLabelAnchor[], zoom: number, currentZone: string): ZoneLabelAnchor[] {
  const ordered = [...anchors].sort((a, b) => {
    if ((a.zone === currentZone) !== (b.zone === currentZone)) return a.zone === currentZone ? -1 : 1;
    return b.rooms - a.rooms || a.zone.localeCompare(b.zone);
  });
  const placed: { anchor: ZoneLabelAnchor; halfW: number; halfH: number }[] = [];
  for (const anchor of ordered) {
    const halfW = (anchor.name.length * LABEL_CHAR_PX + LABEL_PAD_PX) / 2 / zoom;
    const halfH = LABEL_HEIGHT_PX / 2 / zoom;
    const hits = placed.some(p =>
      Math.abs(p.anchor.x - anchor.x) < p.halfW + halfW && Math.abs(p.anchor.y - anchor.y) < p.halfH + halfH);
    if (!hits) placed.push({ anchor, halfW, halfH });
  }
  return placed.map(p => p.anchor);
}
