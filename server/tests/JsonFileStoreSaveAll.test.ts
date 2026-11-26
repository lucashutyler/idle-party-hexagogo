import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileStore, SAVE_CHUNK_SIZE } from '../src/game/JsonFileStore.js';
import { GameLoop } from '../src/game/GameLoop.js';
import type { GameStateStore, PlayerSaveData } from '../src/game/GameStateStore.js';
import type { GuildStore } from '../src/game/social/GuildStore.js';
import type { TradeStore } from '../src/game/social/TradeStore.js';

function playerSave(username: string): PlayerSaveData {
  return {
    username,
    battleCount: 7,
    position: { col: 1, row: 2 },
    combatLog: Array.from({ length: 20 }, (_, i) => ({ text: `${username} line ${i}`, type: 'battle', timestamp: i })),
  } as unknown as PlayerSaveData;
}

const tick = () => new Promise<void>(resolve => setImmediate(resolve));

describe('JsonFileStore save pass', () => {
  let dir: string;
  let store: JsonFileStore;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'save-pass-'));
    store = new JsonFileStore(dir);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes every save of a large pass, and each reads back equal', async () => {
    const saves = Array.from({ length: 60 }, (_, i) => playerSave(`player_${String(i).padStart(2, '0')}`));

    await store.saveAll(saves);

    const loaded = (await store.loadAll()).sort((a, b) => a.username.localeCompare(b.username));
    expect(loaded).toEqual(saves);
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('yields to the event loop between chunks', async () => {
    const order: string[] = [];
    vi.spyOn(store, 'save').mockImplementation(async (data) => { order.push(data.username); });
    setImmediate(() => order.push('event loop'));

    await store.saveAll(Array.from({ length: SAVE_CHUNK_SIZE * 2 + 1 }, (_, i) => playerSave(`p${i}`)));

    expect(order.indexOf('event loop')).toBe(SAVE_CHUNK_SIZE);
    expect(order).toHaveLength(SAVE_CHUNK_SIZE * 2 + 2);
  });

  it('writes one-line JSON', async () => {
    await store.save(playerSave('alice'));

    const raw = await readFile(join(dir, 'alice.json'), 'utf-8');
    expect(raw).not.toContain('\n');
    expect(JSON.parse(raw)).toEqual(playerSave('alice'));
  });

  it('still loads a pretty-printed save from before', async () => {
    await writeFile(join(dir, 'alice.json'), JSON.stringify(playerSave('alice'), null, 2));

    expect(await store.load('alice')).toEqual(playerSave('alice'));
  });

  it('writes the rest of the pass when one save fails, rejects, and leaves no temp file', async () => {
    await mkdir(join(dir, 'bob.json', 'in-the-way'), { recursive: true });

    await expect(store.saveAll([playerSave('alice'), playerSave('bob'), playerSave('carol')])).rejects.toThrow();

    expect(await store.load('alice')).toEqual(playerSave('alice'));
    expect(await store.load('carol')).toEqual(playerSave('carol'));
    expect((await readdir(dir)).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });

  it('never reads a temp file or a save set aside', async () => {
    await store.save(playerSave('alice'));
    await writeFile(join(dir, 'bob.json.123.1.tmp'), JSON.stringify(playerSave('bob')));
    await writeFile(join(dir, 'carol.json.unreadable-123'), JSON.stringify(playerSave('carol')));

    expect((await store.loadAll()).map(save => save.username)).toEqual(['alice']);
  });
});

describe('GameLoop.saveAll', () => {
  function loopWithHeldFirstPass() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const events: string[] = [];
    let releaseFirst = () => {};
    const firstHeld = new Promise<void>(resolve => { releaseFirst = resolve; });
    let passes = 0;
    const playerStore = { saveAll: async () => {} } as unknown as GameStateStore;
    const loop = new GameLoop(playerStore);
    const playerManager = {
      sessionCount: 0,
      trades: { getAllTrades: () => [] },
      tickAllCrafting: () => {},
      addShutdownLog: () => events.push('shutdown log'),
      saveAll: async () => {
        const pass = ++passes;
        events.push(`start ${pass}`);
        if (pass === 1) await firstHeld;
        events.push(`end ${pass}`);
      },
    };
    (loop as unknown as { playerManager: unknown }).playerManager = playerManager;
    const stores = loop as unknown as { guildStore: GuildStore; tradeStore: TradeStore };
    vi.spyOn(stores.guildStore, 'save').mockResolvedValue();
    vi.spyOn(stores.tradeStore, 'save').mockResolvedValue();
    vi.spyOn(loop.contentStore, 'persistIfDirty').mockResolvedValue();
    vi.spyOn(loop.versionStore, 'save').mockResolvedValue();
    return { loop, events, releaseFirst };
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('runs two overlapping passes one after the other', async () => {
    const { loop, events, releaseFirst } = loopWithHeldFirstPass();

    const first = loop.saveAll();
    const second = loop.saveAll();
    await tick();
    expect(events).toEqual(['start 1']);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });

  it('has shutdown wait for a pass in flight, then save again', async () => {
    const { loop, events, releaseFirst } = loopWithHeldFirstPass();
    let shutDown = false;

    const periodic = loop.saveAll();
    await tick();
    const shutdown = loop.shutdown().then(() => { shutDown = true; });
    await tick();
    expect(shutDown).toBe(false);

    releaseFirst();
    await Promise.all([periodic, shutdown]);
    expect(events).toEqual(['start 1', 'shutdown log', 'end 1', 'start 2', 'end 2']);
  });

  it('runs the next pass after one fails', async () => {
    const { loop, events, releaseFirst } = loopWithHeldFirstPass();
    vi.spyOn(loop.versionStore, 'save').mockRejectedValueOnce(new Error('disk full'));

    const first = loop.saveAll();
    const second = loop.saveAll();
    releaseFirst();

    await expect(first).rejects.toThrow('disk full');
    await second;
    expect(events).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
  });
});
