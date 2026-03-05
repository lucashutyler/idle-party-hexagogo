import { ref } from 'vue';
import { adminApi } from '../api/adminClient';
import type { ZoneDefinition } from '@idle-party-rpg/shared';

export function useZones() {
  const data = ref<Record<string, ZoneDefinition>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      data.value = await adminApi.getZones();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(zone: ZoneDefinition) {
    try {
      await adminApi.updateZone(zone.id, zone);
      data.value[zone.id] = zone;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function create(zone: ZoneDefinition) {
    try {
      await adminApi.createZone(zone);
      data.value[zone.id] = zone;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function remove(id: string) {
    try {
      await adminApi.deleteZone(id);
      delete data.value[id];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  return { data, loading, error, load, save, create, remove };
}
