<template>
  <div class="editor-page">
    <div class="page-header">
      <router-link to="/maps" class="btn btn-secondary">Back</router-link>
      <h1 v-if="mapData">{{ mapData.name }}</h1>
      <h1 v-else>Map Editor</h1>
      <span v-if="mapData" class="tile-count">{{ mapData.tiles.length }} tiles</span>
      <div class="header-actions" v-if="mapData">
        <button class="btn btn-primary" @click="saveMap" :disabled="saving">
          {{ saving ? 'Saving...' : 'Save' }}
        </button>
      </div>
    </div>

    <p v-if="error" class="error">{{ error }}</p>
    <p v-if="loading" class="loading">Loading map...</p>

    <div v-if="mapData" class="editor-layout">
      <HexTilePalette
        :tile-types="tileTypes"
        :zones="zones"
        v-model:selected-type="selectedType"
        v-model:selected-zone="selectedZone"
        v-model:mode="editorMode"
      />
      <div class="map-area">
        <HexMapCanvas
          :tiles="mapData.tiles"
          :start-position="mapData.startPosition"
          :selected-type="selectedType"
          :selected-zone="selectedZone"
          :mode="editorMode"
          @paint="onPaint"
          @erase="onErase"
          @set-start="onSetStart"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRoute } from 'vue-router';
import { adminApi } from '../api/adminClient';
import { useTileTypes } from '../composables/useTileTypes';
import { useZones } from '../composables/useZones';
import HexMapCanvas from '../components/HexMapCanvas.vue';
import HexTilePalette from '../components/HexTilePalette.vue';
import type { MapDefinition } from '@idle-party-rpg/shared';

const route = useRoute();
const mapData = ref<MapDefinition | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref('');

const { tileTypes, load: loadTileTypes } = useTileTypes();
const { zones, load: loadZones } = useZones();

const selectedType = ref('plains');
const selectedZone = ref('friendly_forest');
const editorMode = ref<'paint' | 'erase' | 'zone' | 'start'>('paint');

onMounted(async () => {
  const id = route.params.id as string;
  loading.value = true;
  try {
    await Promise.all([loadTileTypes(), loadZones()]);
    mapData.value = await adminApi.getMap(id);
    error.value = '';
  } catch (e) {
    error.value = `Failed to load map: ${e}`;
  } finally {
    loading.value = false;
  }
});

function onPaint(tile: { col: number; row: number; type: string; zone: string }) {
  if (!mapData.value) return;
  const idx = mapData.value.tiles.findIndex(t => t.col === tile.col && t.row === tile.row);
  if (idx >= 0) {
    mapData.value.tiles[idx] = tile;
  } else {
    mapData.value.tiles.push(tile);
  }
}

function onErase(col: number, row: number) {
  if (!mapData.value) return;
  mapData.value.tiles = mapData.value.tiles.filter(t => t.col !== col || t.row !== row);
}

function onSetStart(col: number, row: number) {
  if (!mapData.value) return;
  mapData.value.startPosition = { col, row };
}

async function saveMap() {
  if (!mapData.value) return;
  saving.value = true;
  try {
    await adminApi.updateMap(mapData.value.id, mapData.value);
    error.value = '';
  } catch (e) {
    error.value = `Failed to save: ${e}`;
  } finally {
    saving.value = false;
  }
}
</script>

<style scoped>
.editor-page {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
}

.page-header {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 12px 24px;
  border-bottom: 1px solid var(--border-color, #333);
  flex-shrink: 0;
}

.page-header h1 {
  margin: 0;
  font-size: 18px;
}

.tile-count {
  color: var(--text-muted, #a6adc8);
  font-size: 14px;
}

.header-actions {
  margin-left: auto;
}

.editor-layout {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.map-area {
  flex: 1;
  overflow: hidden;
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  text-decoration: none;
  display: inline-block;
}

.btn-secondary {
  background: var(--secondary-bg, #45475a);
  color: var(--text-color, #cdd6f4);
}

.btn-secondary:hover {
  opacity: 0.9;
}

.btn-primary {
  background: var(--primary-color, #89b4fa);
  color: #000;
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading {
  color: var(--text-muted, #a6adc8);
  font-style: italic;
  padding: 24px;
}

.error {
  color: var(--error-color, #f38ba8);
  padding: 0 24px;
}
</style>
