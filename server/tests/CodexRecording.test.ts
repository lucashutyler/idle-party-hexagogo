import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_MAP_ID, MAX_STACK, RUN_AVAILABLE_MS, createMonsterInstance, createPartyCombatState } from '@idle-party-rpg/shared';
import type { ClassName, CodexSaveData, HenchmanDefinition, PartyCombatState, PartyGridPosition } from '@idle-party-rpg/shared';
import { PlayerSession } from '../src/game/PlayerSession.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';
import type { WorldGrids } from '../src/game/WorldGrids.js';
import { swapTradeItems } from '../src/game/social/TradeSystem.js';
import { codexContent, codexManager, codexWorld, fakeSocket } from './codexFixture.js';
import type { CodexWorld } from './codexFixture.js';
import { journal } from './recapFixture.js';

interface Entry {
  battleTimer: ServerBattleTimer;
  serverParty: ServerParty;
  dungeonRun?: { currentFloorIndex: number };
}

interface PbmInternals {
  entries: Map<string, Entry>;
  createCombatForParty(partyId: string): PartyCombatState;
  handleBattleEnd(partyId: string, result: 'victory' | 'defeat'): void;
}

const codexOf = (session: PlayerSession): CodexSaveData => session.toSaveData().codex ?? {};

/** Logging in with a class starts the party's first fight in the start room, Barley Field (goblins with Math.random at 0). */
async function setup(usernames: string[] = ['alice', 'bob'], world: CodexWorld = codexWorld()) {
  const content = codexContent(world);
  const { pm, hex } = codexManager(content, usernames);
  const pbm = pm.partyBattles as unknown as PbmInternals;
  const login = async (username: string, className: ClassName = 'Knight', withParty = true) => {
    const ws = fakeSocket();
    const session = await pm.login(ws, username);
    session.setClass(className);
    if (withParty) pm.ensureParty(username);
    return { session, ws };
  };
  const partyOf = (username: string) => pm.getSessionByUsername(username)!.getPartyId()!;
  const entryOf = (username: string) => pbm.entries.get(partyOf(username))!;
  const join = (inviter: string, joiner: string) => {
    const getPartyId = (u: string) => pm.getSessionByUsername(u)?.getPartyId() ?? null;
    if (pm.parties.inviteToParty(inviter, joiner, getPartyId, (a, b) => pm.invitePolicy(a, b)) !== true) throw new Error('invite failed');
    const refused = pm.acceptPartyInvite(joiner, getPartyId(inviter)!);
    if (refused) throw new Error(refused);
  };
  const moveTo = (username: string, tileId: string) => entryOf(username).serverParty.relocateTo(hex(tileId));
  /** Build the party's next fight, as the battle timer does. */
  const fight = (username: string) => {
    const combat = pbm.createCombatForParty(partyOf(username));
    (entryOf(username).battleTimer as unknown as { combatState: PartyCombatState }).combatState = combat;
    return combat;
  };
  const end = (username: string, result: 'victory' | 'defeat') => {
    const combat = entryOf(username).battleTimer.currentCombat!;
    if (result === 'victory') for (const m of combat.monsters) m.currentHp = 0;
    pbm.handleBattleEnd(partyOf(username), result);
  };
  /** Pay a won fight over these monsters, built by hand. */
  const win = (username: string, monsterIds: string[]) => {
    const monsters = monsterIds.map((id, i) => createMonsterInstance(world.monsters[id], i as PartyGridPosition));
    const combat = createPartyCombatState(pm.partyBattles.buildPartyCombatants(partyOf(username)), monsters);
    (entryOf(username).battleTimer as unknown as { combatState: PartyCombatState }).combatState = combat;
    end(username, 'victory');
  };
  const hire = (username: string, def: HenchmanDefinition) => {
    world.henchmen[def.id] = def;
    const hired = pm.parties.hireHenchman(username, def.id, DEFAULT_MAP_ID, u => pm.getSessionByUsername(u)?.getPartyId() ?? null);
    if (typeof hired === 'string') throw new Error(hired);
  };
  const grids = (pm as unknown as { grids: WorldGrids }).grids;
  return { pm, world, content, grids, login, join, partyOf, entryOf, moveTo, fight, end, win, hire };
}

function inventoryOf(session: PlayerSession): Record<string, number> {
  return (session as unknown as { character: { inventory: Record<string, number> } }).character.inventory;
}

const hireNamed = (id: string, name: string, className: ClassName = 'Knight'): HenchmanDefinition =>
  ({ id, name, className, level: 1, maxHp: 50, baseDamage: 3, skillIds: [], emoji: '🛡️' });

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Codex recording at fight start', () => {
  it('credits every human in an overworld fight, offline ones too, with the monsters, the encounter and the room shop', async () => {
    const { pm, login, join, moveTo, fight } = await setup();
    const { session: alice } = await login('alice');
    const { session: bob, ws: bobWs } = await login('bob', 'Priest');
    join('alice', 'bob');
    pm.removeConnection(bobWs);
    expect(pm.getOnlinePlayers()).toEqual(['alice']);

    moveTo('alice', 'mill');
    fight('alice');
    moveTo('alice', 'den');
    fight('alice');

    for (const session of [alice, bob]) {
      expect(codexOf(session)).toMatchObject({ monsters: ['goblin', 'bear'], encounters: ['goblins', 'bears'], shops: ['mill_post'] });
    }
  });

  it('records no shop in a room without one', async () => {
    const { login, fight } = await setup(['alice']);
    const { session: alice } = await login('alice');

    fight('alice');

    expect(codexOf(alice)).toEqual({ monsters: ['goblin'], encounters: ['goblins'], recent: [{ kind: 'monster', id: 'goblin' }] });
  });

  it('never credits a hire, even one whose name is a real player\'s', async () => {
    const { login, moveTo, fight, hire } = await setup();
    const { session: alice } = await login('alice');
    const { session: bob } = await login('bob', 'Knight', false);
    hire('alice', hireNamed('stand_in', 'bob'));
    moveTo('alice', 'den');

    const combat = fight('alice');

    expect(combat.players.map(p => [p.username, !!p.isHenchman])).toEqual([['alice', false], ['bob', true]]);
    expect(codexOf(alice).monsters).toEqual(['goblin', 'bear']);
    expect(bob.toSaveData().codex).toBeUndefined();
  });

  it('records the fallback pack\'s monsters and no encounter', async () => {
    const world = codexWorld();
    world.zones.meadow.encounterTable = [];
    const { login, fight } = await setup(['alice'], world);
    const { session: alice } = await login('alice');

    fight('alice');

    expect(codexOf(alice).monsters).toEqual(['goblin']);
    expect(codexOf(alice).encounters).toBeUndefined();
  });

  it('records a room\'s own table, not its zone\'s', async () => {
    const { login, moveTo, fight } = await setup(['alice']);
    const { session: alice } = await login('alice');
    moveTo('alice', 'den');

    const combat = fight('alice');

    expect(combat.monsters.map(m => m.id)).toEqual(['bear']);
    expect(codexOf(alice)).toMatchObject({ monsters: ['goblin', 'bear'], encounters: ['goblins', 'bears'] });
  });

  it('records a dungeon floor fight as the dungeon, with no shop or encounter from the entrance room', async () => {
    const { pm, login, moveTo, partyOf, fight } = await setup(['alice']);
    const { session: alice } = await login('alice');
    moveTo('alice', 'gate');
    expect(pm.partyBattles.enterDungeon(partyOf('alice'), 'damp_cave').success).toBe(true);

    const combat = fight('alice');

    expect(combat.monsters.map(m => m.id)).toEqual(['bat']);
    const codex = codexOf(alice);
    expect(codex.monsters).toEqual(['goblin', 'bat']);
    expect(codex.dungeons).toEqual(['damp_cave']);
    expect(codex.encounters).toEqual(['goblins']);
    expect(codex.shops).toBeUndefined();
  });

  it('still counts monsters as met after a defeat', async () => {
    const { login, moveTo, fight, end } = await setup(['alice']);
    const { session: alice } = await login('alice');
    moveTo('alice', 'den');
    fight('alice');

    end('alice', 'defeat');

    expect(codexOf(alice).monsters).toEqual(['goblin', 'bear']);
  });

  it('still counts monsters as met after a Run', async () => {
    const world = codexWorld();
    world.monsters.goblin = { ...world.monsters.goblin, hp: 1e9 };
    const { pm, login, partyOf } = await setup(['alice'], world);
    const { session: alice } = await login('alice');
    vi.advanceTimersByTime(RUN_AVAILABLE_MS + 2000);
    expect(pm.partyBattles.canEscape(partyOf('alice'))).toBe(true);

    expect(pm.partyBattles.escapeBattle(partyOf('alice'))).toBe(true);

    expect(codexOf(alice).monsters).toEqual(['goblin']);
  });
});

describe('Codex journal lines', () => {
  it('writes one line for monsters met for the first time, with a ref to the first one', async () => {
    const world = codexWorld();
    world.dungeons.damp_cave.floors[0].encounterTable = [{ encounterId: 'boss_room', weight: 1 }];
    const { pm, login, moveTo, partyOf, fight } = await setup(['alice'], world);
    const { session: alice } = await login('alice');
    fight('alice');
    expect(journal(alice, 'codex')).toEqual(['New in your Codex: Goblin.']);

    moveTo('alice', 'gate');
    expect(pm.partyBattles.enterDungeon(partyOf('alice'), 'damp_cave').success).toBe(true);
    fight('alice');

    expect(journal(alice, 'codex')).toEqual(['New in your Codex: Goblin.', 'New in your Codex: Cave King, Cave Bat.']);
    const lines = alice.toSaveData().combatLog.filter(l => l.type === 'codex');
    expect(lines.map(l => l.codex)).toEqual([{ kind: 'monster', id: 'goblin' }, { kind: 'monster', id: 'cave_boss' }]);
  });

  it('writes nothing for monsters known from kills made before the Codex', async () => {
    const { content, grids, login } = await setup(['alice']);
    const { session: alice } = await login('alice');
    const saved = { ...alice.toSaveData(), combatLog: [], monsterKills: { wolf: 4 }, codex: undefined };

    const restored = PlayerSession.fromSaveData(saved, grids, content);
    expect(restored.toSaveData().codex?.monsters).toEqual(['wolf']);
    restored.noteCodexFight([{ id: 'wolf', name: 'Wolf' }], { kind: 'room', encounterId: 'wolves' });

    expect(journal(restored, 'codex')).toEqual([]);
    expect(restored.toSaveData().codex?.encounters).toEqual(['wolves']);
  });
});

describe('Codex drops', () => {
  it('credits each drop to its recipient only, with the monster that dropped it', async () => {
    const { login, join, win } = await setup();
    const { session: alice } = await login('alice');
    const { session: bob } = await login('bob', 'Priest');
    join('alice', 'bob');

    win('alice', ['wolf', 'ghoul']);

    expect(codexOf(alice).drops).toEqual({ wolf: { pelt: 2, fang: 1 } });
    expect(codexOf(bob).drops).toEqual({ ghoul: { charm: 1 } });
    expect(codexOf(alice).items).toEqual(['pelt', 'fang']);
    expect(codexOf(bob).items).toEqual(['charm']);
  });

  it('credits nobody for a drop that goes to a hire\'s share', async () => {
    const { login, win, hire } = await setup(['alice']);
    const { session: alice } = await login('alice');
    hire('alice', hireNamed('chaplain', 'Chaplain', 'Priest'));

    win('alice', ['ghoul']);

    expect(codexOf(alice).drops).toBeUndefined();
    expect(codexOf(alice).items).toBeUndefined();
  });

  it('records neither a drop nor an item when a full stack leaves it behind', async () => {
    const { login, win } = await setup(['alice']);
    const { session: alice } = await login('alice');
    inventoryOf(alice).fang = MAX_STACK;

    win('alice', ['wolf']);

    expect(codexOf(alice).drops).toEqual({ wolf: { pelt: 2 } });
    expect(codexOf(alice).items).toEqual(['pelt']);
  });

  it('skips a drop whose item is gone from content', async () => {
    const { login, win } = await setup(['alice']);
    const { session: alice } = await login('alice');

    win('alice', ['wolf']);

    expect(codexOf(alice).items).not.toContain('lost_item');
    expect(Object.keys(codexOf(alice).drops!.wolf)).not.toContain('lost_item');
  });
});

describe('Codex items from every way into the bags', () => {
  it('adds dungeon rewards, shop buys, quest rewards, gifts, trades and crafts', async () => {
    const { pm, content, login } = await setup();
    const { session: alice } = await login('alice');
    const { session: bob } = await login('bob');

    expect(alice.grantRewardItem('gem')).toBe(true);
    expect(alice.addOneToInventory('rope')).toBe(true);

    expect(alice.handleAcceptQuest('delivery', 1)).toEqual({ success: true });
    alice.quests.applyKill('goblin', content.getQuestCatalog());
    expect(alice.handleTurnInQuest('delivery')).toEqual({ success: true });

    const gift = pm.mailboxes.addEntry('alice', 'bob', 'lamp', 1);
    expect(pm.acceptGift('alice', gift.id)).toBeNull();

    bob.addToInventory('ear', 2);
    expect(swapTradeItems(bob, [{ itemId: 'ear', quantity: 1 }], alice, [])).toBeNull();

    alice.addToInventory('herb', 1);
    const start = Date.now();
    expect(alice.handleCraftQueue('brew', start)).toEqual({ ok: true });
    expect(alice.processCraftCompletions(start + 11_000)).toBe(true);

    expect(codexOf(alice).items).toEqual(['gem', 'rope', 'sword', 'lamp', 'ear', 'herb', 'tonic']);
  });

  it('keeps an item known after it is sold or destroyed', async () => {
    const { login } = await setup(['alice']);
    const { session: alice } = await login('alice');
    alice.addToInventory('rope', 2);

    expect(alice.handleSellItems('rope', 1)).toBeNull();
    expect(alice.handleDestroyItems('rope', 1)).toBeNull();

    expect(alice.getInventoryCount('rope')).toBe(0);
    expect(codexOf(alice).items).toEqual(['rope']);
  });

  it('adds nothing for a stack that cannot take more', async () => {
    const { login } = await setup(['alice']);
    const { session: alice } = await login('alice');
    inventoryOf(alice).rope = MAX_STACK;

    expect(alice.addOneToInventory('rope')).toBe(false);
    expect(alice.addToInventory('rope', 1)).toBe(false);
    expect(alice.grantRewardItem('rope')).toBe(false);

    expect(codexOf(alice).items).toBeUndefined();
  });
});
