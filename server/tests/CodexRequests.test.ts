import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { ServerStateMessage } from '@idle-party-rpg/shared';
import { CODEX_REQUEST_BURST, CODEX_REQUEST_GAP_MS } from '../src/game/PlayerManager.js';
import type { PlayerSession } from '../src/game/PlayerSession.js';
import { CodexKnowledge } from '../src/game/codex/CodexKnowledge.js';
import { codexContent, codexManager, codexWorld, expectOnlyDiscovered, fakeSocket } from './codexFixture.js';
import type { FakeSocket } from './codexFixture.js';

async function setup() {
  const world = codexWorld();
  const content = codexContent(world);
  const { pm, hex } = codexManager(content, ['alice', 'newcomer']);
  const ws = fakeSocket();
  const alice = await pm.login(ws, 'alice');
  alice.setClass('Knight');
  pm.ensureParty('alice');
  const marker = (session: PlayerSession = alice) => session.getState([]).character!.codexVersion!;
  return { pm, world, content, hex, ws, alice, marker };
}

function lastState(ws: FakeSocket): ServerStateMessage | undefined {
  const states = ws.send.mock.calls
    .map(([payload]) => JSON.parse(payload as string) as { type: string })
    .filter((m): m is ServerStateMessage => m.type === 'state');
  return states[states.length - 1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('Codex requests', () => {
  it('answers a burst, drops a request that comes too soon, and answers again once the gap has passed', async () => {
    const { pm } = await setup();
    const now = 1_000_000;
    expect(CODEX_REQUEST_BURST).toBe(2);

    expect(pm.buildCodex('alice', now)).not.toBeNull();
    expect(pm.buildCodex('alice', now)).not.toBeNull();
    expect(pm.buildCodex('alice', now + 1000)).toBeNull();
    expect(pm.buildCodex('alice', now + CODEX_REQUEST_GAP_MS - 1)).toBeNull();
    expect(pm.buildCodex('alice', now + CODEX_REQUEST_GAP_MS)).not.toBeNull();
    expect(pm.buildCodex('alice', now + CODEX_REQUEST_GAP_MS + 1)).toBeNull();
  });

  it('answers nothing for a player without a character or without a session', async () => {
    const { pm } = await setup();
    await pm.login(fakeSocket(), 'newcomer');

    expect(pm.buildCodex('newcomer')).toBeNull();
    expect(pm.buildCodex('stranger')).toBeNull();
  });

  it('replies with a snapshot that holds only what the player has discovered', async () => {
    const { pm, content, alice } = await setup();
    alice.noteCodexFight([{ id: 'wolf', name: 'Wolf' }], { kind: 'room', encounterId: 'wolves', shopId: 'mill_post' });

    const reply = pm.buildCodex('alice')!;

    expect(reply.type).toBe('codex');
    expect(reply.monsters.map(m => m.id)).toEqual(['goblin', 'wolf']);
    expect(reply.shops.map(s => s.id)).toEqual(['mill_post']);
    const knowledge = CodexKnowledge.fromSave(alice.toSaveData().codex);
    expectOnlyDiscovered(reply, knowledge, content, alice.getUnlockedKeys(), alice.getMonsterKills());
  });
});

describe('Codex marker', () => {
  it('rides on the state push', async () => {
    const { pm, ws, marker } = await setup();
    pm.sendStateToPlayer('alice');
    expect(lastState(ws)?.character?.codexVersion).toBe(marker());
  });

  it('stays put while nothing the Codex shows changes', async () => {
    const { alice, marker } = await setup();
    const known = CodexKnowledge.fromSave(alice.toSaveData().codex);
    expect(known.hasEncounter('goblins')).toBe(true);
    expect(known.hasMonster('goblin')).toBe(true);
    const before = marker();

    alice.grantGold(5);
    expect(marker()).toBe(before);
    alice.noteCodexFight([{ id: 'goblin', name: 'Goblin' }], { kind: 'room', encounterId: 'goblins' });
    expect(marker()).toBe(before);

    alice.addToInventory('rope', 1);
    const afterRope = marker();
    alice.addToInventory('rope', 1);

    expect(afterRope).not.toBe(before);
    expect(marker()).toBe(afterRope);
  });

  it('moves on a new fact and on a raised drop tally', async () => {
    const { alice, hex, marker } = await setup();
    const start = marker();
    alice.noteCodexFight([{ id: 'wolf', name: 'Wolf' }], { kind: 'room' });
    const afterFight = marker();
    alice.handleVictory({ xp: 0, gold: 0, items: ['pelt'], itemSources: ['wolf'] }, hex('field'), { unlockTiles: false });
    const afterDrop = marker();
    alice.handleVictory({ xp: 0, gold: 0, items: ['pelt'], itemSources: ['wolf'] }, hex('field'), { unlockTiles: false });

    expect(new Set([start, afterFight, afterDrop, marker()]).size).toBe(4);
  });

  it('moves when content changes', async () => {
    const { content, marker } = await setup();
    const before = marker();
    content.contentEpoch++;
    expect(marker()).not.toBe(before);
  });

  it('moves when the player finds rooms', async () => {
    const { alice, hex, marker } = await setup();
    const before = marker();
    alice.forceUnlockTileArea(hex('ridge'));
    expect(marker()).not.toBe(before);
  });

  it('moves after a master reset, even when every count matches again', async () => {
    const { pm, alice, marker } = await setup();
    const before = marker();
    const session = pm.getSessionByUsername('alice')!;

    pm.masterReset();

    expect(pm.getSessionByUsername('alice')).toBe(session);
    expect(marker(alice)).not.toBe(before);
    expect(marker(alice).split('.')[0]).toBe(before.split('.')[0]);
  });
});
