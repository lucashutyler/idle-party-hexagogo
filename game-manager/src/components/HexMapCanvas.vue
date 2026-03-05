<template>
  <div class="hex-map-container" ref="containerRef">
    <svg
      :width="containerWidth"
      :height="containerHeight"
      :viewBox="viewBox"
      @mousedown="onMouseDown"
      @mousemove="onMouseMove"
      @mouseup="onMouseUp"
      @mouseleave="onMouseUp"
      @wheel.prevent="onWheel"
    >
      <g>
        <!-- Grid background tiles -->
        <polygon
          v-for="tile in tiles"
          :key="tile.key"
          :points="hexPoints(tile.px, tile.py)"
          :fill="tileFill(tile)"
          :stroke="tileStroke(tile)"
          :stroke-width="tile.key === hoveredKey ? 2.5 : 1.5"
          :opacity="1"
          @mousedown.stop="onTileMouseDown(tile, $event)"
          @mouseenter="onTileEnter(tile)"
          class="hex-tile"
        />
        <!-- Zone labels (one per zone cluster center) -->
        <text
          v-for="label in zoneLabels"
          :key="'zone-' + label.zone"
          :x="label.x"
          :y="label.y"
          text-anchor="middle"
          dominant-baseline="central"
          :font-size="14 / zoom"
          fill="#fff"
          fill-opacity="0.5"
          pointer-events="none"
        >{{ label.zone }}</text>
        <!-- Start position marker -->
        <circle
          v-if="startMarker"
          :cx="startMarker.x"
          :cy="startMarker.y"
          :r="12 / zoom"
          fill="#f5c211"
          fill-opacity="0.8"
          stroke="#fff"
          :stroke-width="2 / zoom"
          pointer-events="none"
        />
        <text
          v-if="startMarker"
          :x="startMarker.x"
          :y="startMarker.y + 1"
          text-anchor="middle"
          dominant-baseline="central"
          :font-size="12 / zoom"
          fill="#000"
          font-weight="bold"
          pointer-events="none"
        >S</text>
      </g>
    </svg>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue';
import {
  offsetToCube,
  cubeToPixel,
  pixelToCube,
  cubeToOffset,
  HEX_SIZE,
  TILE_CONFIGS,
} from '@idle-party-rpg/shared';

interface TileData {
  col: number;
  row: number;
  type: string;
  zone: string;
}

interface RenderedTile extends TileData {
  px: number;
  py: number;
  key: string;
}

const props = defineProps<{
  tiles: TileData[];
  startPosition: { col: number; row: number };
  selectedType: string;
  selectedZone: string;
  mode: 'paint' | 'erase' | 'zone' | 'start';
}>();

const emit = defineEmits<{
  (e: 'paint', tile: TileData): void;
  (e: 'erase', col: number, row: number): void;
  (e: 'setStart', col: number, row: number): void;
}>();

const containerRef = ref<HTMLDivElement>();
const containerWidth = ref(800);
const containerHeight = ref(600);

const panX = ref(0);
const panY = ref(0);
const zoom = ref(1);
const isPanning = ref(false);
const isPainting = ref(false);
const panStartX = ref(0);
const panStartY = ref(0);
const panOriginX = ref(0);
const panOriginY = ref(0);
const hoveredKey = ref<string | null>(null);

// Hex corner points for flat-top hexagon
const hexCornerOffsets = computed(() => {
  const corners: { x: number; y: number }[] = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i);
    corners.push({
      x: HEX_SIZE * Math.cos(angle),
      y: HEX_SIZE * Math.sin(angle),
    });
  }
  return corners;
});

function hexPoints(cx: number, cy: number): string {
  return hexCornerOffsets.value
    .map(c => `${cx + c.x},${cy + c.y}`)
    .join(' ');
}

// Convert tile data to rendered tiles with pixel positions
const tiles = computed<RenderedTile[]>(() => {
  return props.tiles.map(t => {
    const cube = offsetToCube({ col: t.col, row: t.row });
    const px = cubeToPixel(cube);
    return {
      ...t,
      px: px.x,
      py: px.y,
      key: `${t.col},${t.row}`,
    };
  });
});

// Zone labels at cluster centers
const zoneLabels = computed(() => {
  const zones = new Map<string, { sumX: number; sumY: number; count: number }>();
  for (const t of tiles.value) {
    const entry = zones.get(t.zone);
    if (entry) {
      entry.sumX += t.px;
      entry.sumY += t.py;
      entry.count++;
    } else {
      zones.set(t.zone, { sumX: t.px, sumY: t.py, count: 1 });
    }
  }
  return Array.from(zones.entries()).map(([zone, data]) => ({
    zone,
    x: data.sumX / data.count,
    y: data.sumY / data.count,
  }));
});

// Start position marker
const startMarker = computed(() => {
  const cube = offsetToCube(props.startPosition);
  const px = cubeToPixel(cube);
  return { x: px.x, y: px.y };
});

function tileFill(tile: RenderedTile): string {
  const config = TILE_CONFIGS[tile.type];
  if (!config) return '#333';
  const c = config.color;
  const r = (c >> 16) & 0xff;
  const g = (c >> 8) & 0xff;
  const b = c & 0xff;
  return `rgb(${r},${g},${b})`;
}

function tileStroke(tile: RenderedTile): string {
  if (tile.key === hoveredKey.value) return '#fff';
  return '#222';
}

// SVG viewBox
const viewBox = computed(() => {
  const cx = panX.value;
  const cy = panY.value;
  const w = containerWidth.value / zoom.value;
  const h = containerHeight.value / zoom.value;
  return `${cx - w / 2} ${cy - h / 2} ${w} ${h}`;
});

// Pan and zoom handlers
function onMouseDown(e: MouseEvent) {
  if (e.button === 1 || (e.button === 0 && e.altKey)) {
    // Middle click or alt+click to pan
    isPanning.value = true;
    panStartX.value = e.clientX;
    panStartY.value = e.clientY;
    panOriginX.value = panX.value;
    panOriginY.value = panY.value;
    e.preventDefault();
  }
}

function onMouseMove(e: MouseEvent) {
  if (isPanning.value) {
    const dx = (e.clientX - panStartX.value) / zoom.value;
    const dy = (e.clientY - panStartY.value) / zoom.value;
    panX.value = panOriginX.value - dx;
    panY.value = panOriginY.value - dy;
  }
  if (isPainting.value) {
    handlePaintAtScreen(e);
  }
}

function onMouseUp() {
  isPanning.value = false;
  isPainting.value = false;
}

function onWheel(e: WheelEvent) {
  const factor = e.deltaY > 0 ? 0.9 : 1.1;
  zoom.value = Math.max(0.1, Math.min(5, zoom.value * factor));
}

function onTileMouseDown(tile: RenderedTile, e: MouseEvent) {
  if (e.button !== 0 || e.altKey) return;
  e.preventDefault();

  if (props.mode === 'erase') {
    emit('erase', tile.col, tile.row);
  } else if (props.mode === 'start') {
    emit('setStart', tile.col, tile.row);
  } else if (props.mode === 'paint' || props.mode === 'zone') {
    isPainting.value = true;
    emitPaint(tile.col, tile.row);
  }
}

function onTileEnter(tile: RenderedTile) {
  hoveredKey.value = tile.key;
  if (isPainting.value) {
    emitPaint(tile.col, tile.row);
  }
}

function emitPaint(col: number, row: number) {
  const existing = props.tiles.find(t => t.col === col && t.row === row);
  if (props.mode === 'zone') {
    // Zone mode: keep tile type, change zone
    emit('paint', {
      col,
      row,
      type: existing?.type ?? props.selectedType,
      zone: props.selectedZone,
    });
  } else {
    emit('paint', {
      col,
      row,
      type: props.selectedType,
      zone: existing?.zone ?? props.selectedZone,
    });
  }
}

function handlePaintAtScreen(e: MouseEvent) {
  if (!containerRef.value) return;
  const rect = containerRef.value.getBoundingClientRect();
  const sx = e.clientX - rect.left;
  const sy = e.clientY - rect.top;
  // Convert screen → SVG world coords
  const w = containerWidth.value / zoom.value;
  const h = containerHeight.value / zoom.value;
  const worldX = panX.value - w / 2 + sx / zoom.value;
  const worldY = panY.value - h / 2 + sy / zoom.value;
  // Convert pixel → cube → offset
  const cube = pixelToCube({ x: worldX, y: worldY });
  const offset = cubeToOffset(cube);
  emitPaint(offset.col, offset.row);
}

// Resize observer
let resizeObserver: ResizeObserver | null = null;

onMounted(() => {
  if (containerRef.value) {
    containerWidth.value = containerRef.value.clientWidth;
    containerHeight.value = containerRef.value.clientHeight;
    resizeObserver = new ResizeObserver(entries => {
      for (const entry of entries) {
        containerWidth.value = entry.contentRect.width;
        containerHeight.value = entry.contentRect.height;
      }
    });
    resizeObserver.observe(containerRef.value);
  }

  // Center on tile centroid
  if (tiles.value.length > 0) {
    let sumX = 0, sumY = 0;
    for (const t of tiles.value) {
      sumX += t.px;
      sumY += t.py;
    }
    panX.value = sumX / tiles.value.length;
    panY.value = sumY / tiles.value.length;
    zoom.value = 0.5;
  }
});

onUnmounted(() => {
  resizeObserver?.disconnect();
});

// Re-center when tiles change significantly (e.g. first load)
watch(() => props.tiles.length, (newLen, oldLen) => {
  if (oldLen === 0 && newLen > 0) {
    let sumX = 0, sumY = 0;
    for (const t of tiles.value) {
      sumX += t.px;
      sumY += t.py;
    }
    panX.value = sumX / tiles.value.length;
    panY.value = sumY / tiles.value.length;
    zoom.value = 0.5;
  }
});
</script>

<style scoped>
.hex-map-container {
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: #0a0a14;
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  cursor: crosshair;
  user-select: none;
}

.hex-map-container svg {
  display: block;
}

.hex-tile {
  cursor: pointer;
  transition: stroke 0.1s;
}

.hex-tile:hover {
  stroke: #fff;
}
</style>
