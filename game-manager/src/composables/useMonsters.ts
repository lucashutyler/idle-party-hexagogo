import { ref } from 'vue';
import { adminApi } from '../api/adminClient';
import type { MonsterDefinition } from '@idle-party-rpg/shared';

export function useMonsters() {
  const data = ref<Record<string, MonsterDefinition>>({});
  const loading = ref(false);
  const error = ref<string | null>(null);

  async function load() {
    loading.value = true;
    error.value = null;
    try {
      data.value = await adminApi.getMonsters();
    } catch (e) {
      error.value = (e as Error).message;
    } finally {
      loading.value = false;
    }
  }

  async function save(monster: MonsterDefinition) {
    try {
      await adminApi.updateMonster(monster.id, monster);
      data.value[monster.id] = monster;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function create(monster: MonsterDefinition) {
    try {
      await adminApi.createMonster(monster);
      data.value[monster.id] = monster;
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  async function remove(id: string) {
    try {
      await adminApi.deleteMonster(id);
      delete data.value[id];
    } catch (e) {
      error.value = (e as Error).message;
    }
  }

  return { data, loading, error, load, save, create, remove };
}
