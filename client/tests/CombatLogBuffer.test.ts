import { describe, expect, it, vi } from 'vitest';
import type { CombatLogEntry } from '@idle-party-rpg/shared';
import { CombatLogBuffer } from '../src/combat/CombatLogBuffer';

function journal(...ids: number[]): CombatLogEntry[] {
  return ids.map(id => ({ id, text: `entry ${id}`, type: 'victory' as const }));
}

function texts(buffer: CombatLogBuffer): string[] {
  return buffer.entries.map(e => e.text);
}

describe('CombatLogBuffer journal merge', () => {
  it('appends journal entries once, keyed by id, across repeated state tails', () => {
    const buffer = new CombatLogBuffer();
    buffer.ingestJournal(journal(1, 2, 3));
    buffer.ingestJournal(journal(1, 2, 3));
    buffer.ingestJournal(journal(2, 3, 4));
    expect(buffer.entries.map(e => e.key)).toEqual(['j:1', 'j:2', 'j:3', 'j:4']);
    expect(buffer.entries.every(e => e.type === 'victory')).toBe(true);
  });

  it('assigns increasing seq numbers in arrival order', () => {
    const buffer = new CombatLogBuffer();
    buffer.ingestJournal(journal(5));
    buffer.pushLive(1, ['hit']);
    buffer.ingestJournal(journal(5, 6));
    const seqs = buffer.entries.map(e => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(texts(buffer)).toEqual(['entry 5', 'hit', 'entry 6']);
  });

  it('does not re-add journal entries that fell out of the ring', () => {
    const buffer = new CombatLogBuffer(3);
    buffer.ingestJournal(journal(1, 2, 3, 4));
    expect(buffer.entries.map(e => e.key)).toEqual(['j:2', 'j:3', 'j:4']);
    buffer.ingestJournal(journal(1, 2, 3, 4));
    expect(buffer.entries.map(e => e.key)).toEqual(['j:2', 'j:3', 'j:4']);
  });

  it('treats a lower newest id as a journal reset and ingests the new tail', () => {
    const buffer = new CombatLogBuffer();
    buffer.ingestJournal(journal(40, 41));
    buffer.pushLive(1, ['live']);
    const gen = buffer.generation;
    buffer.ingestJournal(journal(1, 2));
    expect(texts(buffer)).toEqual(['live', 'entry 1', 'entry 2']);
    expect(buffer.generation).toBeGreaterThan(gen);
  });

  it('notifies subscribers on change only', () => {
    const buffer = new CombatLogBuffer();
    const cb = vi.fn();
    const off = buffer.subscribe(cb);
    buffer.ingestJournal(journal(1));
    buffer.ingestJournal(journal(1));
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    buffer.ingestJournal(journal(2));
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('CombatLogBuffer ring cap', () => {
  it('keeps at most 300 lines by default, dropping the oldest', () => {
    const buffer = new CombatLogBuffer();
    for (let i = 0; i < 40; i++) buffer.pushLive(7, Array.from({ length: 10 }, (_, j) => `line ${i * 10 + j}`));
    expect(buffer.entries).toHaveLength(300);
    expect(buffer.entries[0].text).toBe('line 100');
    expect(buffer.entries[299].text).toBe('line 399');
  });

  it('keys live lines by battle, message sequence and index', () => {
    const buffer = new CombatLogBuffer();
    buffer.pushLive(9, ['a', 'b']);
    buffer.pushLive(9, ['a']);
    expect(buffer.entries.map(e => e.key)).toEqual(['c:9:1:0', 'c:9:1:1', 'c:9:2:0']);
    expect(buffer.entries.every(e => e.type === 'damage')).toBe(true);
  });
});

describe('CombatLogBuffer live release', () => {
  it('appends live lines immediately when not held', () => {
    const buffer = new CombatLogBuffer();
    buffer.pushLive(1, ['x'], 500);
    expect(texts(buffer)).toEqual(['x']);
  });

  it('holds live lines until playback reaches their release time', () => {
    const buffer = new CombatLogBuffer();
    buffer.setHoldLive(true);
    buffer.pushLive(1, ['first'], 1000);
    buffer.pushLive(1, ['second'], 1200);
    expect(texts(buffer)).toEqual([]);
    expect(buffer.pendingCount).toBe(2);
    buffer.release(1, 999);
    expect(texts(buffer)).toEqual([]);
    buffer.release(1, 1000);
    expect(texts(buffer)).toEqual(['first']);
    buffer.release(1, 5000);
    expect(texts(buffer)).toEqual(['first', 'second']);
  });

  it('releases lines of another battle at once, preserving order', () => {
    const buffer = new CombatLogBuffer();
    buffer.setHoldLive(true);
    buffer.pushLive(1, ['old'], 9000);
    buffer.pushLive(2, ['new'], 100);
    buffer.release(2, 0);
    expect(texts(buffer)).toEqual(['old']);
    buffer.release(2, 100);
    expect(texts(buffer)).toEqual(['old', 'new']);
  });

  it('flushes held lines when holding stops', () => {
    const buffer = new CombatLogBuffer();
    buffer.setHoldLive(true);
    buffer.pushLive(1, ['a'], 1000);
    buffer.setHoldLive(false);
    expect(texts(buffer)).toEqual(['a']);
    expect(buffer.pendingCount).toBe(0);
  });

  it('keeps journal entries flowing while live lines are held', () => {
    const buffer = new CombatLogBuffer();
    buffer.setHoldLive(true);
    buffer.pushLive(1, ['hit'], 1000);
    buffer.ingestJournal(journal(3));
    expect(texts(buffer)).toEqual(['entry 3']);
  });

  it('replaces a battle\'s live lines on resync without touching other lines', () => {
    const buffer = new CombatLogBuffer();
    buffer.ingestJournal(journal(1));
    buffer.pushLive(4, ['a', 'b']);
    buffer.pushLive(3, ['older battle']);
    buffer.setHoldLive(true);
    buffer.pushLive(4, ['c'], 50);
    const gen = buffer.generation;
    buffer.replaceLive(4, ['a', 'b', 'c', 'd']);
    expect(texts(buffer)).toEqual(['entry 1', 'older battle', 'a', 'b', 'c', 'd']);
    expect(buffer.pendingCount).toBe(0);
    expect(buffer.generation).toBeGreaterThan(gen);
  });
});
