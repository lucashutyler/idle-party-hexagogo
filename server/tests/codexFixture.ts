import { expect, vi } from 'vitest';
import WebSocket from 'ws';
import { DEFAULT_MAP_ID, HexGrid, HexTile, codexTableKey, isTileTraversable, offsetToCube } from '@idle-party-rpg/shared';
import type {
  DungeonDefinition,
  EncounterDefinition,
  HenchmanDefinition,
  ItemDefinition,
  MonsterDefinition,
  NpcDefinition,
  QuestDefinition,
  RecipeDefinition,
  ServerCodexMessage,
  ShopDefinition,
  TileTypeDefinition,
  WorldTileDefinition,
  ZoneDefinition,
} from '@idle-party-rpg/shared';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { Account, AccountStore } from '../src/auth/AccountStore.js';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { CodexKnowledge } from '../src/game/codex/CodexKnowledge.js';
import { codexContentIndex } from '../src/game/codex/CodexBuild.js';
import type { CodexContent } from '../src/game/codex/CodexBuild.js';
import { recapContent, room } from './recapFixture.js';
import { wrapGrids } from './testGrids.js';

/** Invented content for the Codex tests: a meadow with a mill shop, a bear den with its own table, a cave dungeon. */
export interface CodexWorld {
  tiles: WorldTileDefinition[];
  tileTypes: Record<string, TileTypeDefinition>;
  zones: Record<string, ZoneDefinition>;
  encounters: Record<string, EncounterDefinition>;
  monsters: Record<string, MonsterDefinition>;
  items: Record<string, ItemDefinition>;
  shops: Record<string, ShopDefinition>;
  henchmen: Record<string, HenchmanDefinition>;
  dungeons: Record<string, DungeonDefinition>;
  quests: Record<string, QuestDefinition>;
  npcs: Record<string, NpcDefinition>;
  recipes: Record<string, RecipeDefinition>;
}

export type CodexTestContent = ContentStore & { contentEpoch: number };

const monster = (id: string, name: string, extra: Partial<MonsterDefinition> = {}): MonsterDefinition =>
  ({ id, name, hp: 10, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0, ...extra });

const item = (id: string, name: string, extra: Partial<ItemDefinition> = {}): ItemDefinition => ({ id, name, rarity: 'common', ...extra });

export function codexWorld(): CodexWorld {
  return {
    tiles: [
      room('field', 0, 0, { name: 'Barley Field', npcId: 'miller' }),
      room('mill', 1, 0, { name: 'Old Mill', shopId: 'mill_post' }),
      room('den', 2, 0, { name: 'Bear Den', encounterTable: [{ encounterId: 'bears', weight: 1 }] }),
      room('gate', 0, 1, { name: 'Cave Mouth', dungeonId: 'damp_cave', shopId: 'gate_stall' }),
      room('pond', 3, 0, { name: 'Still Pond', type: 'water', zone: 'marsh' }),
      room('ridge', 6, 6, { name: 'Pine Ridge', zone: 'pines' }),
    ],
    tileTypes: {
      plains: { id: 'plains', name: 'Plains', icon: '', color: '#7ec850', traversable: true },
      water: { id: 'water', name: 'Water', icon: '', color: '#3070c0', traversable: false },
    },
    zones: {
      meadow: { id: 'meadow', displayName: 'Gull Meadow', encounterTable: [{ encounterId: 'goblins', weight: 3 }, { encounterId: 'wolves', weight: 1 }, { encounterId: 'ghosts', weight: 0 }], levelRange: [1, 3] },
      pines: { id: 'pines', displayName: 'Pinefold', encounterTable: [{ encounterId: 'camp', weight: 1 }], levelRange: [4, 6] },
      marsh: { id: 'marsh', displayName: 'Marsh', encounterTable: [{ encounterId: 'toads', weight: 1 }], levelRange: [2, 3] },
    },
    encounters: {
      goblins: { id: 'goblins', name: 'Goblin Gang', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 2 }] },
      wolves: { id: 'wolves', name: 'Wolf Pack', type: 'random', monsterPool: [{ monsterId: 'wolf', min: 1, max: 2 }] },
      bears: { id: 'bears', name: 'Bear Lair', type: 'explicit', placements: [{ monsterId: 'bear', gridPosition: 4 }] },
      camp: { id: 'camp', name: 'Goblin Camp', type: 'random', monsterPool: [{ monsterId: 'goblin', min: 1, max: 1 }, { monsterId: 'shaman', min: 0, max: 1 }] },
      toads: { id: 'toads', name: 'Toad Chorus', type: 'random', monsterPool: [{ monsterId: 'toad', min: 1, max: 1 }] },
      ghosts: { id: 'ghosts', name: 'Ghost Walk', type: 'random', monsterPool: [{ monsterId: 'ghost', min: 1, max: 1 }] },
      cave_bats: { id: 'cave_bats', name: 'Bat Swarm', type: 'random', monsterPool: [{ monsterId: 'bat', min: 1, max: 2 }] },
      boss_room: { id: 'boss_room', name: 'Cave Throne', type: 'explicit', placements: [{ monsterId: 'cave_boss', gridPosition: 4 }, { monsterId: 'bat', gridPosition: 1 }] },
    },
    monsters: {
      goblin: monster('goblin', 'Goblin', { drops: [{ itemId: 'ear', chance: 0.5 }] }),
      wolf: monster('wolf', 'Wolf', { drops: [{ itemId: 'pelt', chance: 0.5 }, { itemId: 'fang', chance: 0.2 }, { itemId: 'pelt', chance: 0.1 }, { itemId: 'never', chance: 0 }, { itemId: 'lost_item', chance: 0.5 }] }),
      bear: monster('bear', 'Bear', { level: 7, drops: [{ itemId: 'pelt', chance: 0.3 }] }),
      shaman: monster('shaman', 'Goblin Shaman'),
      toad: monster('toad', 'Toad'),
      ghost: monster('ghost', 'Ghost'),
      bat: monster('bat', 'Cave Bat'),
      cave_boss: monster('cave_boss', 'Cave King', { tier: 'boss', level: 250, description: 'Rules the damp dark.' }),
      wall: monster('wall', 'Old Wall', { passive: true }),
      ghoul: monster('ghoul', 'Ghoul', { drops: [{ itemId: 'charm', chance: 0.5 }] }),
    },
    items: {
      ear: item('ear', 'Goblin Ear', { rarity: 'common' }),
      pelt: item('pelt', 'Wolf Pelt', { rarity: 'common' }),
      fang: item('fang', 'Wolf Fang', { rarity: 'uncommon' }),
      never: item('never', 'Never Seen'),
      rope: item('rope', 'Rope'),
      lamp: item('lamp', 'Lamp'),
      gem: item('gem', 'Cave Gem', { rarity: 'rare' }),
      crown: item('crown', 'Cave Crown', { rarity: 'epic' }),
      sword: item('sword', 'Mill Sword'),
      charm: item('charm', 'Holy Charm', { classRestriction: ['Priest'] }),
      herb: item('herb', 'Herb'),
      tonic: item('tonic', 'Tonic'),
    },
    shops: {
      mill_post: { id: 'mill_post', name: 'Mill Trading Post', inventory: [{ itemId: 'pelt', price: 5 }, { itemId: 'rope', price: 2 }, { itemId: 'lost_item', price: 3 }], henchmanIds: ['grim', 'missing_hire'] },
      gate_stall: { id: 'gate_stall', name: 'Cave Stall', inventory: [{ itemId: 'lamp', price: 4 }] },
    },
    henchmen: {
      grim: { id: 'grim', name: 'Grim', className: 'Knight', level: 8, maxHp: 80, baseDamage: 6, skillIds: [], emoji: '🗡️' },
    },
    dungeons: {
      damp_cave: {
        id: 'damp_cave',
        name: 'Damp Cave',
        floors: [
          { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'cave_bats', weight: 1 }], rewards: [{ itemId: 'gem', chance: 1 }] },
          { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'boss_room', weight: 1 }], isBoss: true },
        ],
        firstClearRewards: [{ itemId: 'crown', chance: 1 }],
      },
    },
    quests: {
      delivery: {
        id: 'delivery', name: 'Mill Delivery', description: '', scope: 'solo',
        objectives: [{ kind: 'kill', monsterId: 'goblin', count: 1 }],
        rewards: [{ kind: 'item', itemId: 'sword', quantity: 1 }, { kind: 'gold', amount: 3 }],
      },
    },
    npcs: {
      miller: { id: 'miller', name: 'Miller', emoji: '🧑‍🌾', greeting: 'Hello.', questIds: ['delivery'] },
    },
    recipes: {
      brew: { id: 'brew', name: 'Brew Tonic', durationSeconds: 10, ingredients: [{ itemId: 'herb', quantity: 1 }], result: { itemId: 'tonic', quantity: 1 } },
    },
  };
}

/** A content store over `world`'s records; edit a record, then bump `contentEpoch`. */
export function codexContent(world: CodexWorld = codexWorld()): CodexTestContent {
  const base = recapContent({
    tiles: world.tiles,
    tileTypes: world.tileTypes,
    zones: world.zones,
    encounters: world.encounters,
    monsters: world.monsters,
    items: world.items,
    quests: world.quests,
    npcs: world.npcs,
    recipes: world.recipes,
  });
  return Object.assign(base, {
    getTileType: (id: string) => world.tileTypes[id],
    getShop: (id: string) => world.shops[id],
    getAllShops: () => world.shops,
    getHenchman: (id: string) => world.henchmen[id],
    getAllHenchmen: () => world.henchmen,
    getDungeon: (id: string) => world.dungeons[id],
    getAllDungeons: () => world.dungeons,
  }) as CodexTestContent;
}

export function codexGrid(content: ContentStore): HexGrid {
  const grid = new HexGrid();
  const tileTypes = content.getAllTileTypes();
  for (const t of content.getWorld().tiles) {
    if (t.mapId !== DEFAULT_MAP_ID) continue;
    grid.addTile(new HexTile(offsetToCube({ col: t.col, row: t.row }), t.type, t.zone, t.id, t.requiredItemId, tileTypes[t.type], t.entryRequirements));
  }
  return grid;
}

function fakeAccounts(usernames: string[]): AccountStore {
  const accounts = Object.fromEntries(usernames.map(username => [username, { username } as Account]));
  return {
    findByUsername: (name: string) => accounts[name] ?? null,
    getAllUsernames: () => usernames,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
}

export function memoryPlayerStore(): GameStateStore & { saves: Map<string, PlayerSaveData> } {
  const saves = new Map<string, PlayerSaveData>();
  return {
    saves,
    save: async (data: PlayerSaveData) => { saves.set(data.username, data); },
    saveAll: async (all: PlayerSaveData[]) => { for (const data of all) saves.set(data.username, data); },
    load: async (username: string) => saves.get(username) ?? null,
    loadAll: async () => [...saves.values()],
    delete: async (username: string) => { saves.delete(username); },
  };
}

export type FakeSocket = WebSocket & { send: ReturnType<typeof vi.fn>; bufferedAmount: number };

export function fakeSocket(): FakeSocket {
  return { readyState: WebSocket.OPEN, send: vi.fn(), on: vi.fn(), close: vi.fn(), bufferedAmount: 0 } as unknown as FakeSocket;
}

export function codexManager(
  content: ContentStore,
  usernames: string[],
  store: GameStateStore = memoryPlayerStore(),
): { pm: PlayerManager; grid: HexGrid; hex: (tileId: string) => HexTile } {
  const grid = codexGrid(content);
  const pm = new PlayerManager(wrapGrids(grid), content, new GuildStore(), fakeAccounts(usernames), store);
  const hex = (tileId: string): HexTile => {
    const t = content.getTileById(tileId)!;
    return grid.getTile(offsetToCube({ col: t.col, row: t.row }))!;
  };
  return { pm, grid, hex };
}

/** Fails when the reply holds any id the player has not discovered, any fact they have not earned, or any encounter id or name. */
export function expectOnlyDiscovered(
  reply: ServerCodexMessage,
  knowledge: CodexKnowledge,
  content: CodexContent,
  unlocked: readonly string[],
  kills: Readonly<Record<string, number>> = {},
): void {
  const shopStock = new Set(knowledge.shopIds().flatMap(id => content.getShop(id)?.inventory.map(line => line.itemId) ?? []));
  const monsterIds = [
    ...reply.monsters.map(m => m.id),
    ...reply.tables.flatMap(t => t.monsters),
    ...reply.fights.flat(),
    ...reply.dungeons.flatMap(d => d.monsters),
    ...reply.recent.filter(r => r.kind === 'monster').map(r => r.id),
  ];
  for (const id of monsterIds) expect(knowledge.hasMonster(id), `monster ${id}`).toBe(true);

  for (const { def, found } of reply.items) {
    expect(found ? knowledge.hasItem(def.id) : shopStock.has(def.id), `item ${def.id}`).toBe(true);
  }
  const heldItemIds = [...reply.monsters.flatMap(m => m.drops.map(d => d.itemId)), ...reply.recent.filter(r => r.kind === 'item').map(r => r.id)];
  for (const id of heldItemIds) expect(knowledge.hasItem(id), `held item ${id}`).toBe(true);
  for (const shop of reply.shops) for (const line of shop.stock) expect(shopStock.has(line.itemId)).toBe(true);

  for (const id of [...reply.shops.map(s => s.id), ...reply.recent.filter(r => r.kind === 'shop').map(r => r.id)]) {
    expect(knowledge.hasShop(id), `shop ${id}`).toBe(true);
  }
  for (const dungeon of reply.dungeons) expect(knowledge.hasDungeon(dungeon.id), `dungeon ${dungeon.id}`).toBe(true);

  const tiles = new Map(content.getWorld().tiles.map(t => [t.id, t]));
  const found = unlocked
    .map(id => tiles.get(id))
    .filter((t): t is WorldTileDefinition => !!t && isTileTraversable(t.type, content.getTileType(t.type)));
  const foundKeys = new Set(found.map(codexTableKey));
  const index = codexContentIndex(content);
  const fought = new Set(knowledge.encounterIds());
  const sameFight = (a: readonly string[], b: readonly string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  for (const table of reply.tables) {
    expect(foundKeys.has(table.key), `table ${table.key}`).toBe(true);
    const spawns = index.tables.get(table.key)?.spawns ?? [];
    for (const id of table.monsters) expect(spawns.includes(id), `table ${table.key} spawns ${id}`).toBe(true);
    const earned = (index.tables.get(table.key)?.encounters ?? [])
      .filter(encounterId => fought.has(encounterId))
      .map(encounterId => (index.encounterMonsters.get(encounterId) ?? []).filter(id => knowledge.hasMonster(id)))
      .filter(fight => fight.length > 0);
    for (const at of table.fights) {
      const fight = reply.fights[at];
      expect(fight, `table ${table.key} fight ${at}`).toBeDefined();
      expect(earned.some(line => sameFight(line, fight)), `table ${table.key} fight ${JSON.stringify(fight)}`).toBe(true);
    }
  }
  for (const dungeon of reply.dungeons) {
    const spawns = index.dungeonSpawns.get(dungeon.id) ?? [];
    for (const id of dungeon.monsters) expect(spawns.includes(id), `dungeon ${dungeon.id} spawns ${id}`).toBe(true);
  }
  for (const m of reply.monsters) {
    expect(m.kills, `kills of ${m.id}`).toBe(Object.prototype.hasOwnProperty.call(kills, m.id) ? kills[m.id] : 0);
    for (const d of m.drops) expect(knowledge.dropsOf(m.id).get(d.itemId), `drop ${m.id} -> ${d.itemId}`).toBe(d.seen);
  }

  const json = JSON.stringify(reply);
  for (const encounter of Object.values(content.getAllEncounters()) as EncounterDefinition[]) {
    expect(json.includes(`"${encounter.id}"`), `encounter id ${encounter.id}`).toBe(false);
    expect(json.includes(encounter.name), `encounter name ${encounter.name}`).toBe(false);
  }
}
