<template>
  <div class="palette">
    <h3>Tools</h3>
    <div class="tool-buttons">
      <button
        :class="['tool-btn', { active: mode === 'paint' }]"
        @click="$emit('update:mode', 'paint')"
        title="Paint tiles"
      >Paint</button>
      <button
        :class="['tool-btn', { active: mode === 'zone' }]"
        @click="$emit('update:mode', 'zone')"
        title="Paint zones (keep tile type)"
      >Zone</button>
      <button
        :class="['tool-btn', { active: mode === 'erase' }]"
        @click="$emit('update:mode', 'erase')"
        title="Erase tiles"
      >Erase</button>
      <button
        :class="['tool-btn', { active: mode === 'start' }]"
        @click="$emit('update:mode', 'start')"
        title="Set start position"
      >Start</button>
    </div>

    <h3>Tile Type</h3>
    <div class="type-list">
      <div
        v-for="(config, typeId) in tileTypes"
        :key="typeId"
        :class="['type-item', { active: selectedType === typeId }]"
        @click="$emit('update:selectedType', typeId)"
      >
        <span class="type-swatch" :style="{ background: colorToHex(config.color) }"></span>
        <span class="type-name">{{ typeId }}</span>
        <span class="type-info">{{ config.traversable ? '' : 'blocked' }}</span>
      </div>
    </div>

    <h3>Zone</h3>
    <div class="zone-list">
      <div
        v-for="(zone, zoneId) in zones"
        :key="zoneId"
        :class="['zone-item', { active: selectedZone === zoneId }]"
        @click="$emit('update:selectedZone', zoneId as string)"
      >
        <span class="zone-name">{{ zone.displayName }}</span>
        <span class="zone-id">({{ zoneId }})</span>
      </div>
      <input
        type="text"
        class="zone-input"
        placeholder="Custom zone ID..."
        :value="selectedZone"
        @input="$emit('update:selectedZone', ($event.target as HTMLInputElement).value)"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import type { TileConfig, ZoneDefinition } from '@idle-party-rpg/shared';

defineProps<{
  tileTypes: Record<string, TileConfig>;
  zones: Record<string, ZoneDefinition>;
  selectedType: string;
  selectedZone: string;
  mode: 'paint' | 'erase' | 'zone' | 'start';
}>();

defineEmits<{
  (e: 'update:selectedType', type: string): void;
  (e: 'update:selectedZone', zone: string): void;
  (e: 'update:mode', mode: string): void;
}>();

function colorToHex(color: number): string {
  return '#' + color.toString(16).padStart(6, '0');
}
</script>

<style scoped>
.palette {
  padding: 12px;
  background: var(--card-bg, #1e1e2e);
  border-right: 1px solid var(--border-color, #333);
  overflow-y: auto;
  min-width: 200px;
}

.palette h3 {
  margin: 16px 0 8px 0;
  font-size: 12px;
  text-transform: uppercase;
  color: var(--text-muted, #a6adc8);
  letter-spacing: 0.05em;
}

.palette h3:first-child {
  margin-top: 0;
}

.tool-buttons {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 4px;
}

.tool-btn {
  padding: 6px 8px;
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  background: var(--input-bg, #313244);
  color: var(--text-color, #cdd6f4);
  cursor: pointer;
  font-size: 12px;
}

.tool-btn.active {
  background: var(--primary-color, #89b4fa);
  color: #000;
  border-color: var(--primary-color, #89b4fa);
}

.type-list, .zone-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.type-item, .zone-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 13px;
  color: var(--text-color, #cdd6f4);
}

.type-item:hover, .zone-item:hover {
  background: var(--hover-bg, #313244);
}

.type-item.active, .zone-item.active {
  background: var(--primary-color, #89b4fa);
  color: #000;
}

.type-swatch {
  width: 16px;
  height: 16px;
  border-radius: 3px;
  border: 1px solid rgba(255,255,255,0.2);
  flex-shrink: 0;
}

.type-name {
  flex: 1;
}

.type-info {
  font-size: 11px;
  color: var(--text-muted, #a6adc8);
}

.type-item.active .type-info {
  color: rgba(0,0,0,0.5);
}

.zone-name {
  flex: 1;
}

.zone-id {
  font-size: 11px;
  color: var(--text-muted, #a6adc8);
}

.zone-item.active .zone-id {
  color: rgba(0,0,0,0.5);
}

.zone-input {
  margin-top: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border-color, #333);
  border-radius: 4px;
  background: var(--input-bg, #313244);
  color: var(--text-color, #cdd6f4);
  font-size: 12px;
  width: 100%;
  box-sizing: border-box;
}
</style>
