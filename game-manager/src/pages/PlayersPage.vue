<template>
  <div class="editor-page">
    <h1>Players</h1>

    <p v-if="error" class="error">{{ error }}</p>

    <div class="toolbar">
      <div class="sort-controls">
        <label>Sort by:</label>
        <select v-model="sortField">
          <option value="username">Name</option>
          <option value="online">Status</option>
        </select>
      </div>
    </div>

    <table class="data-table">
      <thead>
        <tr>
          <th @click="sortField = 'username'" class="sortable">
            Username {{ sortField === 'username' ? (sortAsc ? '\u25B2' : '\u25BC') : '' }}
          </th>
          <th>Level</th>
          <th>Position</th>
          <th @click="sortField = 'online'" class="sortable">
            Status {{ sortField === 'online' ? (sortAsc ? '\u25B2' : '\u25BC') : '' }}
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="player in sortedPlayers" :key="player.username">
          <td>{{ player.username }}</td>
          <td>{{ player.level }}</td>
          <td>({{ player.col }}, {{ player.row }})</td>
          <td>
            <span class="status-dot" :class="{ online: player.online, offline: !player.online }"></span>
            {{ player.online ? 'Online' : 'Offline' }}
          </td>
        </tr>
      </tbody>
    </table>

    <p v-if="loading" class="loading">Loading...</p>
    <p v-if="!loading && players.length === 0" class="empty-note">No players found.</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { adminApi } from '../api/adminClient';

interface PlayerInfo {
  username: string;
  level: number;
  col: number;
  row: number;
  online: boolean;
}

const players = ref<PlayerInfo[]>([]);
const loading = ref(false);
const error = ref('');
const sortField = ref<'username' | 'online'>('username');
const sortAsc = ref(true);
let refreshInterval: ReturnType<typeof setInterval> | undefined;

const sortedPlayers = computed(() => {
  const sorted = [...players.value];
  sorted.sort((a, b) => {
    if (sortField.value === 'username') {
      const cmp = a.username.localeCompare(b.username);
      return sortAsc.value ? cmp : -cmp;
    } else {
      // Online first
      const aVal = a.online ? 0 : 1;
      const bVal = b.online ? 0 : 1;
      const cmp = aVal - bVal || a.username.localeCompare(b.username);
      return sortAsc.value ? cmp : -cmp;
    }
  });
  return sorted;
});

async function loadPlayers() {
  loading.value = true;
  try {
    players.value = await adminApi.getPlayers();
    error.value = '';
  } catch (e) {
    error.value = `Failed to load players: ${e}`;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  loadPlayers();
  refreshInterval = setInterval(loadPlayers, 10000);
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<style scoped>
.editor-page {
  padding: 24px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 16px 0;
}

.sort-controls {
  display: flex;
  align-items: center;
  gap: 8px;
}

.sort-controls label {
  color: var(--text-muted, #a6adc8);
  font-size: 13px;
}

.sort-controls select {
  padding: 6px 10px;
  background: var(--input-bg, #181825);
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  color: var(--text-color, #cdd6f4);
  font-size: 13px;
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

.data-table th.sortable {
  cursor: pointer;
  user-select: none;
}

.data-table th.sortable:hover {
  color: var(--text-color, #cdd6f4);
}

.status-dot {
  display: inline-block;
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-right: 6px;
}

.status-dot.online {
  background: var(--success-color, #a6e3a1);
}

.status-dot.offline {
  background: var(--error-color, #f38ba8);
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
