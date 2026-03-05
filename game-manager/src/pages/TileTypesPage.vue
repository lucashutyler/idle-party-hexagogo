<template>
  <div class="editor-page">
    <h1>Tile Types</h1>

    <p v-if="tileTypes.error" class="error">{{ tileTypes.error }}</p>

    <div class="two-panel">
      <!-- Left panel: table -->
      <div class="panel-left">
        <table class="data-table">
          <thead>
            <tr>
              <th>Type</th>
              <th>Color</th>
              <th>Traversable</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="tt in tileTypeList"
              :key="tt.type"
              :class="{ selected: selectedId === tt.type }"
              @click="selectTileType(tt)"
            >
              <td>{{ tt.type }}</td>
              <td>
                <span class="color-swatch" :style="{ backgroundColor: numberToHex(tt.color) }"></span>
                {{ numberToHex(tt.color) }}
              </td>
              <td>{{ tt.traversable ? 'Yes' : 'No' }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="tileTypes.loading" class="loading">Loading...</p>
      </div>

      <!-- Right panel: editor form -->
      <div class="panel-right">
        <div class="form-header">
          <h2>{{ isNew ? 'New Tile Type' : 'Edit Tile Type' }}</h2>
          <button class="btn btn-secondary" @click="resetForm">New Tile Type</button>
        </div>

        <form @submit.prevent="handleSave">
          <div class="form-group">
            <label for="tt-type">Type (ID)</label>
            <input
              id="tt-type"
              :value="form.type"
              type="text"
              readonly
              class="readonly"
            />
          </div>

          <div class="form-group">
            <label for="tt-color">Color</label>
            <input
              id="tt-color"
              :value="numberToHex(form.color)"
              type="color"
              @input="onColorInput"
            />
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input v-model="form.traversable" type="checkbox" />
              Traversable
            </label>
          </div>

          <!-- Hex preview -->
          <div class="form-section">
            <h3>Preview</h3>
            <div class="hex-preview-container">
              <div class="hex-preview" :style="{ backgroundColor: numberToHex(form.color) }"></div>
            </div>
          </div>

          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Save</button>
            <button
              v-if="!isNew"
              type="button"
              class="btn btn-danger"
              @click="handleDelete"
            >Delete</button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, reactive, onMounted } from 'vue';
import { useTileTypes } from '../composables/useTileTypes';
import { nextId } from '../utils/nextId';
import type { TileConfig } from '@idle-party-rpg/shared';

const tileTypes = useTileTypes();

const selectedId = ref<string | null>(null);
const isNew = ref(true);

const form = reactive({
  type: '',
  color: 0x7ec850,
  traversable: true,
});

const tileTypeList = computed(() => {
  return Object.values(tileTypes.data) as TileConfig[];
});

function numberToHex(n: number): string {
  return '#' + n.toString(16).padStart(6, '0');
}

function hexToNumber(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

function onColorInput(e: Event) {
  const target = e.target as HTMLInputElement;
  form.color = hexToNumber(target.value);
}

function selectTileType(tt: TileConfig) {
  selectedId.value = tt.type;
  isNew.value = false;
  form.type = tt.type;
  form.color = tt.color;
  form.traversable = tt.traversable;
}

function resetForm() {
  selectedId.value = null;
  isNew.value = true;
  form.type = nextId(Object.keys(tileTypes.data));
  form.color = 0x7ec850;
  form.traversable = true;
}

async function handleSave() {
  const data: TileConfig = {
    type: form.type,
    color: form.color,
    traversable: form.traversable,
  };

  if (isNew.value) {
    await tileTypes.create(data);
  } else {
    await tileTypes.save(data);
  }

  selectedId.value = data.type;
  isNew.value = false;
}

async function handleDelete() {
  if (!selectedId.value) return;
  if (!window.confirm(`Delete tile type "${selectedId.value}"?`)) return;
  await tileTypes.remove(selectedId.value);
  resetForm();
}

onMounted(() => {
  tileTypes.load();
});
</script>

<style scoped>
.editor-page {
  padding: 24px;
}

.two-panel {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 24px;
  margin-top: 16px;
}

.panel-left {
  overflow-x: auto;
}

.panel-right {
  background: var(--card-bg, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 20px;
}

.data-table {
  width: 100%;
  border-collapse: collapse;
}

.data-table th,
.data-table td {
  padding: 8px 12px;
  text-align: left;
  border-bottom: 1px solid var(--border-color, #333);
}

.data-table th {
  color: var(--text-muted, #a6adc8);
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.data-table tr {
  cursor: pointer;
}

.data-table tr:hover {
  background: var(--hover-bg, #2a2a3e);
}

.data-table tr.selected {
  background: var(--selected-bg, #313244);
}

.color-swatch {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 2px;
  vertical-align: middle;
  margin-right: 6px;
  border: 1px solid var(--border-color, #333);
}

.form-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 16px;
}

.form-header h2 {
  margin: 0;
}

.form-group {
  margin-bottom: 12px;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  color: var(--text-muted, #a6adc8);
  font-size: 12px;
  text-transform: uppercase;
}

.form-group input[type="text"],
.form-group input[type="number"],
.form-group select {
  width: 100%;
  padding: 8px;
  background: var(--input-bg, #181825);
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  color: var(--text-color, #cdd6f4);
  font-size: 14px;
  box-sizing: border-box;
}

.form-group input[type="color"] {
  width: 100%;
  height: 40px;
  padding: 2px;
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  background: var(--input-bg, #181825);
  cursor: pointer;
}

.form-group input.readonly {
  opacity: 0.6;
  cursor: not-allowed;
}

.checkbox-label {
  display: flex !important;
  align-items: center;
  gap: 8px;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 18px;
  height: 18px;
}

.form-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color, #333);
}

.form-section h3 {
  margin: 0 0 12px 0;
  font-size: 14px;
}

.hex-preview-container {
  display: flex;
  justify-content: center;
  padding: 20px;
}

.hex-preview {
  width: 80px;
  height: 92px;
  clip-path: polygon(50% 0%, 100% 25%, 100% 75%, 50% 100%, 0% 75%, 0% 25%);
  transition: background-color 0.2s;
}

.form-actions {
  display: flex;
  gap: 8px;
  margin-top: 20px;
}

.btn {
  padding: 8px 16px;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
}

.btn-primary {
  background: var(--primary-color, #89b4fa);
  color: var(--primary-text, #1e1e2e);
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-secondary {
  background: var(--secondary-bg, #45475a);
  color: var(--text-color, #cdd6f4);
}

.btn-secondary:hover {
  opacity: 0.9;
}

.btn-danger {
  background: var(--error-color, #f38ba8);
  color: var(--primary-text, #1e1e2e);
}

.btn-danger:hover {
  opacity: 0.9;
}

.loading {
  color: var(--text-muted, #a6adc8);
  font-style: italic;
}

.error {
  color: var(--error-color, #f38ba8);
  margin-bottom: 16px;
}
</style>
