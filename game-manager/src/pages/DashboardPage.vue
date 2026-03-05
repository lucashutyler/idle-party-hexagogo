<template>
  <div class="dashboard">
    <h1>Dashboard</h1>

    <div class="cards">
      <div class="card">
        <h3>Server</h3>
        <div class="stat-row">
          <span class="label">Sessions</span>
          <span class="value">{{ serverStats?.sessions ?? '...' }}</span>
        </div>
        <div class="stat-row">
          <span class="label">Connections</span>
          <span class="value">{{ serverStats?.connections ?? '...' }}</span>
        </div>
        <div class="stat-row">
          <span class="label">Uptime</span>
          <span class="value">{{ formattedUptime }}</span>
        </div>
      </div>

      <div class="card">
        <h3>Monsters</h3>
        <div class="stat-row">
          <span class="label">Definitions</span>
          <span class="value">{{ monsters.loading ? '...' : Object.keys(monsters.data).length }}</span>
        </div>
      </div>

      <div class="card">
        <h3>Items</h3>
        <div class="stat-row">
          <span class="label">Definitions</span>
          <span class="value">{{ items.loading ? '...' : Object.keys(items.data).length }}</span>
        </div>
      </div>

      <div class="card">
        <h3>Zones</h3>
        <div class="stat-row">
          <span class="label">Definitions</span>
          <span class="value">{{ zones.loading ? '...' : Object.keys(zones.data).length }}</span>
        </div>
      </div>

      <div class="card">
        <h3>Tile Types</h3>
        <div class="stat-row">
          <span class="label">Definitions</span>
          <span class="value">{{ tileTypes.loading ? '...' : Object.keys(tileTypes.data).length }}</span>
        </div>
      </div>
    </div>

    <p v-if="statsError" class="error">{{ statsError }}</p>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { adminApi } from '../api/adminClient';
import { useMonsters } from '../composables/useMonsters';
import { useItems } from '../composables/useItems';
import { useZones } from '../composables/useZones';
import { useTileTypes } from '../composables/useTileTypes';

interface ServerStats {
  sessions: number;
  connections: number;
  uptime: number;
}

const serverStats = ref<ServerStats | null>(null);
const statsError = ref('');
let refreshInterval: ReturnType<typeof setInterval> | undefined;

const monsters = useMonsters();
const items = useItems();
const zones = useZones();
const tileTypes = useTileTypes();

const formattedUptime = computed(() => {
  if (!serverStats.value) return '...';
  const secs = Math.floor(serverStats.value.uptime);
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  return `${h}h ${m}m ${s}s`;
});

async function loadStats() {
  try {
    serverStats.value = await adminApi.getServerStats();
    statsError.value = '';
  } catch (e) {
    statsError.value = `Failed to load server stats: ${e}`;
  }
}

onMounted(async () => {
  await Promise.all([
    loadStats(),
    monsters.load(),
    items.load(),
    zones.load(),
    tileTypes.load(),
  ]);
  refreshInterval = setInterval(loadStats, 5000);
});

onUnmounted(() => {
  if (refreshInterval) {
    clearInterval(refreshInterval);
  }
});
</script>

<style scoped>
.dashboard {
  padding: 24px;
}

.cards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
  margin-top: 16px;
}

.card {
  background: var(--card-bg, #1e1e2e);
  border: 1px solid var(--border-color, #333);
  border-radius: 8px;
  padding: 16px;
}

.card h3 {
  margin: 0 0 12px 0;
  color: var(--heading-color, #cdd6f4);
  font-size: 14px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.stat-row {
  display: flex;
  justify-content: space-between;
  padding: 4px 0;
}

.stat-row .label {
  color: var(--text-muted, #a6adc8);
}

.stat-row .value {
  color: var(--text-color, #cdd6f4);
  font-weight: 600;
}

.error {
  color: var(--error-color, #f38ba8);
  margin-top: 16px;
}
</style>
