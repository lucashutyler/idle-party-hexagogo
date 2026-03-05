import type { MonsterDefinition } from '@idle-party-rpg/shared';
import type { ItemDefinition } from '@idle-party-rpg/shared';
import type { ZoneDefinition } from '@idle-party-rpg/shared';
import type { TileConfig } from '@idle-party-rpg/shared';
import type { MapDefinition } from '@idle-party-rpg/shared';

const BASE = '/admin';

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function post<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function put<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

async function del(path: string): Promise<void> {
  const res = await fetch(`${BASE}${path}`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(await res.text());
}

export interface ServerStats {
  sessions: number;
  connections: number;
  uptime: number;
}

export interface PlayerInfo {
  username: string;
  level: number;
  col: number;
  row: number;
  online: boolean;
}

export interface MapListEntry {
  id: string;
  name: string;
  type: string;
  tileCount: number;
}

export const adminApi = {
  // Monsters
  getMonsters: () => get<Record<string, MonsterDefinition>>('/monsters'),
  saveMonsters: (data: Record<string, MonsterDefinition>) => put<{ success: boolean }>('/monsters', data),
  createMonster: (monster: MonsterDefinition) => post<{ success: boolean }>('/monsters', monster),
  updateMonster: (id: string, monster: MonsterDefinition) => put<{ success: boolean }>(`/monsters/${id}`, monster),
  deleteMonster: (id: string) => del(`/monsters/${id}`),

  // Items
  getItems: () => get<Record<string, ItemDefinition>>('/items'),
  saveItems: (data: Record<string, ItemDefinition>) => put<{ success: boolean }>('/items', data),
  createItem: (item: ItemDefinition) => post<{ success: boolean }>('/items', item),
  updateItem: (id: string, item: ItemDefinition) => put<{ success: boolean }>(`/items/${id}`, item),
  deleteItem: (id: string) => del(`/items/${id}`),

  // Zones
  getZones: () => get<Record<string, ZoneDefinition>>('/zones'),
  saveZones: (data: Record<string, ZoneDefinition>) => put<{ success: boolean }>('/zones', data),
  createZone: (zone: ZoneDefinition) => post<{ success: boolean }>('/zones', zone),
  updateZone: (id: string, zone: ZoneDefinition) => put<{ success: boolean }>(`/zones/${id}`, zone),
  deleteZone: (id: string) => del(`/zones/${id}`),

  // Tile Types
  getTileTypes: () => get<Record<string, TileConfig>>('/tile-types'),
  saveTileTypes: (data: Record<string, TileConfig>) => put<{ success: boolean }>('/tile-types', data),
  createTileType: (tt: TileConfig) => post<{ success: boolean }>('/tile-types', tt),
  updateTileType: (id: string, tt: TileConfig) => put<{ success: boolean }>(`/tile-types/${id}`, tt),
  deleteTileType: (id: string) => del(`/tile-types/${id}`),

  // Maps
  getMaps: () => get<MapListEntry[]>('/maps'),
  getMap: (id: string) => get<MapDefinition>(`/maps/${id}`),
  createMap: (map: MapDefinition) => post<{ success: boolean }>('/maps', map),
  updateMap: (id: string, map: MapDefinition) => put<{ success: boolean }>(`/maps/${id}`, map),
  deleteMap: (id: string) => del(`/maps/${id}`),

  // Server
  getServerStats: () => get<ServerStats>('/server-stats'),
  getPlayers: () => get<PlayerInfo[]>('/players'),
};
