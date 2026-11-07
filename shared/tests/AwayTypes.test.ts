import { describe, it, expect } from 'vitest';
import {
  AWAY_MAX_MOMENTS,
  AWAY_MAX_NOTABLE_ITEMS,
  AWAY_MAX_RETREATS,
  AWAY_MAX_DUNGEONS,
  AWAY_MIN_MS,
  createAwayLedger,
  closeAwayLedger,
  isAwayLedgerWorthRecap,
  awayRecapStyle,
  recordAwayBattle,
  recordAwayItem,
  recordAwayItemsLost,
  recordAwayRetreat,
  recordAwayDungeon,
  recordAwayMastery,
  recordAwayCloseCall,
  recordAwayRouteStopped,
  addAwayMoment,
  mergeAwayLedgers,
  topAwayMoments,
} from '../src/systems/AwayTypes';
import type { AwayLedger, AwayMomentKind } from '../src/systems/AwayTypes';

const MIN = 60_000;

function fresh(since = 0): AwayLedger {
  return createAwayLedger('L1', since, { level: 3, xpFrac: 0.2 });
}

describe('ledger basics', () => {
  it('starts empty at the given progress', () => {
    const l = fresh(1000);
    expect(l).toMatchObject({ id: 'L1', since: 1000, battles: 0, levelFrom: 3, levelTo: 3, xpFracFrom: 0.2, moments: [] });
    expect(l.until).toBeUndefined();
  });

  it('records battles without mutating the input', () => {
    const l = fresh();
    const next = recordAwayBattle(recordAwayBattle(l, { won: true, xp: 10, gold: 3, kills: 2 }), { won: false });
    expect(l.battles).toBe(0);
    expect(next).toMatchObject({ battles: 2, wins: 1, losses: 1, xp: 10, gold: 3, kills: 2 });
  });

  it('closes with the final progress', () => {
    const closed = closeAwayLedger(fresh(), 5 * MIN, { level: 4, xpFrac: 0.1 });
    expect(closed).toMatchObject({ until: 5 * MIN, levelTo: 4, xpFracTo: 0.1, levelFrom: 3 });
  });

  it('is worth a recap only after 5 minutes with a battle or retreat', () => {
    const l = fresh(0);
    expect(isAwayLedgerWorthRecap(recordAwayBattle(l, { won: true }), AWAY_MIN_MS - 1)).toBe(false);
    expect(isAwayLedgerWorthRecap(l, AWAY_MIN_MS)).toBe(false);
    expect(isAwayLedgerWorthRecap(recordAwayBattle(l, { won: true }), AWAY_MIN_MS)).toBe(true);
    expect(isAwayLedgerWorthRecap(recordAwayRetreat(l, { at: 1, kind: 'skip', from: 'A', winPct: 20 }), AWAY_MIN_MS)).toBe(true);
  });
});

describe('items', () => {
  it('counts every rarity and lists only rare+ items, rarest first', () => {
    let l = fresh();
    l = recordAwayItem(l, 'rag', 'common', 5);
    l = recordAwayItem(l, 'ring', 'rare');
    l = recordAwayItem(l, 'crown', 'legendary');
    l = recordAwayItem(l, 'ring', 'rare', 2);
    expect(l.items).toEqual({ common: 5, rare: 3, legendary: 1 });
    expect(l.notableItems.map(n => [n.itemId, n.count])).toEqual([['crown', 1], ['ring', 3]]);
  });

  it(`keeps at most ${AWAY_MAX_NOTABLE_ITEMS} notable items, dropping the least rare`, () => {
    let l = fresh();
    for (let i = 0; i < AWAY_MAX_NOTABLE_ITEMS; i++) l = recordAwayItem(l, `r${i}`, 'rare');
    l = recordAwayItem(l, 'epic', 'epic');
    expect(l.notableItems).toHaveLength(AWAY_MAX_NOTABLE_ITEMS);
    expect(l.notableItems[0].itemId).toBe('epic');
  });

  it('ignores empty grants and tracks lost items', () => {
    const l = fresh();
    expect(recordAwayItem(l, 'x', 'rare', 0)).toBe(l);
    expect(recordAwayItemsLost(l, 3).itemsLost).toBe(3);
  });
});

describe('retreats, dungeons, mastery, close calls', () => {
  it('counts skips as retreats and caps the log', () => {
    let l = fresh();
    for (let i = 0; i < AWAY_MAX_RETREATS + 3; i++) l = recordAwayRetreat(l, { at: i, kind: i % 2 ? 'relocate' : 'skip', from: 'A', winPct: 10 });
    expect(l.retreats).toBe(AWAY_MAX_RETREATS + 3);
    expect(l.skips).toBe(7);
    expect(l.retreatLog).toHaveLength(AWAY_MAX_RETREATS);
    expect(l.retreatLog[0].at).toBe(3);
  });

  it('updates an in-progress dungeon run instead of duplicating it', () => {
    let l = fresh();
    l = recordAwayDungeon(l, { dungeonId: 'd', name: 'D', outcome: 'in_progress' });
    l = recordAwayDungeon(l, { dungeonId: 'd', name: 'D', outcome: 'cleared' });
    l = recordAwayDungeon(l, { dungeonId: 'd', name: 'D', outcome: 'in_progress' });
    expect(l.dungeons.map(d => d.outcome)).toEqual(['cleared', 'in_progress']);
    for (let i = 0; i < AWAY_MAX_DUNGEONS + 2; i++) l = recordAwayDungeon(l, { dungeonId: `x${i}`, name: 'X', outcome: 'left' });
    expect(l.dungeons).toHaveLength(AWAY_MAX_DUNGEONS);
  });

  it('merges repeated rank-ups for one monster', () => {
    let l = fresh();
    l = recordAwayMastery(l, { monsterId: 'g', name: 'Goblin', rankFrom: 1, rankTo: 2 });
    l = recordAwayMastery(l, { monsterId: 'g', name: 'Goblin', rankFrom: 2, rankTo: 3 });
    expect(l.masteryUps).toEqual([{ monsterId: 'g', name: 'Goblin', rankFrom: 1, rankTo: 3 }]);
  });

  it('keeps the closest call and the latest route stop', () => {
    let l = fresh();
    l = recordAwayCloseCall(l, { hpPct: 20, vs: 'Wolf', where: 'A' });
    l = recordAwayCloseCall(l, { hpPct: 40, vs: 'Goblin', where: 'B' });
    l = recordAwayCloseCall(l, { hpPct: 5, vs: 'Bandit', where: 'C' });
    expect(l.closestCall).toEqual({ hpPct: 5, vs: 'Bandit', where: 'C' });
    expect(recordAwayRouteStopped(l, 9, 'Old Mill').routeStopped).toEqual({ at: 9, where: 'Old Mill' });
  });
});

describe('moments', () => {
  it(`caps at ${AWAY_MAX_MOMENTS}, evicting the lowest priority (oldest first)`, () => {
    let l = fresh();
    l = addAwayMoment(l, { at: 1, kind: 'level_up', text: 'Level 4' });
    for (let i = 0; i < AWAY_MAX_MOMENTS; i++) l = addAwayMoment(l, { at: 10 + i, kind: 'closest_call', text: `close ${i}` });
    expect(l.moments).toHaveLength(AWAY_MAX_MOMENTS);
    expect(l.moments[0].kind).toBe('level_up');
    expect(l.moments.some(m => m.text === 'close 0')).toBe(false);
    l = addAwayMoment(l, { at: 100, kind: 'mastery', text: 'Goblin rank 3' });
    expect(l.moments.filter(m => m.kind === 'closest_call')).toHaveLength(AWAY_MAX_MOMENTS - 2);
  });

  it('drops an incoming moment that is the lowest priority', () => {
    let l = fresh();
    for (let i = 0; i < AWAY_MAX_MOMENTS; i++) l = addAwayMoment(l, { at: i, kind: 'first_clear', text: `clear ${i}` });
    l = addAwayMoment(l, { at: 99, kind: 'relocate', text: 'fled' });
    expect(l.moments.every(m => m.kind === 'first_clear')).toBe(true);
  });

  it('keeps moments in time order and ranks the top ones by priority', () => {
    let l = fresh();
    const kinds: AwayMomentKind[] = ['mastery', 'level_up', 'rare_item', 'run_ended'];
    kinds.forEach((kind, i) => { l = addAwayMoment(l, { at: 50 - i, kind, text: kind }); });
    expect(l.moments.map(m => m.at)).toEqual([47, 48, 49, 50]);
    expect(topAwayMoments(l, 2).map(m => m.kind)).toEqual(['level_up', 'rare_item']);
  });
});

describe('recap style', () => {
  it('uses a toast for short, quiet absences and the modal otherwise', () => {
    const l = recordAwayBattle(fresh(0), { won: true });
    expect(awayRecapStyle(l, 12 * MIN)).toBe('toast');
    expect(awayRecapStyle(l, 45 * MIN)).toBe('modal');
    expect(awayRecapStyle(addAwayMoment(l, { at: 1, kind: 'eject', text: 'e' }), 12 * MIN)).toBe('modal');
    expect(awayRecapStyle(addAwayMoment(l, { at: 1, kind: 'run_ended', text: 'e' }), 12 * MIN)).toBe('modal');
    expect(awayRecapStyle(addAwayMoment(l, { at: 1, kind: 'relocate', text: 'r' }), 12 * MIN)).toBe('toast');
  });
});

describe('mergeAwayLedgers', () => {
  it('sums counts, spans the range and keeps first/last progress', () => {
    let a = recordAwayBattle(fresh(0), { won: true, xp: 5, gold: 1, kills: 2 });
    a = recordAwayItem(a, 'ring', 'rare');
    a = closeAwayLedger(a, 10 * MIN, { level: 4, xpFrac: 0.5 });
    let b = createAwayLedger('L2', 20 * MIN, { level: 4, xpFrac: 0.5 });
    b = recordAwayBattle(b, { won: false, xp: 1 });
    b = recordAwayItem(b, 'ring', 'rare');
    b = recordAwayItem(b, 'rag', 'common');
    b = recordAwayCloseCall(b, { hpPct: 3, vs: 'Wolf', where: 'A' });
    b = closeAwayLedger(b, 30 * MIN, { level: 5, xpFrac: 0.1 });
    const m = mergeAwayLedgers(a, b);
    expect(m).toMatchObject({
      id: 'L1', since: 0, until: 30 * MIN, battles: 2, wins: 1, losses: 1, xp: 6, gold: 1, kills: 2,
      levelFrom: 3, xpFracFrom: 0.2, levelTo: 5, xpFracTo: 0.1,
    });
    expect(m.items).toEqual({ rare: 2, common: 1 });
    expect(m.notableItems).toEqual([{ itemId: 'ring', count: 2, rarity: 'rare' }]);
    expect(m.closestCall?.hpPct).toBe(3);
    expect(a.notableItems[0].count).toBe(1);
  });

  it('re-applies the moment cap across both ledgers', () => {
    let a = fresh(0);
    let b = fresh(0);
    for (let i = 0; i < AWAY_MAX_MOMENTS; i++) {
      a = addAwayMoment(a, { at: i, kind: 'closest_call', text: 'a' });
      b = addAwayMoment(b, { at: 100 + i, kind: 'level_up', text: 'b' });
    }
    const m = mergeAwayLedgers(a, b);
    expect(m.moments).toHaveLength(AWAY_MAX_MOMENTS);
    expect(m.moments.every(x => x.kind === 'level_up')).toBe(true);
  });
});
