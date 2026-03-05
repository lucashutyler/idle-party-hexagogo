<template>
  <div class="editor-page">
    <h1>Maps</h1>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="toolbar">
      <button class="btn btn-primary" @click="showCreateForm = !showCreateForm">
        {{ showCreateForm ? 'Cancel' : 'Create Map' }}
      </button>
    </div>

    <!-- Create form -->
    <div v-if="showCreateForm" class="create-form">
      <form @submit.prevent="handleCreate">
        <div class="create-fields">
          <div class="form-group">
            <label for="new-map-id">ID</label>
            <input id="new-map-id" v-model="newMap.id" type="text" required />
          </div>
          <div class="form-group">
            <label for="new-map-name">Name</label>
            <input id="new-map-name" v-model="newMap.name" type="text" required />
          </div>
          <div class="form-group">
            <label for="new-map-type">Type</label>
            <select id="new-map-type" v-model="newMap.type">
              <option value="overworld">overworld</option>
              <option value="dungeon">dungeon</option>
            </select>
          </div>
          <button type="submit" class="btn btn-primary btn-create">Create</button>
        </div>
      </form>
    </div>

    <!-- Maps table -->
    <table class="data-table">
      <thead>
        <tr>
          <th>ID</th>
          <th>Name</th>
          <th>Type</th>
          <th>Tiles</th>
          <th>Actions</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="map in maps" :key="map.id">
          <td>{{ map.id }}</td>
          <td>{{ map.name }}</td>
          <td>{{ map.type }}</td>
          <td>{{ map.tileCount }}</td>
          <td class="actions-cell">
            <router-link :to="`/maps/${map.id}`" class="btn btn-small btn-secondary">Edit</router-link>
            <button class="btn btn-small btn-danger" @click="handleDelete(map.id)">Delete</button>
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="loading" class="loading">Loading...</p>
    <p v-if="!loading && maps.length === 0" class="empty-note">No maps found.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, reactive, onMounted } from 'vue';
import { adminApi } from '../api/adminClient';

interface MapSummary {
  id: string;
  name: string;
  type: string;
  tileCount: number;
}

const maps = ref<MapSummary[]>([]);
const loading = ref(false);
const error = ref('');
const showCreateForm = ref(false);

const newMap = reactive({
  id: '',
  name: '',
  type: 'overworld' as 'overworld' | 'dungeon',
});

async function loadMaps() {
  loading.value = true;
  try {
    maps.value = await adminApi.getMaps();
    error.value = '';
  } catch (e) {
    error.value = `Failed to load maps: ${e}`;
  } finally {
    loading.value = false;
  }
}

async function handleCreate() {
  try {
    await adminApi.createMap({
      id: newMap.id,
      name: newMap.name,
      type: newMap.type,
      startPosition: { col: 0, row: 0 },
      tiles: [],
    });
    newMap.id = '';
    newMap.name = '';
    newMap.type = 'overworld';
    showCreateForm.value = false;
    await loadMaps();
  } catch (e) {
    error.value = `Failed to create map: ${e}`;
  }
}

async function handleDelete(id: string) {
  if (!window.confirm(`Delete map "${id}"?`)) return;
  try {
    await adminApi.deleteMap(id);
    await loadMaps();
  } catch (e) {
    error.value = `Failed to delete map: ${e}`;
  }
}

onMounted(() => {
  loadMaps();
});
</script>

<style scoped>
.editor-page {
  padding: 24px;
}

.toolbar {
  margin: 16px 0;
}

.create-form {
  background: var(--card-bg, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 16px;
}

.create-fields {
  display: grid;
  grid-template-columns: 1fr 1fr 1fr auto;
  gap: 12px;
  align-items: end;
}

.form-group {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  margin-bottom: 4px;
  color: var(--text-muted, #a6adc8);
  font-size: 12px;
  text-transform: uppercase;
}

.form-group input,
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

.btn-create {
  height: 36px;
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

.actions-cell {
  display: flex;
  gap: 8px;
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

.btn-small {
  padding: 4px 10px;
  font-size: 12px;
}

.loading {
  color: var(--text-muted, #a6adc8);
  font-style: italic;
}

.error {
  color: var(--error-color, #f38ba8);
  margin-bottom: 16px;
}

.empty-note {
  color: var(--text-muted, #a6adc8);
  font-style: italic;
}
</style>
