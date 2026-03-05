<template>
  <div class="editor-page">
    <h1>Zones</h1>

    <p v-if="zones.error" class="error">{{ zones.error }}</p>

    <div class="two-panel">
      <!-- Left panel: table -->
      <div class="panel-left">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Display Name</th>
              <th>Level Range</th>
              <th>Encounters</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="zone in zoneList"
              :key="zone.id"
              :class="{ selected: selectedId === zone.id }"
              @click="selectZone(zone)"
            >
              <td>{{ zone.id }}</td>
              <td>{{ zone.displayName }}</td>
              <td>{{ zone.levelRange[0] }}-{{ zone.levelRange[1] }}</td>
              <td>{{ zone.encounterTable.length }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="zones.loading" class="loading">Loading...</p>
      </div>

      <!-- Right panel: editor form -->
      <div class="panel-right">
        <div class="form-header">
          <h2>{{ isNew ? 'New Zone' : 'Edit Zone' }}</h2>
          <button class="btn btn-secondary" @click="resetForm">New Zone</button>
        </div>

        <form @submit.prevent="handleSave">
          <div class="form-group">
            <label for="zone-id">ID</label>
            <input
              id="zone-id"
              :value="form.id"
              type="text"
              readonly
              class="readonly"
            />
          </div>

          <div class="form-group">
            <label for="zone-name">Display Name</label>
            <input id="zone-name" v-model="form.displayName" type="text" required />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="zone-level-min">Level Min</label>
              <input id="zone-level-min" v-model.number="form.levelMin" type="number" min="1" required />
            </div>
            <div class="form-group">
              <label for="zone-level-max">Level Max</label>
              <input id="zone-level-max" v-model.number="form.levelMax" type="number" min="1" required />
            </div>
          </div>

          <!-- Encounter Table -->
          <div class="form-section">
            <div class="section-header">
              <h3>Encounter Table</h3>
              <button type="button" class="btn btn-small" @click="addEncounter">Add Encounter</button>
            </div>
            <div v-for="(entry, index) in form.encounters" :key="index" class="encounter-row">
              <div class="encounter-fields">
                <div class="form-group">
                  <label>Monster</label>
                  <select v-model="entry.monsterId">
                    <option value="">-- Select --</option>
                    <option v-for="m in monsterList" :key="m.id" :value="m.id">
                      {{ m.name }} ({{ m.id }})
                    </option>
                  </select>
                </div>
                <div class="form-group">
                  <label>Weight</label>
                  <input v-model.number="entry.weight" type="number" min="1" />
                </div>
                <div class="form-group">
                  <label>Min Count</label>
                  <input v-model.number="entry.minCount" type="number" min="1" />
                </div>
                <div class="form-group">
                  <label>Max Count</label>
                  <input v-model.number="entry.maxCount" type="number" min="1" />
                </div>
                <button type="button" class="btn btn-danger btn-small btn-remove" @click="removeEncounter(index)">X</button>
              </div>
            </div>
            <p v-if="form.encounters.length === 0" class="empty-note">No encounters configured.</p>
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
import { useZones } from '../composables/useZones';
import { useMonsters } from '../composables/useMonsters';
import { nextId } from '../utils/nextId';
import type { ZoneDefinition, EncounterTableEntry, MonsterDefinition } from '@idle-party-rpg/shared';

const zones = useZones();
const monsters = useMonsters();

const selectedId = ref<string | null>(null);
const isNew = ref(true);

const form = reactive({
  id: '',
  displayName: '',
  levelMin: 1,
  levelMax: 1,
  encounters: [] as { monsterId: string; weight: number; minCount: number; maxCount: number }[],
});

const zoneList = computed(() => {
  return Object.values(zones.data) as ZoneDefinition[];
});

const monsterList = computed(() => {
  return Object.values(monsters.data) as MonsterDefinition[];
});

function selectZone(zone: ZoneDefinition) {
  selectedId.value = zone.id;
  isNew.value = false;
  form.id = zone.id;
  form.displayName = zone.displayName;
  form.levelMin = zone.levelRange[0];
  form.levelMax = zone.levelRange[1];
  form.encounters = zone.encounterTable.map(e => ({ ...e }));
}

function resetForm() {
  selectedId.value = null;
  isNew.value = true;
  form.id = nextId(Object.keys(zones.data));
  form.displayName = '';
  form.levelMin = 1;
  form.levelMax = 1;
  form.encounters = [];
}

function addEncounter() {
  form.encounters.push({ monsterId: '', weight: 1, minCount: 1, maxCount: 1 });
}

function removeEncounter(index: number) {
  form.encounters.splice(index, 1);
}

async function handleSave() {
  const zoneData: ZoneDefinition = {
    id: form.id,
    displayName: form.displayName,
    levelRange: [form.levelMin, form.levelMax],
    encounterTable: form.encounters.filter(e => e.monsterId) as EncounterTableEntry[],
  };

  if (isNew.value) {
    await zones.create(zoneData);
  } else {
    await zones.save(zoneData);
  }

  selectedId.value = zoneData.id;
  isNew.value = false;
}

async function handleDelete() {
  if (!selectedId.value) return;
  if (!window.confirm(`Delete zone "${selectedId.value}"?`)) return;
  await zones.remove(selectedId.value);
  resetForm();
}

onMounted(async () => {
  await Promise.all([zones.load(), monsters.load()]);
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

.form-group input.readonly {
  opacity: 0.6;
  cursor: not-allowed;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.form-section {
  margin-top: 16px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color, #333);
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}

.section-header h3 {
  margin: 0;
  font-size: 14px;
}

.encounter-row {
  margin-bottom: 12px;
  padding: 12px;
  background: var(--input-bg, #181825);
  border-radius: 4px;
  border: 1px solid var(--border-color, #333);
}

.encounter-fields {
  display: grid;
  grid-template-columns: 2fr 1fr 1fr 1fr auto;
  gap: 8px;
  align-items: end;
}

.encounter-fields .form-group {
  margin-bottom: 0;
}

.encounter-fields select,
.encounter-fields input {
  padding: 6px 8px;
  font-size: 13px;
}

.btn-remove {
  align-self: end;
  margin-bottom: 2px;
}

.empty-note {
  color: var(--text-muted, #a6adc8);
  font-size: 13px;
  font-style: italic;
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
</style>
