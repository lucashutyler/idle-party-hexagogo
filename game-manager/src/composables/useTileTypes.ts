import { ref } from 'vue';
import { adminApi } from '../api/adminClient';
import type { TileConfig } from '@idle-party-rpg/shared';

export function useTileTypes() {
  const tileTypes = ref<Record<string, TileConfig>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      tileTypes.value = await adminApi.getTileTypes();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(tileType: TileConfig) {
    try {
      await adminApi.updateTileType(tileType.type, tileType);
      tileTypes.value[tileType.type] = tileType;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function create(tileType: TileConfig) {
    try {
      await adminApi.createTileType(tileType);
      tileTypes.value[tileType.type] = tileType;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function remove(id: string) {
    try {
      await adminApi.deleteTileType(id);
      delete tileTypes.value[id];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  return { tileTypes, loading, error, load, save, create, remove };
}
