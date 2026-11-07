import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  AUTHORED_PACE,
  COMBAT_PACE,
  COMBAT_SEND_MS,
  COMBAT_SNAPSHOT_MS,
  COMBAT_STEP_MS,
  FIRST_ACTION_PLAYER_MS,
  KILL_BEAT_MS,
  PLAYBACK_DELAY_MS,
  RUN_AVAILABLE_MS,
  combatRealStepMs,
  createMonsterInstance,
  createPartyCombatState,
  paceRealMs,
} from '@idle-party-rpg/shared';
import type {
  BattleForecastInput,
  BattleResult,
  ClassName,
  CombatPace,
  DungeonDefinition,
  HenchmanDefinition,
  MonsterDefinition,
  PartyCombatState,
} from '@idle-party-rpg/shared';
import { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { CombatFlush } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';
import { getContentSchema } from '../src/mcp/tools/readTools.js';
import { MONSTERS, START, badPack, forecastWorld, tileId } from './forecastFixture.js';
import type { ForecastWorld } from './forecastFixture.js';

const REWARD_MULTIPLIER = COMBAT_PACE.rewardMultiplier;
const ROLL_ABOVE_AUTHORED_0_4_BELOW_PACED = 0.45;
const ROLL_ABOVE_DROP_FLOOR_BELOW_ITS_SCALED_CHANCES = 0.6;

function firstStepAtOrPast(realMs: number, realStep: number): number {
  return Math.ceil(realMs / realStep) * realStep;
}

function makeFight(pace: CombatPace, stats: { damage: number; monsterHp: number }): PartyCombatState {
  const monster = createMonsterInstance(
    { id: 'dummy', name: 'Dummy', hp: stats.monsterHp, damage: 1, damageType: 'physical', xp: 5, goldMin: 0, goldMax: 0 },
    4,
  );
  return createPartyCombatState([{
    username: 'alice',
    maxHp: 1_000_000,
    baseDamage: stats.damage,
    playerDamageType: 'physical',
    gridPosition: 4,
    className: 'Knight',
    level: 1,
    equippedSkills: [null, null, null, null, null],
  }], [monster], { pace });
}

function timerHarness(createCombat: () => PartyCombatState) {
  const t0 = Date.now();
  const flushes: (CombatFlush & { at: number })[] = [];
  const ends: { result: BattleResult; at: number }[] = [];
  const party = { hasDestination: false, enterBattle: vi.fn(), exitBattle: vi.fn(), moveToNextTile: vi.fn(() => true) };
  const timer = new ServerBattleTimer(party as unknown as ServerParty, createCombat, {
    onCombatFlush: (f) => flushes.push({ ...f, events: [...f.events], log: [...f.log], at: Date.now() - t0 }),
    onBattleEnd: (result) => ends.push({ result, at: Date.now() - t0 }),
    canMoveToNextTile: () => false,
  }, 'test-party');
  return { timer, flushes, ends };
}

describe.each([
  ['COMBAT_PACE', COMBAT_PACE],
  ['AUTHORED_PACE', AUTHORED_PACE],
] as const)('ServerBattleTimer at %s', (_name, pace) => {
  const realStep = paceRealMs(pace, COMBAT_STEP_MS);
  const runOpensAt = firstStepAtOrPast(RUN_AVAILABLE_MS, realStep);
  const sendEvery = Math.round(COMBAT_SEND_MS / realStep) * realStep;
  const longFight = () => makeFight(pace, { damage: 1, monsterHp: 1_000_000 });
  const quickWin = () => makeFight(pace, { damage: 1000, monsterHp: 5 });

  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('advances the engine by a fixed COMBAT_STEP_MS every combatRealStepMs, and reports the duration in real time', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    const combat = h.timer.currentCombat!;
    expect(combatRealStepMs(combat)).toBe(realStep);

    vi.advanceTimersByTime(realStep * 9 - 1);
    expect(combat.tickCount).toBe(8);
    expect(combat.elapsedMs).toBe(COMBAT_STEP_MS * 8);

    vi.advanceTimersByTime(1);
    expect(combat.tickCount).toBe(9);
    expect(combat.elapsedMs).toBe(COMBAT_STEP_MS * 9);
    expect(h.timer.currentDuration).toBe(realStep * 9);
    h.timer.destroy();
  });

  it('opens Run at RUN_AVAILABLE_MS of real time', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    const combat = h.timer.currentCombat!;

    vi.advanceTimersByTime(runOpensAt - realStep);
    expect(h.timer.canEscape()).toBe(false);
    expect(h.timer.escapeBattle()).toBe(false);

    vi.advanceTimersByTime(realStep);
    expect(combat.elapsedMs).toBe((runOpensAt / realStep) * COMBAT_STEP_MS);
    expect(h.timer.canEscape()).toBe(true);
    expect(h.timer.escapeBattle()).toBe(true);
    h.timer.destroy();
  });

  it('allows a retreat from RUN_AVAILABLE_MS of real time, ending the fight at a real t', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    const battleId = h.timer.battleId;

    vi.advanceTimersByTime(runOpensAt - realStep);
    expect(h.timer.retreat(battleId, 'Away.')).toBe(false);

    vi.advanceTimersByTime(realStep);
    expect(h.timer.retreat(battleId, 'Away.')).toBe(true);
    const end = h.flushes.at(-1)!.events.find(e => e.kind === 'battle_end');
    expect(end).toMatchObject({ result: 'retreat', t: runOpensAt });
    h.timer.destroy();
  });

  it('holds a scheduled retreat until RUN_AVAILABLE_MS of real time', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    const battleId = h.timer.battleId;
    const combat = h.timer.currentCombat!;

    h.timer.scheduleRetreat(battleId, 0, 'Away.');
    vi.advanceTimersByTime(runOpensAt - realStep);
    expect(h.timer.isFighting(battleId)).toBe(true);

    vi.advanceTimersByTime(2 * realStep);
    expect(h.timer.isFighting(battleId)).toBe(false);
    expect(combat.result).toBe('retreat');
    h.timer.destroy();
  });

  it('flushes on the step nearest COMBAT_SEND_MS and snapshots every COMBAT_SNAPSHOT_MS of real time', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    vi.advanceTimersByTime(10_000);

    const live = h.flushes.slice(1);
    expect(live.length).toBeGreaterThan(10);
    for (const f of live) {
      expect(f.at % sendEvery).toBe(0);
      expect(f.snapshot === 'dynamic' || f.events.length > 0 || f.log.length > 0).toBe(true);
    }

    const snapshotTimes = [0, ...live.filter(f => f.snapshot === 'dynamic').map(f => f.at)];
    expect(snapshotTimes.length).toBeGreaterThan(10);
    for (let i = 1; i < snapshotTimes.length; i++) {
      const gap = snapshotTimes[i] - snapshotTimes[i - 1];
      expect(gap).toBeGreaterThanOrEqual(COMBAT_SNAPSHOT_MS);
      expect(gap).toBeLessThan(COMBAT_SNAPSHOT_MS + sendEvery);
    }
    h.timer.destroy();
  });

  it('stamps every event with the real time of its step', () => {
    const h = timerHarness(longFight);
    h.timer.start();
    vi.advanceTimersByTime(10_000);

    const withEvents = h.flushes.filter(f => f.events.length > 0);
    expect(withEvents[0].events[0]).toMatchObject({ kind: 'battle_start', t: realStep });
    for (const flush of withEvents) {
      for (const event of flush.events) {
        expect(event.t % realStep).toBe(0);
        expect(event.t).toBeLessThanOrEqual(flush.at);
        expect(event.t).toBeGreaterThan(flush.at - sendEvery);
      }
    }
    h.timer.destroy();
  });

  it('lands the first hit on the stretched warm-up, with the finish and kill beat in real time', () => {
    const h = timerHarness(quickWin);
    h.timer.start();
    const finished = () => h.flushes.at(-1)!.events.find(e => e.kind === 'battle_end');
    for (let i = 0; i < 100 && !finished(); i++) vi.advanceTimersByTime(realStep);

    const finish = h.flushes.at(-1)!;
    expect(finished()).toMatchObject({ result: 'victory', t: finish.at });
    expect(h.timer.currentDuration).toBe(finish.at);
    expect(finish.at).toBeGreaterThanOrEqual(FIRST_ACTION_PLAYER_MS * pace.clock);
    expect(finish.at).toBeLessThanOrEqual(FIRST_ACTION_PLAYER_MS * pace.clock + realStep);

    vi.advanceTimersByTime(KILL_BEAT_MS - 1);
    expect(h.ends).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(h.ends).toEqual([{ result: 'victory', at: finish.at + KILL_BEAT_MS }]);
    h.timer.destroy();
  });
});

describe('ServerBattleTimer event delivery', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function eventsPlayed(pace: CombatPace) {
    const h = timerHarness(() => makeFight(pace, { damage: 1, monsterHp: 1_000_000 }));
    h.timer.start();
    const realStep = combatRealStepMs(h.timer.currentCombat!);
    vi.advanceTimersByTime(30_000);
    h.timer.destroy();
    const events = h.flushes.flatMap(f => f.events.map(e => ({ t: e.t, sentAt: f.at })));
    expect(events.length).toBeGreaterThan(10);
    return { realStep, events };
  }

  it('at COMBAT_PACE sends events on the step that made them, so none waits past the playback delay', () => {
    const { realStep, events } = eventsPlayed(COMBAT_PACE);
    expect(realStep).toBeLessThan(PLAYBACK_DELAY_MS);
    for (const { t, sentAt } of events) expect(sentAt).toBe(t);
  });

  it('at AUTHORED_PACE keeps batching events into a send every COMBAT_SEND_MS', () => {
    const { events } = eventsPlayed(AUTHORED_PACE);
    for (const { t, sentAt } of events) {
      expect(sentAt % COMBAT_SEND_MS).toBe(0);
      expect(sentAt - t).toBeLessThan(COMBAT_SEND_MS);
    }
    expect(events[0]).toEqual({ t: COMBAT_STEP_MS, sentAt: COMBAT_SEND_MS });
  });
});

const PIT: DungeonDefinition = {
  id: 'pit',
  name: 'The Pit',
  floors: [{
    floorNumber: 1,
    gridShape: { cols: 3, rows: 3 },
    encounterTable: [{ encounterId: 'warlord_court', weight: 1 }],
    isBoss: true,
  }],
};

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

function earned(w: ForecastWorld) {
  return { gold: w.session.getGold(), xp: w.session.toSaveData().character!.xp };
}

function earnedSince(w: ForecastWorld, before: { gold: number; xp: number }) {
  const now = earned(w);
  return { gold: now.gold - before.gold, xp: now.xp - before.xp };
}

/** Plays the party's fight through to its payout. Stops right after, before the next fight starts. */
function winFight(w: ForecastWorld) {
  const paid = vi.spyOn(w.session, 'handleVictory');
  const before = earned(w);
  w.entry().battleTimer.restartBattle();
  for (let i = 0; i < 100 && paid.mock.calls.length === 0; i++) vi.advanceTimersByTime(COMBAT_STEP_MS);
  expect(paid).toHaveBeenCalledTimes(1);
  paid.mockRestore();
  return earnedSince(w, before);
}

describe('COMBAT_PACE in the PartyBattleManager', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('fights', () => {
    it('reaches overworld fights', async () => {
      const w = await forecastWorld();
      w.entry().battleTimer.restartBattle();
      const combat = w.entry().battleTimer.currentCombat!;

      expect(combat.pace).toBe(COMBAT_PACE);
      expect(combat.players[0].kit).toBeCloseTo(COMBAT_PACE.classSeconds.Knight! / COMBAT_PACE.clock);
      vi.advanceTimersByTime(combatRealStepMs(combat) * 9);
      expect(combat.elapsedMs).toBe(COMBAT_STEP_MS * 9);
    });

    it('reaches dungeon fights', async () => {
      const w = await forecastWorld({ dungeon: { def: PIT, at: AT_START } });
      expect(w.pm.partyBattles.enterDungeon(w.partyId, 'pit').success).toBe(true);
      const combat = w.entry().battleTimer.currentCombat!;

      expect(combat.pace).toBe(COMBAT_PACE);
      expect(combat.players[0].kit).toBeCloseTo(COMBAT_PACE.classSeconds.Knight! / COMBAT_PACE.clock);
    });
  });

  describe('forecasts', () => {
    it('reaches room and dungeon forecast inputs', async () => {
      const w = await forecastWorld({ dungeon: { def: PIT, at: AT_START } });
      w.pm.partyBattles.setForecaster(w.svc);

      w.pm.handleForecastRequest('alice', { kind: 'room', tileId: tileId(2, 1) }, () => {});
      vi.advanceTimersByTime(50);
      w.pm.handleForecastRequest('alice', { kind: 'dungeon', dungeonId: 'pit' }, () => {});
      vi.advanceTimersByTime(50);

      const inputs = w.stub.jobs.map(j => j.input);
      expect(inputs.find(i => i.kind === 'room')).toMatchObject({ pace: COMBAT_PACE });
      expect(inputs.find(i => i.kind === 'dungeon')).toMatchObject({ pace: COMBAT_PACE });
    });

    it('reaches the auto-retreat pre-check and the live forecast of a fight', async () => {
      const w = await forecastWorld({ defaultEncounter: 'brutes' });
      w.pm.partyBattles.setForecaster(w.svc);
      w.entry().battleTimer.restartBattle();
      vi.advanceTimersByTime(50);

      const inputs = w.stub.jobs.map(j => j.input);
      expect(inputs.find(i => i.kind === 'room')).toMatchObject({ pace: COMBAT_PACE });
      expect((inputs.find(i => i.kind === 'battle') as BattleForecastInput).state.pace).toBe(COMBAT_PACE);
    });

    it('times a retreat decided mid-fight to RUN_AVAILABLE_MS of real time', async () => {
      const w = await forecastWorld();
      w.pm.partyBattles.setForecaster(w.svc);
      w.stub.verdicts.set(tileId(START.col, START.row), badPack('ogres'));
      w.stub.gated.add('room:');
      w.entry().battleTimer.restartBattle();
      const battleId = w.entry().battleTimer.battleId;
      const realStep = combatRealStepMs(w.entry().battleTimer.currentCombat!);

      vi.advanceTimersByTime(2000);
      w.stub.gated.clear();
      vi.advanceTimersByTime(firstStepAtOrPast(RUN_AVAILABLE_MS, realStep) - realStep - 2000);
      expect(w.entry().battleTimer.isFighting(battleId)).toBe(true);

      vi.advanceTimersByTime(2 * realStep);
      expect(w.entry().battleTimer.isFighting(battleId)).toBe(false);
      expect(w.journal()).toContain('Avoided Ogre (win chance 0%)');
    });
  });

  describe('rewards', () => {
    it('multiplies the XP and gold of a win', async () => {
      const w = await forecastWorld({ defaultEncounter: 'gnats' });
      stock(w, { gnat: { xp: 10, goldMin: 20, goldMax: 20 } });

      expect(winFight(w)).toEqual({
        xp: Math.ceil(10 * REWARD_MULTIPLIER),
        gold: Math.ceil(20 * REWARD_MULTIPLIER),
      });
    });

    it('scales a drop chance under 0.5 only as far as 0.5, and leaves one at or above it as authored', async () => {
      const w = await forecastWorld({ defaultEncounter: 'gnats' });
      stock(w, {
        gnat: {
          drops: [
            { itemId: 'under_floor', chance: 0.4 },
            { itemId: 'at_floor', chance: 0.5 },
            { itemId: 'above_floor', chance: 0.55 },
          ],
        },
      });
      const dropped = () => ['under_floor', 'at_floor', 'above_floor'].map(id => w.session.getInventoryCount(id));
      const roll = vi.spyOn(Math, 'random');

      roll.mockReturnValue(ROLL_ABOVE_DROP_FLOOR_BELOW_ITS_SCALED_CHANCES);
      winFight(w);
      expect(dropped()).toEqual([0, 0, 0]);

      roll.mockReturnValue(ROLL_ABOVE_AUTHORED_0_4_BELOW_PACED);
      winFight(w);
      expect(dropped()).toEqual([1, 1, 1]);
    });

    it('leaves floor and first-clear rewards as authored', async () => {
      const def: DungeonDefinition = {
        id: 'vault',
        name: 'The Vault',
        firstClearGold: 30,
        firstClearXp: 20,
        firstClearRewards: [{ itemId: 'first_clear_charm', chance: 0.4 }],
        floors: [{
          floorNumber: 1,
          gridShape: { cols: 3, rows: 3 },
          encounterTable: [{ encounterId: 'gnats', weight: 1 }],
          rewards: [
            { itemId: 'floor_charm', chance: 0.4 },
            { itemId: 'floor_stack', chance: 0.7, minQty: 2, maxQty: 2 },
          ],
        }],
      };
      const w = await forecastWorld({ dungeon: { def, at: AT_START } });
      stock(w, { gnat: { xp: 0, goldMin: 0, goldMax: 0 } });
      expect(w.pm.partyBattles.enterDungeon(w.partyId, 'vault').success).toBe(true);
      vi.spyOn(Math, 'random').mockReturnValue(ROLL_ABOVE_AUTHORED_0_4_BELOW_PACED);

      expect(winFight(w)).toEqual({ xp: 20, gold: 30 });
      expect(w.pm.partyBattles.getDungeonRunInfo(w.partyId)).toBeNull();
      expect(w.session.getInventoryCount('floor_charm')).toBe(0);
      expect(w.session.getInventoryCount('first_clear_charm')).toBe(0);
      expect(w.session.getInventoryCount('floor_stack')).toBe(2);
    });
  });

  describe('hire offers', () => {
    it("shows a hire's damage as it hits at its class's pace", async () => {
      const w = await forecastWorld();
      const classes: ClassName[] = ['Knight', 'Archer', 'Priest', 'Mage', 'Bard'];
      const henchmen: Record<string, HenchmanDefinition> = Object.fromEntries(classes.map(className => [className, {
        id: className, name: className, className, level: 3, maxHp: 80, baseDamage: 10, skillIds: [], emoji: 'x',
      }]));
      const shop = { id: 'hall', name: 'Hall', inventory: [], henchmanIds: classes };
      w.tiles.find(t => t.id === tileId(START.col, START.row))!.shopId = shop.id;
      Object.assign(w.content, {
        getShop: (id: string) => (id === shop.id ? shop : undefined),
        getHenchman: (id: string) => henchmen[id],
      });

      const shown = Object.fromEntries(w.session.getHenchmanOffers().map(o => [o.henchmanId, o.baseDamage]));

      for (const className of classes) {
        expect(shown[className]).toBe(Math.round((10 * COMBAT_PACE.classSeconds[className]!) / COMBAT_PACE.clock));
      }
      expect(shown.Priest).toBe(10);
    });
  });
});

describe('MCP getContentSchema', () => {
  it('returns combatPace for skills and monsters', async () => {
    for (const type of ['skills', 'monsters'] as const) {
      expect(await getContentSchema({ type })).toMatchObject({ combatPace: { ...COMBAT_PACE, note: expect.any(String) } });
    }
  });
});
