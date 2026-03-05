<template>
  <div class="editor-page">
    <h1>Items</h1>

    <p v-if="items.error" class="error">{{ items.error }}</p>

    <div class="two-panel">
      <!-- Left panel: table -->
      <div class="panel-left">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Rarity</th>
              <th>Slot</th>
              <th>Attack</th>
              <th>Defense</th>
              <th>Dodge</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in itemList"
              :key="item.id"
              :class="{ selected: selectedId === item.id }"
              @click="selectItem(item)"
            >
              <td>{{ item.id }}</td>
              <td>{{ item.name }}</td>
              <td>{{ item.rarity }}</td>
              <td>{{ item.equipSlot ?? '-' }}</td>
              <td>{{ formatAttack(item) }}</td>
              <td>{{ formatDefense(item) }}</td>
              <td>{{ formatDodge(item) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="items.loading" class="loading">Loading...</p>
      </div>

      <!-- Right panel: editor form -->
      <div class="panel-right">
        <div class="form-header">
          <h2>{{ isNew ? 'New Item' : 'Edit Item' }}</h2>
          <button class="btn btn-secondary" @click="resetForm">New Item</button>
        </div>

        <form @submit.prevent="handleSave">
          <div class="form-group">
            <label for="item-id">ID</label>
            <input
              id="item-id"
              :value="form.id"
              type="text"
              readonly
              class="readonly"
            />
          </div>

          <div class="form-group">
            <label for="item-name">Name</label>
            <input id="item-name" v-model="form.name" type="text" required />
          </div>

          <div class="form-row">
            <div class="form-group">
              <label for="item-rarity">Rarity</label>
              <select id="item-rarity" v-model="form.rarity">
                <option value="janky">janky</option>
                <option value="common">common</option>
              </select>
            </div>
            <div class="form-group">
              <label for="item-slot">Equip Slot</label>
              <select id="item-slot" v-model="form.equipSlot">
                <option value="">none</option>
                <option value="head">head</option>
                <option value="chest">chest</option>
                <option value="hand">hand</option>
                <option value="foot">foot</option>
              </select>
            </div>
          </div>

          <!-- Conditional: Attack fields for 'hand' slot -->
          <template v-if="form.equipSlot === 'hand'">
            <div class="form-row">
              <div class="form-group">
                <label for="item-atk-min">Bonus Attack Min</label>
                <input id="item-atk-min" v-model.number="form.bonusAttackMin" type="number" min="0" />
              </div>
              <div class="form-group">
                <label for="item-atk-max">Bonus Attack Max</label>
                <input id="item-atk-max" v-model.number="form.bonusAttackMax" type="number" min="0" />
              </div>
            </div>
          </template>

          <!-- Conditional: Defense fields for 'head', 'chest', 'foot' -->
          <template v-if="form.equipSlot === 'head' || form.equipSlot === 'chest' || form.equipSlot === 'foot'">
            <div class="form-row">
              <div class="form-group">
                <label for="item-def-min">Damage Reduction Min</label>
                <input id="item-def-min" v-model.number="form.damageReductionMin" type="number" min="0" />
              </div>
              <div class="form-group">
                <label for="item-def-max">Damage Reduction Max</label>
                <input id="item-def-max" v-model.number="form.damageReductionMax" type="number" min="0" />
              </div>
            </div>
          </template>

          <!-- Conditional: Dodge for 'foot' -->
          <template v-if="form.equipSlot === 'foot'">
            <div class="form-group">
              <label for="item-dodge">Dodge Chance</label>
              <input id="item-dodge" v-model.number="form.dodgeChance" type="number" min="0" max="1" step="0.01" />
            </div>
          </template>

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
import { useItems } from '../composables/useItems';
import { nextId } from '../utils/nextId';
import type { ItemDefinition, EquipSlot } from '@idle-party-rpg/shared';

const items = useItems();

const selectedId = ref<string | null>(null);
const isNew = ref(true);

const form = reactive({
  id: '',
  name: '',
  rarity: 'janky' as 'janky' | 'common',
  equipSlot: '' as string,
  bonusAttackMin: 0,
  bonusAttackMax: 0,
  damageReductionMin: 0,
  damageReductionMax: 0,
  dodgeChance: 0,
});

const itemList = computed(() => {
  return Object.values(items.data) as ItemDefinition[];
});

function formatAttack(item: ItemDefinition): string {
  if (item.bonusAttackMin != null && item.bonusAttackMax != null && item.bonusAttackMax > 0) {
    return `${item.bonusAttackMin}-${item.bonusAttackMax}`;
  }
  return '-';
}

function formatDefense(item: ItemDefinition): string {
  if (item.damageReductionMin != null && item.damageReductionMax != null && item.damageReductionMax > 0) {
    return `${item.damageReductionMin}-${item.damageReductionMax}`;
  }
  return '-';
}

function formatDodge(item: ItemDefinition): string {
  if (item.dodgeChance != null && item.dodgeChance > 0) {
    return `${Math.round(item.dodgeChance * 100)}%`;
  }
  return '-';
}

function selectItem(item: ItemDefinition) {
  selectedId.value = item.id;
  isNew.value = false;
  form.id = item.id;
  form.name = item.name;
  form.rarity = item.rarity;
  form.equipSlot = item.equipSlot ?? '';
  form.bonusAttackMin = item.bonusAttackMin ?? 0;
  form.bonusAttackMax = item.bonusAttackMax ?? 0;
  form.damageReductionMin = item.damageReductionMin ?? 0;
  form.damageReductionMax = item.damageReductionMax ?? 0;
  form.dodgeChance = item.dodgeChance ?? 0;
}

function resetForm() {
  selectedId.value = null;
  isNew.value = true;
  form.id = nextId(Object.keys(items.data));
  form.name = '';
  form.rarity = 'janky';
  form.equipSlot = '';
  form.bonusAttackMin = 0;
  form.bonusAttackMax = 0;
  form.damageReductionMin = 0;
  form.damageReductionMax = 0;
  form.dodgeChance = 0;
}

async function handleSave() {
  const itemData: ItemDefinition = {
    id: form.id,
    name: form.name,
    rarity: form.rarity,
  };

  if (form.equipSlot) {
    itemData.equipSlot = form.equipSlot as EquipSlot;
  }

  if (form.equipSlot === 'hand') {
    itemData.bonusAttackMin = form.bonusAttackMin;
    itemData.bonusAttackMax = form.bonusAttackMax;
  }

  if (form.equipSlot === 'head' || form.equipSlot === 'chest' || form.equipSlot === 'foot') {
    itemData.damageReductionMin = form.damageReductionMin;
    itemData.damageReductionMax = form.damageReductionMax;
  }

  if (form.equipSlot === 'foot') {
    itemData.dodgeChance = form.dodgeChance;
  }

  if (isNew.value) {
    await items.create(itemData);
  } else {
    await items.save(itemData);
  }

  selectedId.value = itemData.id;
  isNew.value = false;
}

async function handleDelete() {
  if (!selectedId.value) return;
  if (!window.confirm(`Delete item "${selectedId.value}"?`)) return;
  await items.remove(selectedId.value);
  resetForm();
}

onMounted(() => {
  items.load();
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
