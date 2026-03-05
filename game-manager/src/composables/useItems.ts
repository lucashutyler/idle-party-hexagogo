import { ref } from 'vue';
import { adminApi } from '../api/adminClient';
import type { ItemDefinition } from '@idle-party-rpg/shared';

export function useItems() {
  const items = ref<Record<string, ItemDefinition>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      items.value = await adminApi.getItems();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(item: ItemDefinition) {
    try {
      await adminApi.updateItem(item.id, item);
      items.value[item.id] = item;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function create(item: ItemDefinition) {
    try {
      await adminApi.createItem(item);
      items.value[item.id] = item;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function remove(id: string) {
    try {
      await adminApi.deleteItem(id);
      delete items.value[id];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  return { items, loading, error, load, save, create, remove };
}
