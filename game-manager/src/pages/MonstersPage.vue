<template>
  <div class="editor-page">
    <h1>Monsters</h1>

    <p v-if="monsters.error" class="error">{{ monsters.error }}</p>

    <div class="two-panel">
      <!-- Left panel: table -->
      <div class="panel-left">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Level</th>
              <th>HP</th>
              <th>Damage</th>
              <th>XP</th>
              <th>Gold</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="monster in monsterList"
              :key="monster.id"
              :class="{ selected: selectedId === monster.id }"
              @click="selectMonster(monster)"
            >
              <td>{{ monster.id }}</td>
              <td>{{ monster.name }}</td>
              <td>{{ monster.level }}</td>
              <td>{{ monster.hp }}</td>
              <td>{{ monster.damage }}</td>
              <td>{{ monster.xp }}</td>
              <td>{{ monster.goldMin }}-{{ monster.goldMax }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="monsters.loading" class="loading">Loading...</p>
      </div>

      <!-- Right panel: editor form -->
      <div class="panel-right">
        <div class="form-header">
          <h2>{{ isNew ? 'New Monster' : 'Edit Monster' }}</h2>
          <button class="btn btn-secondary" @click="resetForm">New Monster</button>
        </div>

        <form @submit.prevent="handleSave">
          <div class="form-group">
            <label for="monster-id">ID</label>
            <input
              id="monster-id"
              :value="form.id"
              type="text"
              readonly
              class="readonly"
            />
          </div>

          <div class="form-group">
            <label for="monster-name">Name</label>
            <input id="monster-name" v-model="form.name" type="text" required />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="monster-level">Level</label>
              <input id="monster-level" v-model.number="form.level" type="number" min="1" required />
            </div>
            <div class="form-group">
              <label for="monster-hp">HP</label>
              <input id="monster-hp" v-model.number="form.hp" type="number" min="1" required />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="monster-damage">Damage</label>
              <input id="monster-damage" v-model.number="form.damage" type="number" min="0" required />
            </div>
            <div class="form-group">
              <label for="monster-xp">XP</label>
              <input id="monster-xp" v-model.number="form.xp" type="number" min="0" required />
            </div>
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="monster-gold-min">Gold Min</label>
              <input id="monster-gold-min" v-model.number="form.goldMin" type="number" min="0" required />
            </div>
            <div class="form-group">
              <label for="monster-gold-max">Gold Max</label>
              <input id="monster-gold-max" v-model.number="form.goldMax" type="number" min="0" required />
            </div>
          </div>

          <!-- Drops section -->
          <div class="form-section">
            <div class="section-header">
              <h3>Drops</h3>
              <button type="button" class="btn btn-small" @click="addDrop">Add Drop</button>
            </div>
            <div v-for="(drop, index) in form.drops" :key="index" class="drop-row">
              <select v-model="drop.itemId">
                <option value="">-- Select Item --</option>
                <option v-for="item in itemList" :key="item.id" :value="item.id">
                  {{ item.name }} ({{ item.id }})
                </option>
              </select>
              <input
                v-model.number="drop.chance"
                type="number"
                min="0"
                max="1"
                step="0.01"
                placeholder="Chance"
              />
              <button type="button" class="btn btn-danger btn-small" @click="removeDrop(index)">X</button>
            </div>
            <p v-if="form.drops.length === 0" class="empty-note">No drops configured.</p>
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
import { useMonsters } from '../composables/useMonsters';
import { useItems } from '../composables/useItems';
import { nextId } from '../utils/nextId';
import type { MonsterDefinition, ItemDrop, ItemDefinition } from '@idle-party-rpg/shared';

const monsters = useMonsters();
const items = useItems();

const selectedId = ref<string | null>(null);
const isNew = ref(true);

const form = reactive({
  id: '',
  name: '',
  level: 1,
  hp: 10,
  damage: 1,
  xp: 5,
  goldMin: 0,
  goldMax: 1,
  drops: [] as { itemId: string; chance: number }[],
});

const monsterList = computed(() => {
  return Object.values(monsters.data) as MonsterDefinition[];
});

const itemList = computed(() => {
  return Object.values(items.data) as ItemDefinition[];
});

function selectMonster(monster: MonsterDefinition) {
  selectedId.value = monster.id;
  isNew.value = false;
  form.id = monster.id;
  form.name = monster.name;
  form.level = monster.level;
  form.hp = monster.hp;
  form.damage = monster.damage;
  form.xp = monster.xp;
  form.goldMin = monster.goldMin;
  form.goldMax = monster.goldMax;
  form.drops = (monster.drops ?? []).map(d => ({ ...d }));
}

function resetForm() {
  selectedId.value = null;
  isNew.value = true;
  form.id = nextId(Object.keys(monsters.data));
  form.name = '';
  form.level = 1;
  form.hp = 10;
  form.damage = 1;
  form.xp = 5;
  form.goldMin = 0;
  form.goldMax = 1;
  form.drops = [];
}

function addDrop() {
  form.drops.push({ itemId: '', chance: 0.1 });
}

function removeDrop(index: number) {
  form.drops.splice(index, 1);
}

async function handleSave() {
  const monsterData: MonsterDefinition = {
    id: form.id,
    name: form.name,
    level: form.level,
    hp: form.hp,
    damage: form.damage,
    xp: form.xp,
    goldMin: form.goldMin,
    goldMax: form.goldMax,
    drops: form.drops.filter(d => d.itemId) as ItemDrop[],
  };

  if (isNew.value) {
    await monsters.create(monsterData);
  } else {
    await monsters.save(monsterData);
  }

  selectedId.value = monsterData.id;
  isNew.value = false;
}

async function handleDelete() {
  if (!selectedId.value) return;
  if (!window.confirm(`Delete monster "${selectedId.value}"?`)) return;
  await monsters.remove(selectedId.value);
  resetForm();
}

onMounted(async () => {
  await Promise.all([monsters.load(), items.load()]);
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

.drop-row {
  display: grid;
  grid-template-columns: 1fr 80px 32px;
  gap: 8px;
  margin-bottom: 8px;
  align-items: center;
}

.drop-row select,
.drop-row input {
  padding: 6px 8px;
  background: var(--input-bg, #181825);
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  color: var(--text-color, #cdd6f4);
  font-size: 13px;
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
