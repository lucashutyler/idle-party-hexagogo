import { describe, it, expect } from 'vitest';
import type { CodexSaveData } from '@idle-party-rpg/shared';
import { PlayerSession } from '../src/game/PlayerSession.js';
import type { PlayerSaveData } from '../src/game/GameStateStore.js';
import { CodexKnowledge } from '../src/game/codex/CodexKnowledge.js';
import { codexContent, codexGrid } from './codexFixture.js';
import { wrapGrids } from './testGrids.js';

function setup() {
  const content = codexContent();
  const grid = codexGrid(content);
  const grids = wrapGrids(grid);
  const session = new PlayerSession('alice', grids, content);
  session.setClass('Knight');
  const restore = (data: PlayerSaveData) => PlayerSession.fromSaveData(JSON.parse(JSON.stringify(data)), grids, content);
  const marker = (s: PlayerSession) => s.getState([]).character!.codexVersion!;
  return { content, grids, session, restore, marker, start: session.getStartingTile() };
}

/** A save as a build without the Codex writes it. */
function olderSave(session: PlayerSession, extra: Partial<PlayerSaveData> = {}): PlayerSaveData {
  const { codex: _dropped, ...rest } = session.toSaveData();
  return { ...rest, ...extra };
}

const revisionOf = (marker: string): string => marker.split('.')[2];

describe('Codex save and restore', () => {
  it('round-trips everything the knowledge holds', () => {
    const { session, restore, start } = setup();
    session.noteCodexFight([{ id: 'wolf', name: 'Wolf' }, { id: 'goblin', name: 'Goblin' }], { kind: 'room', encounterId: 'wolves', shopId: 'mill_post' });
    session.noteCodexFight([{ id: 'bat', name: 'Cave Bat' }], { kind: 'dungeon', dungeonId: 'damp_cave' });
    session.handleVictory({ xp: 0, gold: 0, items: ['pelt', 'pelt', 'ear'], itemSources: ['wolf', 'wolf', 'goblin'] }, start);
    const saved = session.toSaveData().codex;

    const restored = restore(session.toSaveData());

    expect(saved).toEqual({
      monsters: ['wolf', 'goblin', 'bat'],
      encounters: ['wolves'],
      items: ['pelt', 'ear'],
      shops: ['mill_post'],
      dungeons: ['damp_cave'],
      drops: { wolf: { pelt: 2 }, goblin: { ear: 1 } },
      recent: [
        { kind: 'item', id: 'ear' },
        { kind: 'item', id: 'pelt' },
        { kind: 'monster', id: 'bat' },
        { kind: 'shop', id: 'mill_post' },
        { kind: 'monster', id: 'goblin' },
        { kind: 'monster', id: 'wolf' },
      ],
    });
    expect(restored.toSaveData().codex).toEqual(saved);
  });

  it('writes no field for a Codex with nothing in it', () => {
    const { session } = setup();
    expect('codex' in JSON.parse(JSON.stringify(session.toSaveData()))).toBe(false);
  });

  it('fills a save without the field from kills, bag, gear, completed quest rewards and dungeons, silently', () => {
    const { session, restore, marker } = setup();
    const save = olderSave(session, {
      monsterKills: { wolf: 3, bear: 0, goblin: 2.5 },
      character: { ...session.toSaveData().character!, inventory: { pelt: 2 }, equipment: { head: 'lamp', chest: null } },
      completedQuests: [{ questId: 'delivery', completedAt: '2026-01-01T00:00:00.000Z' }, { questId: 'gone_quest', completedAt: '2026-01-01T00:00:00.000Z' }],
      clearedDungeons: ['damp_cave'],
      dungeonRun: { dungeonId: 'sunken_vault', currentFloorIndex: 0, entrance: { col: 0, row: 1 } },
    });

    const restored = restore(save);

    expect(restored.toSaveData().codex).toEqual({
      monsters: ['wolf'],
      items: ['pelt', 'lamp', 'sword'],
      dungeons: ['damp_cave', 'sunken_vault'],
    });
    expect(revisionOf(marker(restored))).toBe('0');
    expect(restored.toSaveData().combatLog.filter(l => l.type === 'codex')).toEqual([]);
  });

  it('adds kills made on an older build to a Codex already saved', () => {
    const { session, restore } = setup();
    session.noteCodexFight([{ id: 'goblin', name: 'Goblin' }], { kind: 'room', encounterId: 'goblins' });
    const save = { ...session.toSaveData(), monsterKills: { goblin: 1, wolf: 6 } };

    expect(restore(save).toSaveData().codex?.monsters).toEqual(['goblin', 'wolf']);
  });

  it('restores a malformed field to the backfill alone, never throwing', () => {
    const { session, restore } = setup();
    const junk: unknown[] = [null, 'codex', 42, [], { monsters: 5, drops: [], recent: 'x' }, { monsters: [{}], items: [null] }];
    for (const codex of junk) {
      const save = { ...olderSave(session), monsterKills: { wolf: 1 }, codex: codex as CodexSaveData };
      expect(restore(save).toSaveData().codex).toEqual({ monsters: ['wolf'] });
    }
  });

  it('survives a save with a broken dungeon run and odd equipment', () => {
    const { session, restore } = setup();
    const save = olderSave(session, {
      dungeonRun: 7 as unknown as PlayerSaveData['dungeonRun'],
      character: { ...session.toSaveData().character!, equipment: { head: 5 as unknown as string, ring: '' } },
    });

    expect(restore(save).toSaveData().codex).toBeUndefined();
  });

  it('is cleared by a master reset, which moves the marker', () => {
    const { session, marker, start } = setup();
    session.noteCodexFight([{ id: 'wolf', name: 'Wolf' }], { kind: 'room' });
    const before = marker(session);

    session.resetForMasterReset(start);

    expect(session.toSaveData().codex).toBeUndefined();
    expect(marker(session)).not.toBe(before);
    expect(revisionOf(marker(session))).toBe('0');
  });

  it('keeps a large Codex small in the save', () => {
    const id = (kind: string, i: number) => `${kind}-${String(i).padStart(5, '0')}`.padEnd(36, '0');
    const range = (n: number) => Array.from({ length: n }, (_, i) => i);
    const big = new CodexKnowledge();
    big.mergeBackfill({
      monsters: range(100).map(i => id('m', i)),
      items: range(300).map(i => id('i', i)),
      dungeons: range(10).map(i => id('d', i)),
    });
    for (const i of range(150)) big.noteFight([], { kind: 'room', encounterId: id('e', i), shopId: i < 20 ? id('s', i) : undefined });
    for (const m of range(100)) for (const d of range(5)) for (let n = 0; n < 3; n++) big.noteDrop(id('m', m), id('i', m * 3 + d));

    const bytes = JSON.stringify(big.toSave()).length;

    expect(bytes).toBeLessThan(64 * 1024);
  });
});

