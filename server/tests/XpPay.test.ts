import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  COMBAT_PACE,
  DEFAULT_MAP_ID,
  HIRE_LEVEL_LIMIT,
  KILL_BEAT_MS,
  MOVE_DURATION,
  RESULT_PAUSE,
  RUN_AVAILABLE_MS,
  combatRealStepMs,
} from '@idle-party-rpg/shared';
import type { ClassName, DungeonDefinition, HenchmanDefinition, MonsterDefinition, PartyCombatState, ZoneDefinition } from '@idle-party-rpg/shared';
import type WebSocket from 'ws';
import { LONE_LEAVE_REFUSAL } from '../src/game/PlayerManager.js';
import { MONSTERS, START, createWs, forecastWorld, joinAlice, tileId } from './forecastFixture.js';
import type { ForecastWorld, WorldOptions } from './forecastFixture.js';

const REWARD = COMBAT_PACE.rewardMultiplier;
const AT_START = `${START.col},${START.row}`;

function stock(w: ForecastWorld, changes: Record<string, Partial<MonsterDefinition>>): void {
  const monsters: Record<string, MonsterDefinition> = { ...MONSTERS };
  for (const [id, change] of Object.entries(changes)) monsters[id] = { ...monsters[id], ...change };
  Object.assign(w.content, {
    getMonster: (id: string) => monsters[id],
    getAllMonsters: () => monsters,
    getItem: (id: string) => ({ id, name: id }),
  });
}

function makeStarterZone(w: ForecastWorld): void {
  const zone: ZoneDefinition = { id: 'z', displayName: 'Zed', encounterTable: [], levelRange: [1, 5], starterZone: true };
  Object.assign(w.content, { getAllZones: () => ({ z: zone }), getZone: () => zone });
}

function setLevel(w: ForecastWorld, username: string, level: number): void {
  (w.pm.getSessionByUsername(username) as unknown as { character: { level: number } }).character.level = level;
}

function earned(w: ForecastWorld, username = 'alice') {
  const character = w.pm.getSessionByUsername(username)!.toSaveData().character!;
  return { xp: character.xp, gold: character.gold };
}

function combat(w: ForecastWorld, partyId = w.partyId): PartyCombatState {
  return w.entry(partyId).battleTimer.currentCombat!;
}

function realStep(w: ForecastWorld, partyId = w.partyId): number {
  return combatRealStepMs(combat(w, partyId));
}

function runToFinish(w: ForecastWorld, partyId = w.partyId): void {
  const step = realStep(w, partyId);
  for (let i = 0; i < 1000 && !combat(w, partyId).finished; i++) vi.advanceTimersByTime(step);
  expect(combat(w, partyId).finished).toBe(true);
}

/** Plays the fight under way to its payout, stopping right after. */
function finishFight(w: ForecastWorld, partyId = w.partyId): void {
  runToFinish(w, partyId);
  vi.advanceTimersByTime(KILL_BEAT_MS);
}

/** Lets what is left of the usual pause run out, when a restart came after the last fight ended. */
function waitOutPause(w: ForecastWorld, partyId = w.partyId): void {
  const timer = w.entry(partyId).battleTimer;
  if (!timer.isLive) vi.advanceTimersByTime(timer.regroupRemainingMs);
}

function newFight(w: ForecastWorld, partyId = w.partyId): void {
  w.entry(partyId).battleTimer.restartBattle();
  waitOutPause(w, partyId);
}

/** A fresh fight, played to its payout. Returns what alice earned from it. */
function winFight(w: ForecastWorld, username = 'alice') {
  newFight(w);
  const before = earned(w, username);
  finishFight(w);
  const after = earned(w, username);
  return { xp: after.xp - before.xp, gold: after.gold - before.gold };
}

function fighters(w: ForecastWorld, partyId = w.partyId): string[] {
  return combat(w, partyId).players.map(p => p.username).sort();
}

function hireOf(id: string, level: number, className: ClassName = 'Knight'): HenchmanDefinition {
  return { id, name: id, className, level, maxHp: 500, baseDamage: 1, skillIds: [], emoji: 'x' };
}

function stockHires(w: ForecastWorld, defs: HenchmanDefinition[]): void {
  const byId = Object.fromEntries(defs.map(d => [d.id, d]));
  Object.assign(w.content, { getHenchman: (id: string) => byId[id] });
}

function hire(w: ForecastWorld, id: string): void {
  const hired = w.pm.hireHenchman('alice', id, DEFAULT_MAP_ID);
  if (typeof hired === 'string') throw new Error(hired);
  w.pm.partyBattles.henchmenChanged(w.partyId, [hired]);
}

async function goldWorld(opts: WorldOptions = {}): Promise<ForecastWorld> {
  const w = await forecastWorld({ defaultEncounter: 'gnats', ...opts });
  stock(w, { gnat: { xp: 100, goldMin: 100, goldMax: 100 } });
  return w;
}

async function deadlyWorld(opts: WorldOptions = {}): Promise<ForecastWorld> {
  const w = await forecastWorld({ defaultEncounter: 'ogres', ...opts });
  stock(w, { ogre: { damage: 1e9 } });
  return w;
}

async function secondPlayer(w: ForecastWorld, username: string, className: ClassName) {
  const session = await w.pm.login(createWs() as unknown as WebSocket, username);
  session.setClass(className);
  w.pm.applyClassChange(username);
  return session;
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('party XP share', () => {
  const SHARE = [1, 0.91, 0.82, 0.76, 0.72];

  it.each([0, 1, 2, 3, 4])('pays by bodies with %i hires as full bodies, and splits coin per body', async (hires) => {
    const w = await goldWorld();
    const defs = Array.from({ length: hires }, (_, i) => hireOf(`h${i}`, 1));
    stockHires(w, defs);
    for (const def of defs) hire(w, def.id);

    expect(winFight(w)).toEqual({
      xp: Math.ceil(100 * REWARD * SHARE[hires] - 1e-9),
      gold: Math.ceil((100 * REWARD) / (hires + 1)),
    });
  });

  it('pays two humans the two-body share each', async () => {
    const w = await goldWorld();
    await joinAlice(w, 'bob', 'Mage');
    newFight(w);
    const before = [earned(w), earned(w, 'bob')];

    finishFight(w);

    expect(earned(w).xp - before[0].xp).toBe(Math.ceil(100 * REWARD * 0.91));
    expect(earned(w, 'bob').xp - before[1].xp).toBe(Math.ceil(100 * REWARD * 0.91));
  });

  it('counts a human and a hire the same', async () => {
    const w = await goldWorld();
    stockHires(w, [hireOf('h', 1)]);
    hire(w, 'h');
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD * 0.91));
  });
});

describe('level gap, in the party', () => {
  it('reads the bonus on the highest human in the fight, and the decay on each member', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 20 } });
    setLevel(w, 'alice', 10);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 25);
    newFight(w);
    const before = [earned(w), earned(w, 'bob')];

    finishFight(w);

    expect(earned(w).xp - before[0].xp).toBe(Math.ceil(100 * REWARD * 0.91));
    expect(earned(w, 'bob').xp - before[1].xp).toBe(Math.ceil(100 * REWARD * 0.91 * Math.exp(-0.4 * 3)));
  });

  it('pays a member the upward bonus once the monster is over everyone', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 13, damage: 5, hp: 2 } });
    setLevel(w, 'alice', 10);
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD * 1.36));
  });

  it('never counts a hire as the highest human', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 13, damage: 5, hp: 2 } });
    setLevel(w, 'alice', 10);
    stockHires(w, [hireOf('h', 10 + HIRE_LEVEL_LIMIT)]);
    hire(w, 'h');
    expect(fighters(w)).toEqual(['alice', 'h']);
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD * 1.36 * 0.91));
  });

  it('reads the bonus on the human, not on a level-40 hire beside them', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 13, damage: 5, hp: 2 } });
    setLevel(w, 'alice', 10);
    stockHires(w, [hireOf('h', 10 + HIRE_LEVEL_LIMIT)]);
    hire(w, 'h');
    newFight(w);
    combat(w).players.find(p => p.isHenchman)!.level = 40;
    const before = earned(w);

    finishFight(w);

    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD * 1.36 * 0.91));
  });

  it('reads each member\'s level as it was when the fight began', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 13, damage: 5, hp: 2 } });
    setLevel(w, 'alice', 10);
    newFight(w);
    const before = earned(w);
    setLevel(w, 'alice', 20);

    finishFight(w);

    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD * 1.36));
  });

  it('pays a monster with no authored level flat at any level', async () => {
    const w = await goldWorld();
    setLevel(w, 'alice', 60);
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD));
  });
});

describe('starter zones', () => {
  it('keeps 80 % for a player with no party and no hire', async () => {
    const w = await goldWorld();
    makeStarterZone(w);
    expect(winFight(w)).toEqual({ xp: Math.ceil(100 * REWARD * 0.8), gold: Math.ceil(100 * REWARD) });
  });

  it('takes no share cut with a hire, and coin still splits per body', async () => {
    const w = await goldWorld();
    makeStarterZone(w);
    stockHires(w, [hireOf('h', 1)]);
    hire(w, 'h');
    expect(winFight(w)).toEqual({ xp: Math.ceil(100 * REWARD), gold: Math.ceil((100 * REWARD) / 2) });
  });

  it('takes no share cut with a human', async () => {
    const w = await goldWorld();
    makeStarterZone(w);
    await joinAlice(w, 'bob', 'Mage');
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD));
  });

  it('does not reach a dungeon floor, wherever its entrance stands', async () => {
    const def: DungeonDefinition = {
      id: 'den', name: 'Den', floors: [
        { floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }] },
        { floorNumber: 2, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }] },
      ],
    };
    const w = await goldWorld({ dungeon: { def, at: AT_START } });
    makeStarterZone(w);
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'den').success).toBe(true);
    const before = earned(w);

    finishFight(w);

    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD));
  });

  it('pays by the usual table in a zone that is not one', async () => {
    const w = await goldWorld();
    stockHires(w, [hireOf('h', 1)]);
    hire(w, 'h');
    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD * 0.91));
  });
});

describe('dungeon floor factors', () => {
  function floorDungeon(extra: object): DungeonDefinition {
    return {
      id: 'den',
      name: 'Den',
      firstClearXp: 20,
      firstClearGold: 30,
      floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }], ...extra }],
    };
  }

  async function runDungeon(def: DungeonDefinition, gnat: Partial<MonsterDefinition> = {}) {
    const w = await goldWorld({ dungeon: { def, at: AT_START } });
    stock(w, { gnat: { xp: 100, goldMin: 100, goldMax: 100, ...gnat } });
    const run = () => {
      const before = earned(w);
      expect(w.pm.partyBattles.enterDungeon(w.partyId, 'den').success).toBe(true);
      waitOutPause(w);
      finishFight(w);
      const after = earned(w);
      return { xp: after.xp - before.xp, gold: after.gold - before.gold };
    };
    return run;
  }

  it('multiplies what the floor pays, and leaves first-clear rewards whole', async () => {
    const run = await runDungeon(floorDungeon({ xpFactor: 0.25, coinFactor: 0.5 }));
    expect(run()).toEqual({ xp: Math.ceil(25 * REWARD) + 20, gold: Math.ceil(100 * REWARD * 0.5) + 30 });
    expect(run()).toEqual({ xp: Math.ceil(25 * REWARD), gold: Math.ceil(100 * REWARD * 0.5) });
  });

  it('pays at least 1 per paying monster, however small the factor', async () => {
    const run = await runDungeon(floorDungeon({ xpFactor: 0.001 }));
    run();
    expect(run().xp).toBe(Math.ceil(REWARD));
  });

  it('keeps a monster that paid nothing at nothing, and a coin factor of 0 at no coin', async () => {
    const run = await runDungeon(floorDungeon({ xpFactor: 0.5, coinFactor: 0 }), { xp: 0 });
    run();
    expect(run()).toEqual({ xp: 0, gold: 0 });
  });

  it('pays in full with no factors, and with a bad one that slipped past validation', async () => {
    const plain = await runDungeon(floorDungeon({}));
    plain();
    expect(plain()).toEqual({ xp: Math.ceil(100 * REWARD), gold: Math.ceil(100 * REWARD) });

    const bad = await runDungeon(floorDungeon({ xpFactor: 9, coinFactor: 'half' }));
    bad();
    expect(bad()).toEqual({ xp: Math.ceil(100 * REWARD), gold: Math.ceil(100 * REWARD) });
  });
});

describe('the pause after a won fight', () => {
  it('is kept by going into a dungeon and out again in the kill beat, and the win is paid once', async () => {
    const def: DungeonDefinition = { id: 'den', name: 'Den', floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'gnats', weight: 1 }] }] };
    const w = await goldWorld({ dungeon: { def, at: AT_START } });
    newFight(w);
    const before = earned(w);
    runToFinish(w);
    const nextFightDue = Date.now() + KILL_BEAT_MS + RESULT_PAUSE + MOVE_DURATION;
    const timer = w.entry().battleTimer;

    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'den').success).toBe(true);
    expect(w.pm.partyBattles.leaveDungeon(w.partyId)).toBe(true);

    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD));
    vi.advanceTimersByTime(nextFightDue - Date.now() - 1);
    expect(timer.isLive).toBe(false);
    vi.advanceTimersByTime(1);
    expect(timer.isLive).toBe(true);
    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD));
  });
});

describe('losing a fight in a room', () => {
  it('costs no wait: the usual pause, then the party fights again', async () => {
    const w = await deadlyWorld();
    newFight(w);
    finishFight(w);
    expect(combat(w).result).toBe('defeat');

    const timer = w.entry().battleTimer;
    expect(timer.regroupRemainingMs).toBe(0);
    expect(w.pm.partyBattles.getBattleState(w.partyId)!.regroupMs).toBeUndefined();
    const battleId = timer.battleId;
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(timer.battleId).not.toBe(battleId);
    expect(timer.isLive).toBe(true);
  });

  it('costs no wait on a stalemate either', async () => {
    const w = await deadlyWorld();
    stock(w, { ogre: { damage: 0 } });
    newFight(w);
    combat(w).lastProgressMs = -1e9;
    finishFight(w);

    expect(combat(w).result).toBe('defeat');
    expect(w.journal()).toContain('Defeat...');
    expect(w.entry().battleTimer.regroupRemainingMs).toBe(0);
  });

  it('costs no wait for a Run that leaves the party in the room', async () => {
    const w = await deadlyWorld();
    stock(w, { ogre: { damage: 0 } });
    newFight(w);
    vi.advanceTimersByTime(6000);

    expect(w.pm.partyBattles.escapeBattle(w.partyId)).toBe(true);

    expect(w.entry().battleTimer.regroupRemainingMs).toBe(0);
    expect(w.journal()).not.toContain('Defeat...');
    vi.advanceTimersByTime(RESULT_PAUSE + MOVE_DURATION);
    expect(w.entry().battleTimer.isLive).toBe(true);
  });

  it('does not fall on a member who was not in the fight', async () => {
    const w = await deadlyWorld();
    newFight(w);
    await joinAlice(w, 'bob', 'Mage');
    finishFight(w);

    expect(w.pm.leaveParty('bob')).toBeNull();

    expect(w.journal('bob')).not.toContain('Defeat...');
  });

  it('keeps a dungeon wipe ending the run', async () => {
    const def: DungeonDefinition = { id: 'den', name: 'Den', floors: [{ floorNumber: 1, gridShape: { cols: 3, rows: 3 }, encounterTable: [{ encounterId: 'ogres', weight: 1 }] }] };
    const w = await deadlyWorld({ dungeon: { def, at: AT_START } });
    expect(w.pm.partyBattles.enterDungeon(w.partyId, 'den').success).toBe(true);

    finishFight(w);

    expect(w.pm.partyBattles.getDungeonRunInfo(w.partyId)).toBeNull();
    expect(w.entry().battleTimer.regroupRemainingMs).toBe(0);
  });
});

describe('only the roster in a fight is paid', () => {
  it('a joiner earns nothing from the fight in progress, and earns from the next', async () => {
    const w = await goldWorld();
    newFight(w);
    const before = earned(w);
    await joinAlice(w, 'bob', 'Mage');
    const bob = w.pm.getSessionByUsername('bob')!;
    const paid = vi.spyOn(bob, 'handleVictory');
    const kills = vi.spyOn(bob, 'recordKills');
    const quests = vi.spyOn(bob.quests, 'applyKill');
    const bobBefore = earned(w, 'bob');

    expect(fighters(w)).toEqual(['alice']);
    finishFight(w);

    expect(earned(w)).toEqual({ xp: before.xp + Math.ceil(100 * REWARD), gold: before.gold + Math.ceil(100 * REWARD) });
    expect(earned(w, 'bob')).toEqual(bobBefore);
    expect(paid).not.toHaveBeenCalled();
    expect(kills).not.toHaveBeenCalled();
    expect(quests).not.toHaveBeenCalled();

    const next = winFight(w);
    expect(next).toEqual({ xp: Math.ceil(100 * REWARD * 0.91), gold: Math.ceil((100 * REWARD) / 2) });
    expect(earned(w, 'bob').xp - bobBefore.xp).toBe(Math.ceil(100 * REWARD * 0.91));
    expect(paid).toHaveBeenCalledTimes(1);
    expect(quests).toHaveBeenCalled();
  });

  it('a joiner changes nobody\'s share or level gap in the fight in progress', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { xp: 100, level: 13, damage: 5, hp: 2 } });
    setLevel(w, 'alice', 10);
    newFight(w);
    const before = earned(w);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 60);

    finishFight(w);

    expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD * 1.36));

    expect(winFight(w).xp).toBe(Math.ceil(100 * REWARD * 0.91));
  });

  it('a joiner opens no rooms for themselves', async () => {
    const w = await goldWorld();
    newFight(w);
    await joinAlice(w, 'bob', 'Mage');
    const bob = w.pm.getSessionByUsername('bob')!;
    const unlocked = vi.spyOn(bob, 'handleVictory');

    finishFight(w);

    expect(unlocked).not.toHaveBeenCalled();
    expect(w.journal('bob')).not.toContain('Victory!');
  });

  it('a member leaving restarts the fight for those left, and nobody is paid for the abandoned one', async () => {
    const w = await goldWorld();
    await joinAlice(w, 'bob', 'Mage');
    stock(w, { gnat: { xp: 100, goldMin: 100, goldMax: 100, hp: 1_000_000 } });
    newFight(w);
    const abandoned = w.entry().battleTimer.battleId;
    const before = [earned(w), earned(w, 'bob')];
    vi.advanceTimersByTime(4000);
    const pushed = vi.spyOn(w.pm.partyBattles as unknown as { broadcastToMember: (u: string) => void }, 'broadcastToMember');

    expect(w.pm.leaveParty('bob')).toBeNull();

    expect(w.entry().battleTimer.battleId).not.toBe(abandoned);
    expect(fighters(w)).toEqual(['alice']);
    expect(pushed).toHaveBeenCalledWith('alice');
    expect(earned(w)).toEqual(before[0]);
    expect(earned(w, 'bob')).toEqual(before[1]);
    const bobParty = w.pm.getSessionByUsername('bob')!.getPartyId()!;
    expect(fighters(w, bobParty)).toEqual(['bob']);
    for (const m of combat(w).monsters) m.currentHp = 1;
    finishFight(w);
    expect(earned(w).xp - before[0].xp).toBe(Math.ceil(100 * REWARD));
  });

  it('a member being kicked restarts the fight too', async () => {
    const w = await goldWorld();
    await joinAlice(w, 'bob', 'Mage');
    stock(w, { gnat: { hp: 1_000_000 } });
    newFight(w);
    const abandoned = w.entry().battleTimer.battleId;

    expect(w.pm.kickPartyMember('alice', 'bob')).toBeNull();

    expect(w.entry().battleTimer.battleId).not.toBe(abandoned);
    expect(fighters(w)).toEqual(['alice']);
  });

  it('leaves a fight alone when the one leaving was not in it', async () => {
    const w = await goldWorld();
    stock(w, { gnat: { hp: 1_000_000 } });
    newFight(w);
    const fight = w.entry().battleTimer.battleId;
    await joinAlice(w, 'bob', 'Mage');

    expect(w.pm.leaveParty('bob')).toBeNull();

    expect(w.entry().battleTimer.battleId).toBe(fight);
  });

  it('a member who left and came back waits for the next fight', async () => {
    const w = await goldWorld();
    await joinAlice(w, 'bob', 'Mage');
    stock(w, { gnat: { xp: 100, goldMin: 100, goldMax: 100, hp: 1_000_000 } });
    newFight(w);
    expect(w.pm.leaveParty('bob')).toBeNull();
    const fight = w.entry().battleTimer.battleId;
    const bobBefore = earned(w, 'bob');
    const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
    expect(w.pm.parties.inviteToParty('alice', 'bob', getPartyId, (a, b) => w.pm.areSameTile(a, b))).toBe(true);
    expect(w.pm.acceptPartyInvite('bob', w.partyId)).toBeNull();
    expect(w.entry().battleTimer.battleId).toBe(fight);
    for (const m of combat(w).monsters) m.currentHp = 1;

    finishFight(w);

    expect(combat(w).result).toBe('victory');
    expect(earned(w, 'bob')).toEqual(bobBefore);
  });

  describe('a win in its kill beat is paid first', () => {
    async function inKillBeat() {
      const w = await goldWorld();
      await joinAlice(w, 'bob', 'Mage');
      newFight(w);
      const before = [earned(w), earned(w, 'bob')];
      runToFinish(w);
      expect(earned(w)).toEqual(before[0]);
      return { w, before };
    }

    it('when a member leaves', async () => {
      const { w, before } = await inKillBeat();
      const fight = w.entry().battleTimer.battleId;

      expect(w.pm.leaveParty('bob')).toBeNull();

      expect(earned(w).xp - before[0].xp).toBe(Math.ceil(100 * REWARD * 0.91));
      expect(earned(w, 'bob').xp - before[1].xp).toBe(Math.ceil(100 * REWARD * 0.91));
      expect(w.entry().battleTimer.battleId).toBe(fight);

      vi.advanceTimersByTime(KILL_BEAT_MS);
      expect(earned(w).xp - before[0].xp).toBe(Math.ceil(100 * REWARD * 0.91));
    });

    it('when a member is kicked', async () => {
      const { w, before } = await inKillBeat();
      expect(w.pm.kickPartyMember('alice', 'bob')).toBeNull();
      expect(earned(w, 'bob').xp - before[1].xp).toBe(Math.ceil(100 * REWARD * 0.91));
    });

    it('when a member joins, who shares none of it', async () => {
      const w = await goldWorld({ users: ['alice', 'bob'] });
      newFight(w);
      const before = earned(w);
      runToFinish(w);
      await joinAlice(w, 'bob', 'Mage');
      expect(earned(w).xp - before.xp).toBe(Math.ceil(100 * REWARD));
      expect(earned(w, 'bob').xp).toBe(0);
    });

    it('a wipe in its kill beat is still recorded for the one leaving', async () => {
      const w = await deadlyWorld();
      await joinAlice(w, 'bob', 'Mage');
      newFight(w);
      runToFinish(w);

      expect(w.pm.leaveParty('bob')).toBeNull();

      expect(w.journal('bob')).toContain('Defeat...');
    });
  });
});

describe('hire limit', () => {
  const OVER = hireOf('over', 1 + HIRE_LEVEL_LIMIT + 1);
  const AT_LINE = hireOf('line', 1 + HIRE_LEVEL_LIMIT);

  it('refuses a hire more than 5 levels above the highest human, and says why', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER, AT_LINE]);

    const refused = w.pm.hireHenchman('alice', 'over', DEFAULT_MAP_ID);

    expect(refused).toBe('Level 7 is more than 5 levels above your party\'s highest member (level 1).');
    expect(w.pm.parties.getHenchmen(w.partyId)).toHaveLength(0);
    expect(typeof w.pm.hireHenchman('alice', 'line', DEFAULT_MAP_ID)).not.toBe('string');
  });

  it('refuses a replacement over the line, keeping the hire in place', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER, AT_LINE]);
    hire(w, 'line');
    const [held] = w.pm.parties.getHenchmen(w.partyId);

    expect(typeof w.pm.hireHenchman('alice', 'over', DEFAULT_MAP_ID, held.instanceId)).toBe('string');

    expect(w.pm.parties.getHenchmen(w.partyId).map(h => h.henchmanId)).toEqual(['line']);
  });

  it('reads the highest human in the party, not the one hiring', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER]);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 2);
    expect(typeof w.pm.hireHenchman('alice', 'over', DEFAULT_MAP_ID)).not.toBe('string');
  });

  function shopReasons(w: ForecastWorld, username = 'alice'): Record<string, string | undefined> {
    const shop = { id: 'hall', name: 'Hall', inventory: [], henchmanIds: ['over', 'line'] };
    w.tiles.find(t => t.id === tileId(START.col, START.row))!.shopId = shop.id;
    Object.assign(w.content, { getShop: (id: string) => (id === shop.id ? shop : undefined) });
    const offers = w.pm.getSessionByUsername(username)!.getHenchmanOffers();
    return Object.fromEntries(offers.map(o => [o.henchmanId, o.levelLimitReason]));
  }

  it('tells the shop why, and only for hires over the line', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER, AT_LINE]);

    const offers = shopReasons(w);

    expect(offers.over).toContain('more than 5 levels above');
    expect(offers.line).toBeUndefined();
  });

  it('tells the shop the line from the party\'s highest member, not the one looking', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER, AT_LINE]);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 2);

    expect(shopReasons(w).over).toBeUndefined();
  });

  it('gives a member of a two-member party the reason from its highest member, not the one hiring', async () => {
    const w = await goldWorld();
    stockHires(w, [hireOf('over', 9)]);
    setLevel(w, 'alice', 3);
    await joinAlice(w, 'bob', 'Mage');

    expect(shopReasons(w, 'bob').over).toBe('Level 9 is more than 5 levels above your party\'s highest member (level 3).');
  });

  it('sits a hire out when the party falls under the line, and says why once', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER]);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 2);
    hire(w, 'over');
    newFight(w);
    expect(fighters(w)).toEqual(['alice', 'bob', 'over']);
    const line = 'over sits out. Level 7 is more than 5 levels above your party\'s highest member (level 1).';

    expect(w.pm.leaveParty('bob')).toBeNull();

    expect(fighters(w)).toEqual(['alice']);
    expect(w.pm.parties.getHenchmen(w.partyId)).toHaveLength(1);
    expect(w.journal()).toContain(line);

    newFight(w);
    newFight(w);
    expect(w.journal().filter(l => l === line)).toHaveLength(1);
    expect(w.pm.partyBattles.buildPartyCombatants(w.partyId).map(p => p.username)).toEqual(['alice']);
  });

  it('pays no body for a hire sitting out', async () => {
    const w = await goldWorld();
    stockHires(w, [hireOf('over', 7)]);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 2);
    hire(w, 'over');
    expect(w.pm.leaveParty('bob')).toBeNull();

    expect(winFight(w)).toEqual({ xp: Math.ceil(100 * REWARD), gold: Math.ceil(100 * REWARD) });
  });

  it('brings the hire back once the party is within the line again', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER]);
    await joinAlice(w, 'bob', 'Mage');
    setLevel(w, 'bob', 2);
    hire(w, 'over');
    expect(w.pm.leaveParty('bob')).toBeNull();
    expect(fighters(w)).toEqual(['alice']);

    setLevel(w, 'alice', 2);
    newFight(w);

    expect(fighters(w)).toEqual(['alice', 'over']);
    expect(w.journal()).toContain('over is back in the fight.');
  });

  it('sits out a hire over the line that an old save still holds', async () => {
    const w = await goldWorld();
    stockHires(w, [OVER]);
    const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
    expect(typeof w.pm.parties.hireHenchman('alice', 'over', DEFAULT_MAP_ID, getPartyId)).not.toBe('string');

    newFight(w);

    expect(fighters(w)).toEqual(['alice']);
  });

  it('counts the hire at the line as fighting', async () => {
    const w = await goldWorld();
    stockHires(w, [AT_LINE]);
    hire(w, 'line');
    expect(fighters(w)).toEqual(['alice', 'line']);
  });
});
