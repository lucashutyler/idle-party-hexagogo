import { ref } from 'vue';
import { adminApi } from '../api/adminClient';
import type { MapDefinition } from '@idle-party-rpg/shared';
import type { MapListEntry } from '../api/adminClient';

export function useMaps() {
  const maps = ref<MapListEntry[]>([]);
  const currentMap = ref<MapDefinition | null>(null);
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function loadList() {
    loading.value = true;
    error.value = null;
    try {
      maps.value = await adminApi.getMaps();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function loadMap(id: string) {
    loading.value = true;
    error.value = null;
    try {
      currentMap.value = await adminApi.getMap(id);
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(map: MapDefinition) {
    try {
      await adminApi.updateMap(map.id, map);
      currentMap.value = map;
      const idx = maps.value.findIndex(m => m.id === map.id);
      if (idx >= 0) {
        maps.value[idx] = {
          id: map.id,
          name: map.name,
          type: map.type,
          tileCount: map.tiles.length,
        };
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function create(map: MapDefinition) {
    try {
      await adminApi.createMap(map);
      maps.value.push({
        id: map.id,
        name: map.name,
        type: map.type,
        tileCount: map.tiles.length,
      });
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function remove(id: string) {
    try {
      await adminApi.deleteMap(id);
      maps.value = maps.value.filter(m => m.id !== id);
      if (currentMap.value?.id === id) {
        currentMap.value = null;
      }
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  return { maps, currentMap, loading, error, loadList, loadMap, save, create, remove };
}
