import { describe, it, expect } from 'vitest';
import { CODEX_CAPS, CODEX_DROP_TALLY_MAX, CODEX_ID_MAX_LENGTH, CODEX_RECENT_MAX } from '@idle-party-rpg/shared';
import { CodexKnowledge } from '../src/game/codex/CodexKnowledge.js';

const room = (encounterId?: string, shopId?: string) => ({ kind: 'room' as const, encounterId, shopId });

function roundTrip(knowledge: CodexKnowledge): CodexKnowledge {
  return CodexKnowledge.fromSave(JSON.parse(JSON.stringify(knowledge.toSave() ?? null)));
}

describe('CodexKnowledge notes', () => {
  it('adds each fact once, in discovery order, and reports newly met monsters', () => {
    const k = new CodexKnowledge();
    expect(k.noteFight(['wolf', 'goblin', 'wolf'], room('pack', 'mill_post'))).toEqual(['wolf', 'goblin']);
    expect(k.noteFight(['goblin', 'bear'], room('pack'))).toEqual(['bear']);
    expect(k.monsterIds()).toEqual(['wolf', 'goblin', 'bear']);
    expect(k.encounterIds()).toEqual(['pack']);
    expect(k.shopIds()).toEqual(['mill_post']);
    expect(k.hasMonster('bear')).toBe(true);
    expect(k.hasEncounter('pack')).toBe(true);
    expect(k.hasShop('mill_post')).toBe(true);
  });

  it('records a dungeon fight without an encounter or a shop', () => {
    const k = new CodexKnowledge();
    k.noteFight(['bat'], { kind: 'dungeon', dungeonId: 'damp_cave' });
    expect(k.dungeonIds()).toEqual(['damp_cave']);
    expect(k.encounterIds()).toEqual([]);
    expect(k.shopIds()).toEqual([]);
  });

  it('bumps the revision on every change and not on a repeat', () => {
    const k = new CodexKnowledge();
    expect(k.revision).toBe(0);
    k.noteFight(['wolf'], room('pack', 'mill_post'));
    expect(k.revision).toBe(3);
    k.noteFight(['wolf'], room('pack', 'mill_post'));
    expect(k.revision).toBe(3);
    k.noteItem('pelt');
    expect(k.revision).toBe(4);
    k.noteItem('pelt');
    expect(k.revision).toBe(4);
    k.noteDrop('wolf', 'pelt');
    expect(k.revision).toBe(5);
    k.noteDrop('wolf', 'pelt');
    expect(k.revision).toBe(6);
  });

  it('counts drop tallies, adds the item, and stops at the tally cap', () => {
    const k = new CodexKnowledge();
    k.noteDrop('wolf', 'pelt');
    k.noteDrop('wolf', 'pelt');
    k.noteDrop('wolf', 'fang');
    expect([...k.dropsOf('wolf')]).toEqual([['pelt', 2], ['fang', 1]]);
    expect(k.itemIds()).toEqual(['pelt', 'fang']);
    expect(k.dropsOf('bear').size).toBe(0);

    const full = CodexKnowledge.fromSave({ items: ['pelt'], drops: { wolf: { pelt: CODEX_DROP_TALLY_MAX } } });
    const before = full.revision;
    full.noteDrop('wolf', 'pelt');
    expect(full.dropsOf('wolf').get('pelt')).toBe(CODEX_DROP_TALLY_MAX);
    expect(full.revision).toBe(before);
  });

  it('skips adds past a cap', () => {
    const many = Array.from({ length: CODEX_CAPS.shops }, (_, i) => `shop_${i}`);
    const k = CodexKnowledge.fromSave({ shops: many });
    expect(k.shopIds()).toHaveLength(CODEX_CAPS.shops);
    k.noteFight([], room(undefined, 'one_more'));
    expect(k.hasShop('one_more')).toBe(false);
    expect(k.revision).toBe(0);
  });

  it('caps drop pairs', () => {
    const drops: Record<string, Record<string, number>> = {};
    for (let i = 0; i < CODEX_CAPS.dropPairs; i++) drops[`m${i % 1000}`] = { ...drops[`m${i % 1000}`], [`i${i}`]: 1 };
    const k = CodexKnowledge.fromSave({ drops });
    k.noteDrop('wolf', 'pelt');
    expect(k.dropsOf('wolf').size).toBe(0);
    expect(k.hasItem('pelt')).toBe(true);
  });

  it('skips ids that are empty or too long', () => {
    const k = new CodexKnowledge();
    const long = 'x'.repeat(CODEX_ID_MAX_LENGTH + 1);
    expect(k.noteFight(['', long], room(long, ''))).toEqual([]);
    k.noteItem(long);
    k.noteDrop(long, 'pelt');
    expect(k.toSave()).toEqual({ items: ['pelt'], recent: [{ kind: 'item', id: 'pelt' }] });
  });
});

describe('CodexKnowledge recent', () => {
  it('puts new monsters, items and shops at the front, never encounters or dungeons', () => {
    const k = new CodexKnowledge();
    k.noteFight(['wolf'], room('pack', 'mill_post'));
    k.noteItem('pelt');
    k.noteFight(['bat'], { kind: 'dungeon', dungeonId: 'damp_cave' });
    expect(k.recentRefs()).toEqual([
      { kind: 'monster', id: 'bat' },
      { kind: 'item', id: 'pelt' },
      { kind: 'shop', id: 'mill_post' },
      { kind: 'monster', id: 'wolf' },
    ]);
  });

  it('moves an equal ref to the front and keeps the newest 20', () => {
    const k = CodexKnowledge.fromSave({ recent: [{ kind: 'item', id: 'a' }, { kind: 'item', id: 'pelt' }] });
    k.noteItem('pelt');
    expect(k.recentRefs().slice(0, 2)).toEqual([{ kind: 'item', id: 'pelt' }, { kind: 'item', id: 'a' }]);

    for (let i = 0; i < 30; i++) k.noteItem(`item_${i}`);
    const recent = k.recentRefs();
    expect(recent).toHaveLength(CODEX_RECENT_MAX);
    expect(recent[0]).toEqual({ kind: 'item', id: 'item_29' });
    expect(recent[CODEX_RECENT_MAX - 1]).toEqual({ kind: 'item', id: 'item_10' });
  });

  it('hands out copies', () => {
    const k = new CodexKnowledge();
    k.noteItem('pelt');
    (k.recentRefs() as unknown as { id: string }[])[0].id = 'changed';
    (k.itemIds() as string[]).push('changed');
    expect(k.recentRefs()).toEqual([{ kind: 'item', id: 'pelt' }]);
    expect(k.itemIds()).toEqual(['pelt']);
  });
});

describe('CodexKnowledge backfill', () => {
  it('adds silently: no recent line and no revision bump', () => {
    const k = new CodexKnowledge();
    k.mergeBackfill({ monsters: ['wolf'], items: new Set(['pelt']), dungeons: ['damp_cave'] });
    expect(k.monsterIds()).toEqual(['wolf']);
    expect(k.itemIds()).toEqual(['pelt']);
    expect(k.dungeonIds()).toEqual(['damp_cave']);
    expect(k.recentRefs()).toEqual([]);
    expect(k.revision).toBe(0);
  });

  it('keeps what is already known and does not make a backfilled monster new again', () => {
    const k = new CodexKnowledge();
    k.noteFight(['goblin'], room());
    k.mergeBackfill({ monsters: ['wolf', 'goblin'], items: [], dungeons: [] });
    expect(k.monsterIds()).toEqual(['goblin', 'wolf']);
    expect(k.noteFight(['wolf'], room())).toEqual([]);
  });
});

describe('CodexKnowledge save', () => {
  it('leaves out empty parts and writes nothing when empty', () => {
    expect(new CodexKnowledge().toSave()).toBeUndefined();
    const k = new CodexKnowledge();
    k.mergeBackfill({ monsters: ['wolf'], items: [], dungeons: [] });
    expect(k.toSave()).toEqual({ monsters: ['wolf'] });
  });

  it('round-trips through JSON', () => {
    const k = new CodexKnowledge();
    k.noteFight(['wolf', 'goblin'], room('pack', 'mill_post'));
    k.noteFight(['bat'], { kind: 'dungeon', dungeonId: 'damp_cave' });
    k.noteDrop('wolf', 'pelt');
    k.noteDrop('wolf', 'pelt');
    const restored = roundTrip(k);
    expect(restored.toSave()).toEqual(k.toSave());
    expect([...restored.dropsOf('wolf')]).toEqual([['pelt', 2]]);
  });

  it('keeps ids that are built-in object keys in every list and in drops', () => {
    const odd = ['constructor', '__proto__', 'toString'];
    const k = new CodexKnowledge();
    k.noteFight(odd, room('constructor', '__proto__'));
    k.noteFight([], { kind: 'dungeon', dungeonId: 'toString' });
    for (const monsterId of odd) for (const itemId of odd) k.noteDrop(monsterId, itemId);
    const saved = k.toSave()!;
    expect(Object.keys(saved.drops!).sort()).toEqual([...odd].sort());
    expect(Object.getPrototypeOf(saved.drops)).toBe(Object.prototype);

    const restored = roundTrip(k);
    expect(restored.monsterIds()).toEqual(odd);
    expect(restored.itemIds()).toEqual(odd);
    expect(restored.encounterIds()).toEqual(['constructor']);
    expect(restored.shopIds()).toEqual(['__proto__']);
    expect(restored.dungeonIds()).toEqual(['toString']);
    for (const monsterId of odd) expect([...restored.dropsOf(monsterId)].sort()).toEqual(odd.map(id => [id, 1]).sort());
    expect(restored.dropsOf('hasOwnProperty').size).toBe(0);
  });

  it('turns garbage at every level into sane parts without throwing', () => {
    const long = 'x'.repeat(CODEX_ID_MAX_LENGTH + 1);
    const garbage: unknown[] = [
      null, undefined, 7, 'codex', [], [1, 2], true,
      { monsters: 'wolf', encounters: { a: 1 }, items: null, shops: 5, dungeons: [{}] },
      { monsters: ['wolf', 7, null, '', long, 'wolf', ['goblin'], { id: 'bear' }] },
      { drops: ['wolf'] },
      { drops: { wolf: ['pelt'], bear: null, [long]: { pelt: 1 }, goblin: { ear: -1, tooth: 2.5, eye: Infinity, nose: NaN, horn: '3', claw: 4, [long]: 1, '': 1 } } },
      { drops: { wolf: { pelt: 5e12 } } },
      { recent: [null, 'monster:wolf', { kind: 'npc', id: 'x' }, { kind: 'room', id: 'r1' }, { kind: 'monster', id: '' }, { kind: 'monster', id: 'wolf' }, { kind: 'monster', id: 'wolf' }, { kind: 'shop', id: 'mill_post', extra: 1 }] },
      { recent: { kind: 'monster', id: 'wolf' } },
    ];
    const results = garbage.map(raw => CodexKnowledge.fromSave(raw).toSave());
    expect(results.slice(0, 8)).toEqual([undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
    expect(results[8]).toEqual({ monsters: ['wolf'] });
    expect(results[9]).toBeUndefined();
    expect(results[10]).toEqual({ drops: { goblin: { claw: 4 } } });
    expect(results[11]).toEqual({ drops: { wolf: { pelt: CODEX_DROP_TALLY_MAX } } });
    expect(results[12]).toEqual({ recent: [{ kind: 'monster', id: 'wolf' }, { kind: 'shop', id: 'mill_post' }] });
    expect(results[13]).toBeUndefined();
  });

  it('survives a save whose getters throw', () => {
    const hostile = { get monsters(): string[] { throw new Error('boom'); } };
    expect(() => CodexKnowledge.fromSave(hostile)).not.toThrow();
    expect(CodexKnowledge.fromSave(hostile).toSave()).toBeUndefined();
  });

  it('gives every object its own serial', () => {
    const a = new CodexKnowledge();
    const b = CodexKnowledge.fromSave(a.toSave());
    expect(a.serial).not.toBe(b.serial);
    expect(new CodexKnowledge().serial).toBeGreaterThan(b.serial);
  });
});
