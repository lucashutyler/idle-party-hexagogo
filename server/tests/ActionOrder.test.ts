import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { DEFAULT_MAP_ID, HexGrid, HexTile, MAX_ACTION_ORDER_LENGTH, SEED_SKILLS, offsetToCube } from '@idle-party-rpg/shared';
import type { SkillDefinition, WorldTileDefinition } from '@idle-party-rpg/shared';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import { findContentProblems } from '../src/game/ContentValidation.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import type { ContentSnapshot } from '../src/game/VersionStore.js';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { PlayerSession } from '../src/game/PlayerSession.js';
import { fakeSkillContent, fakeWorldMeta, wrapGrids } from './testGrids.js';

const ATTACK: SkillDefinition = {
  id: 'knight_attack', name: 'Attack', description: '', className: 'Knight', type: 'attack', unlockLevel: 1, sortOrder: -1, charge: 3.6, recovery: 0,
};
const STRIKE: SkillDefinition = {
  id: 'test_strike', name: 'Strike', description: '', className: 'Knight', type: 'active', unlockLevel: 1, sortOrder: 90, charge: 3, recovery: 1,
  activeEffects: [{ kind: 'damage_percent', damagePercent: 1 }],
};
const CLEAVE: SkillDefinition = { ...STRIKE, id: 'test_cleave', name: 'Cleave' };
const BLOCK: SkillDefinition = {
  ...STRIKE, id: 'test_block', name: 'Block', trigger: 'self_hit', activeEffects: [{ kind: 'brace_reflect', reflectPercent: 0.1 }],
};
const FAR_OFF: SkillDefinition = { ...STRIKE, id: 'test_far_off', unlockLevel: 50 };
const MAGE_ATTACK: SkillDefinition = { ...ATTACK, id: 'mage_attack', className: 'Mage' };
const ARCHER_ATTACK: SkillDefinition = { ...ATTACK, id: 'archer_attack', className: 'Archer' };
const MAGE_ZAP: SkillDefinition = { ...STRIKE, id: 'test_zap', className: 'Mage' };

const SKILLS: Record<string, SkillDefinition> = {
  ...SEED_SKILLS, knight_attack: ATTACK, mage_attack: MAGE_ATTACK, archer_attack: ARCHER_ATTACK,
  test_strike: STRIKE, test_cleave: CLEAVE, test_block: BLOCK, test_far_off: FAR_OFF, test_zap: MAGE_ZAP,
};

function contentStore(): ContentStore {
  const tile: WorldTileDefinition = { id: 'tile', mapId: DEFAULT_MAP_ID, col: 0, row: 0, type: 'forest', zone: 'wood', name: 'Wood' };
  return {
    getStartTile: () => ({ col: 0, row: 0 }),
    getMonster: () => undefined,
    getItem: () => undefined,
    getAllMonsters: () => ({}),
    getAllItems: () => ({}),
    getZone: () => ({ id: 'wood', displayName: 'Wood', encounterTable: [], levelRange: [1, 1] }),
    getAllZones: () => ({}),
    getAllEncounters: () => ({}),
    getTileById: () => tile,
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles: [tile], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() }),
    getAllSets: () => ({}),
    getAllRecipes: () => ({}),
    getRecipe: () => undefined,
    getAllNpcs: () => ({}),
    getNpc: () => undefined,
    getAllQuests: () => ({}),
    getQuestCatalog: () => ({}),
    getQuestRevision: () => 0,
    getNpcQuestIds: () => [],
    getQuest: () => undefined,
    getDungeon: () => undefined,
    getAllDungeons: () => ({}),
    getHenchman: () => undefined,
    ...fakeSkillContent(),
    getSkill: (id: string) => SKILLS[id],
    getAllSkills: () => SKILLS,
  } as unknown as ContentStore;
}

async function setup() {
  const accounts: AccountStore = {
    findByUsername: (u: string) => ({ username: u, email: `${u}@x.com`, deactivated: false }) as unknown as Account,
    getAllUsernames: () => ['alice'],
    updateLastActive: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
  const store = {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;
  const grid = new HexGrid();
  grid.addTile(new HexTile(offsetToCube({ col: 0, row: 0 }), 'forest', 'wood', 'tile'));
  const grids = wrapGrids(grid);
  const content = contentStore();
  const pm = new PlayerManager(grids, content, new GuildStore(), accounts, store);
  const ws = { readyState: 1, send: vi.fn(), close: vi.fn(), on: vi.fn() } as unknown as WebSocket;
  const session = await pm.login(ws, 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  session.autoUnlockSkills();
  return { pm, session, grids, content };
}

describe('content validation of attack skills', () => {
  const problems = (skills: SkillDefinition[]) => findContentProblems({
    monsters: [], items: [], zones: [], encounters: [], skills,
    world: { tiles: [], startTile: { col: 0, row: 0 }, ...fakeWorldMeta() },
  } as unknown as ContentSnapshot).filter(p => p.startsWith('Skill '));

  it('accepts one attack per class', () => {
    expect(problems([ATTACK, MAGE_ATTACK, STRIKE])).toEqual([]);
  });

  it('refuses a second attack for a class', () => {
    expect(problems([ATTACK, { ...ATTACK, id: 'knight_attack_2' }]).join()).toMatch(/Knight already has an attack skill/);
  });

  it('refuses a passive with charge', () => {
    expect(problems([{ ...SEED_SKILLS.knight_guard, charge: 1 }]).join()).toMatch(/Charge only applies/);
  });
});

describe('per-player priority list', () => {
  it('stores a valid order and pushes it in player state', async () => {
    const { session } = await setup();
    expect(session.handleSetActionOrder(['knight_attack', 'test_strike'])).toBe(true);
    expect(session.getState([]).character?.skillLoadout.actionOrder).toEqual(['knight_attack', 'test_strike']);
  });

  it('carries it and the attack skill into the next fight', async () => {
    const { pm, session } = await setup();
    session.handleSetActionOrder(['knight_attack', 'test_strike']);
    const info = session.getCombatInfo(4);
    expect(info.attack).toBe(ATTACK);
    expect(info.actionOrder).toEqual(['knight_attack', 'test_strike']);
    const [built] = pm.partyBattles.buildPartyCombatants(session.getPartyId()!);
    expect(built.attack).toBe(ATTACK);
    expect(built.actionOrder).toEqual(['knight_attack', 'test_strike']);
  });

  it('leaves actionOrder out when the player has not set one', async () => {
    const { session } = await setup();
    const info = session.getCombatInfo(4);
    expect(info.attack).toBe(ATTACK);
    expect('actionOrder' in info).toBe(false);
  });

  it('survives save and restore, through JSON', async () => {
    const { session, grids, content } = await setup();
    session.handleSetActionOrder(['test_strike', 'knight_attack']);
    const saved = JSON.parse(JSON.stringify(session.toSaveData()));
    const restored = PlayerSession.fromSaveData(saved, grids, content);
    expect(restored.getSkillLoadout()?.actionOrder).toEqual(['test_strike', 'knight_attack']);
    expect(restored.getCombatInfo(4).actionOrder).toEqual(['test_strike', 'knight_attack']);
  });

  it('loads an old save with none', async () => {
    const { session, grids, content } = await setup();
    const saved = JSON.parse(JSON.stringify(session.toSaveData()));
    saved.character.skillLoadout.unlockedSkills = saved.character.skillLoadout.unlockedSkills.filter((id: string) => id !== 'knight_attack');
    const restored = PlayerSession.fromSaveData(saved, grids, content);
    expect(restored.getSkillLoadout()?.actionOrder).toBeUndefined();
    expect(restored.getSkillLoadout()?.unlockedSkills).toContain('knight_attack');
    expect(restored.getSkillLoadout()?.equippedSkills).not.toContain('knight_attack');
  });

  it.each([
    ['not an array', 'knight_attack'],
    ['an object', { 0: 'knight_attack' }],
    ['null', null],
    ['a number in it', ['knight_attack', 5]],
    ['an unknown id', ['nope']],
    ["another class's skill", ['test_zap']],
    ["another class's attack", ['mage_attack']],
    ['a passive', ['knight_guard']],
    ['a reaction', ['test_block']],
    ['a skill not yet unlocked', ['test_far_off']],
    ['a duplicate', ['test_strike', 'test_strike']],
    ['too many ids', Array.from({ length: MAX_ACTION_ORDER_LENGTH + 1 }, (_, i) => `x${i}`)],
  ])('rejects %s and keeps the old order', async (_label, bad) => {
    const { session } = await setup();
    session.handleSetActionOrder(['test_strike']);
    expect(session.handleSetActionOrder(bad)).toBe(false);
    expect(session.getSkillLoadout()?.actionOrder).toEqual(['test_strike']);
  });

  it('resets to the default on an empty list', async () => {
    const { session } = await setup();
    session.handleSetActionOrder(['test_strike']);
    expect(session.handleSetActionOrder([])).toBe(true);
    expect(session.getSkillLoadout()?.actionOrder).toBeUndefined();
  });

  it('is cleaned on class change', async () => {
    const { session } = await setup();
    session.handleSetActionOrder(['knight_attack', 'test_strike']);
    session.forceSetClass('Archer');
    expect(session.getSkillLoadout()?.actionOrder).toBeUndefined();
    expect(session.getCombatInfo(4).attack).toBe(ARCHER_ATTACK);
  });

  it('stays out of the public profile', async () => {
    const { session } = await setup();
    session.handleSetActionOrder(['test_strike']);
    expect(session.getPublicProfile()?.skillLoadout.actionOrder).toBeUndefined();
  });

  it('refuses to equip the attack skill', async () => {
    const { session } = await setup();
    expect(session.getSkillLoadout()?.unlockedSkills).toContain('knight_attack');
    for (let slot = 0; slot < 5; slot++) expect(session.handleEquipSkill('knight_attack', slot)).toBe(false);
    expect(session.getSkillLoadout()?.equippedSkills).not.toContain('knight_attack');
  });
});
