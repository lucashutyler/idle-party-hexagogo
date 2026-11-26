import { vi } from 'vitest';
import type { ItemDefinition, ServerCodexMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import { WorldCache } from '../src/network/WorldCache';

/** An invented two-map world for the Codex tests. */

const room = (id: string, mapId: string, col: number, row: number, zone: string, zoneName: string, name: string, extra: Record<string, unknown> = {}) =>
  ({ id, mapId, col, row, type: 'plains', zone, zoneName, name, ...extra });

export const CODEX_WORLD = {
  startTile: { col: 0, row: 0 },
  maps: [
    { id: 'gull', name: 'Gull Isle', startTile: { col: 0, row: 0 } },
    { id: 'cave', name: 'Damp Cave', startTile: { col: 0, row: 0 } },
  ],
  tiles: [
    room('g_dock', 'gull', 0, 0, 'shore', 'Shore', 'Dock', {
      shopId: 'mill_post',
      npcId: 'old_wren',
      transitions: [{ mapId: 'cave', tileId: 'c_mouth' }, { mapId: 'gull', tileId: 'g_secret' }],
    }),
    room('g_field', 'gull', 1, 0, 'shore', 'Shore', 'Field', { levels: [3, 4] }),
    room('g_wood', 'gull', 2, 0, 'pinefold', 'Pinefold', 'Wood', {
      encounterTable: [{ encounterId: 'enc_wolves', weight: 1 }],
      dungeonId: 'damp_trial',
      levels: [20, 22],
    }),
    room('g_lake', 'gull', 3, 0, 'shore', 'Shore', 'Lake', { type: 'water' }),
    room('g_far', 'gull', 5, 0, 'pinefold', 'Pinefold', 'Far Glade', { shopId: 'tannery' }),
    room('g_secret', 'gull', 6, 0, 'pinefold', 'Pinefold', 'Hidden Hollow'),
    room('c_mouth', 'cave', 0, 0, 'cave', 'Damp Cave', 'Cave Mouth'),
  ],
  tileTypes: {
    plains: { id: 'plains', name: 'Plains', icon: '', color: '#00ff00', traversable: true },
    water: { id: 'water', name: 'Water', icon: '', color: '#0000ff', traversable: false },
  },
  shops: {
    mill_post: { id: 'mill_post', name: 'Mill Trading Post', sellsItems: true, hiresHenchmen: true },
    tannery: { id: 'tannery', name: 'Tannery', sellsItems: true, hiresHenchmen: false },
  },
};

const NPCS = { npcs: { old_wren: { id: 'old_wren', name: 'Old Wren', emoji: '🧓', greeting: 'Hello.' } } };

const DUNGEONS = {
  dungeons: {
    damp_trial: {
      id: 'damp_trial',
      name: 'Damp Trial',
      floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'enc_wolves', weight: 1 }], rewards: [{ itemId: 'fang', chance: 0.5 }] }],
      firstClearRewards: [{ itemId: 'cloak', chance: 1 }],
    },
  },
};

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

export async function loadCodexWorld(world: unknown = CODEX_WORLD): Promise<WorldCache> {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/world') return json(world);
    if (url === '/api/npcs') return json(NPCS);
    if (url === '/api/dungeons') return json(DUNGEONS);
    return json({});
  }));
  const cache = new WorldCache();
  await cache.loadWorld();
  return cache;
}

const item = (id: string, name: string, extra: Partial<ItemDefinition> = {}): ItemDefinition =>
  ({ id, name, rarity: 'common', ...extra });

export const ITEMS = {
  pelt: item('pelt', 'Wolf Pelt'),
  fang: item('fang', 'Sharp Fang', { rarity: 'rare' }),
  rope: item('rope', 'Rope'),
  potion: item('potion', 'Potion', { consumable: true }),
  blade: item('blade', 'Old Blade', { equipSlot: 'mainhand', rarity: 'uncommon' }),
  thread: item('thread', 'Thread'),
  cloak: item('cloak', 'Pelt Cloak', { equipSlot: 'back' }),
};

export function codexReply(overrides: Partial<ServerCodexMessage> = {}): ServerCodexMessage {
  return {
    type: 'codex',
    version: 'v1',
    monsters: [
      { id: 'goblin', name: 'Goblin', level: 3, tier: 'trash', kills: 12, drops: [{ itemId: 'fang', seen: 9 }, { itemId: 'pelt', seen: 4 }], dropKinds: 3 },
      { id: 'wolf', name: 'Wolf', tier: 'elite', description: 'A grey wolf.', kills: 0, drops: [], dropKinds: 2 },
      { id: 'wall', name: 'Stone Wall', tier: 'trash', passive: true, kills: 0, drops: [], dropKinds: 0 },
    ],
    items: [
      { def: ITEMS.pelt, found: true },
      { def: ITEMS.fang, found: true },
      { def: ITEMS.rope, found: false },
    ],
    shops: [{
      id: 'mill_post',
      name: 'Mill Trading Post',
      stock: [{ itemId: 'rope', price: 40 }, { itemId: 'pelt', price: 12 }],
      hires: [{ name: 'Brin', emoji: '🛡️', level: 8 }],
    }],
    fights: [['goblin'], ['goblin', 'wolf']],
    tables: [
      { key: 'z:shore', monsters: ['goblin'], fights: [0] },
      { key: 'r:g_wood', monsters: ['wolf', 'goblin'], fights: [1] },
      { key: 'z:pinefold', monsters: ['wolf'], fights: [] },
    ],
    dungeons: [{ id: 'damp_trial', monsters: ['wolf'] }],
    recent: [
      { kind: 'monster', id: 'wolf' },
      { kind: 'item', id: 'fang' },
      { kind: 'shop', id: 'mill_post' },
      { kind: 'monster', id: 'ghost' },
    ],
    ...overrides,
  };
}

export function codexState(overrides: Partial<ServerStateMessage> & Record<string, unknown> = {}): ServerStateMessage {
  return {
    type: 'state',
    username: 'me',
    currentMapId: 'gull',
    party: { col: 1, row: 0, state: 'idle', path: [] },
    unlocked: ['g_dock', 'g_field', 'g_wood', 'g_lake', 'g_far', 'c_mouth', 'gone'],
    character: {
      className: 'Knight',
      level: 4,
      inventory: { pelt: 3, potion: 1 },
      equipment: { mainhand: 'blade', head: null },
      mastery: { discovered: 2, mastered: 0, version: 1, recent: [{ monsterId: 'goblin', name: 'Goblin', kills: 15, rank: 0, maxRank: 5, nextAt: 25, prevAt: 0, bonusPct: 0 }] },
      codexVersion: 'v1',
    },
    itemDefinitions: { pelt: ITEMS.pelt, potion: ITEMS.potion, blade: ITEMS.blade },
    craftingCatalog: {
      recipes: [{
        id: 'r_cloak',
        name: 'Pelt Cloak',
        durationSeconds: 5,
        requiredLevel: 5,
        ingredients: [{ itemId: 'pelt', quantity: 2 }, { itemId: 'thread', quantity: 1 }],
        result: { itemId: 'cloak', quantity: 1 },
      }],
      itemDefs: { pelt: ITEMS.pelt, thread: ITEMS.thread, cloak: ITEMS.cloak },
    },
    questDefinitions: {
      q1: { id: 'q1', name: 'Fangs for Fern', description: '', scope: 'solo', objectives: [{ kind: 'collect', itemId: 'pelt', count: 2 }], rewards: [{ kind: 'item', itemId: 'fang', quantity: 1 }] },
      q2: { id: 'q2', name: 'Progress: Old Debts', description: '', scope: 'solo', objectives: [], rewards: [{ kind: 'item', itemId: 'fang', quantity: 2 }] },
    },
    activeQuests: [{ questId: 'q1', status: 'in_progress', progress: [1], acceptedAt: '' }],
    completedQuests: [{ questId: 'q2', completedAt: '' }],
    social: null,
    ...overrides,
  } as unknown as ServerStateMessage;
}
