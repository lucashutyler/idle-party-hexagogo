import { vi } from 'vitest';
import { HexGrid, HexTile, offsetToCube, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type {
  ClassName,
  DungeonDefinition,
  EncounterDefinition,
  ForecastInput,
  ForecastJob,
  ForecastJobOptions,
  ForecastResult,
  ForecastStratum,
  MonsterDefinition,
  WorldTileDefinition,
  ZoneDefinition,
} from '@idle-party-rpg/shared';
import type WebSocket from 'ws';
import { PlayerManager } from '../src/game/PlayerManager.js';
import { GuildStore } from '../src/game/social/GuildStore.js';
import { ForecastService, roomForecastKey } from '../src/game/ForecastService.js';
import type { ContentStore } from '../src/game/ContentStore.js';
import type { GameStateStore } from '../src/game/GameStateStore.js';
import type { AccountStore, Account } from '../src/auth/AccountStore.js';
import type { ServerBattleTimer } from '../src/game/ServerBattleTimer.js';
import type { ServerParty } from '../src/game/ServerParty.js';
import { wrapGrids, fakeWorldMeta, fakeSkillContent } from './testGrids.js';

function monster(id: string, name: string, hp: number, extra: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return { id, name, hp, damage: 0, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0, ...extra };
}

export const MONSTERS: Record<string, MonsterDefinition> = {
  goblin: monster('goblin', 'Goblin', 1_000_000),
  ogre: monster('ogre', 'Ogre', 1_000_000),
  gnat: monster('gnat', 'Gnat', 1),
  brute: monster('brute', 'Brute', 1_000_000, { tier: 'elite' }),
  frail_brute: monster('frail_brute', 'Frail Brute', 1, { tier: 'elite' }),
  warlord: monster('warlord', 'Warlord', 1_000_000, { tier: 'boss' }),
};

function explicit(id: string, name: string, monsterId: string): EncounterDefinition {
  return { id, name, type: 'explicit', placements: [{ monsterId, gridPosition: 4 }] };
}

export const ENCOUNTERS: Record<string, EncounterDefinition> = {
  ogres: explicit('ogres', 'Ogres', 'ogre'),
  gnats: explicit('gnats', 'Gnats', 'gnat'),
  brutes: explicit('brutes', 'Brutes', 'brute'),
  frail_brutes: explicit('frail_brutes', 'Frail Brutes', 'frail_brute'),
  warlord_court: explicit('warlord_court', 'Warlord Court', 'warlord'),
};

export const START = { col: 1, row: 1 };

export function tileId(col: number, row: number): string {
  return `t-${col}-${row}`;
}

/** A room forecast the stub hands back. */
export interface Verdict {
  winPct: number;
  ci: [number, number];
  sims?: number;
  strata?: ForecastStratum[];
}

export const SAFE: Verdict = { winPct: 100, ci: [98, 100], sims: 200 };
export const DEADLY: Verdict = { winPct: 0, ci: [0, 2], sims: 200 };

/** A room that is fine overall, but whose `entryId` pack loses every fight. */
export function badPack(entryId: string): Verdict {
  return {
    winPct: 60,
    ci: [53, 67],
    sims: 200,
    strata: [
      { entryId, label: 'Bad pack', winPct: 0, sharePct: 40 },
      { entryId: 'easy', label: 'Easy pack', winPct: 100, sharePct: 60 },
    ],
  };
}

/** Forecast jobs that finish on their first slice with a canned verdict per room (gated keys never finish). */
export function forecastStub(clock: { extra: number }) {
  const verdicts = new Map<string, Verdict>();
  const fallback = { verdict: SAFE };
  const gated = new Set<string>();
  const jobs: { key: string; input: ForecastInput }[] = [];
  const createJob = (input: ForecastInput, opts: ForecastJobOptions): ForecastJob => {
    jobs.push({ key: opts.key, input });
    let done = false;
    return {
      get done() { return done; },
      get sims() { return done ? 1 : 0; },
      maxSims: 1,
      runSims: () => 0,
      advance: () => {
        clock.extra += 1;
        if ([...gated].some(g => opts.key.includes(g))) return 0;
        done = true;
        return 1;
      },
      result: (): ForecastResult => {
        const room = /room:(.+)$/.exec(opts.key)?.[1];
        const v = (room ? verdicts.get(room) : undefined) ?? fallback.verdict;
        return {
          key: opts.key, partyKey: opts.partyKey ?? '', sims: v.sims ?? 200, wins: 0, losses: 0, stalemates: 0,
          winPct: v.winPct, ci: v.ci, medianMs: null, p90Ms: null, atMs: 0, killEtaMs: null, reasons: [],
          ...(v.strata ? { strata: v.strata } : {}),
        };
      },
    };
  };
  return { verdicts, fallback, gated, jobs, createJob };
}

export interface FakeWs {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

export function createWs(): FakeWs {
  return { readyState: 1, OPEN: 1, bufferedAmount: 0, send: vi.fn(), close: vi.fn(), on: vi.fn() };
}

/** Forecast messages this socket received, oldest first. */
export function forecastMessages(ws: FakeWs): { target: { kind: string; battleId?: number }; key: string; status: string; result: ForecastResult | null }[] {
  return ws.send.mock.calls
    .map(([payload]) => JSON.parse(String(payload)))
    .filter((m: { type: string }) => m.type === 'forecast');
}

export interface EntryView {
  partyId: string;
  battleTimer: ServerBattleTimer;
  serverParty: ServerParty;
  retreatHold?: { tileId: string };
  pendingRetreat?: unknown;
  dungeonRun?: unknown;
}

export interface WorldOptions {
  /** Encounter id per room, keyed `col,row`; the rest use `defaultEncounter` ('ogres'). */
  encounters?: Record<string, string>;
  defaultEncounter?: string;
  dungeon?: { def: DungeonDefinition; at: string };
  users?: string[];
}

/** A 4×3 overworld around START, a PlayerManager with a Knight "alice", and a stubbed forecaster (not yet wired). */
export async function forecastWorld(opts: WorldOptions = {}) {
  const grid = new HexGrid();
  const tiles: WorldTileDefinition[] = [];
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 3; row++) {
      const id = tileId(col, row);
      const encounterId = opts.encounters?.[`${col},${row}`] ?? opts.defaultEncounter ?? 'ogres';
      const dungeonId = opts.dungeon?.at === `${col},${row}` ? opts.dungeon.def.id : undefined;
      grid.addTile(new HexTile(offsetToCube({ col, row }), 'forest', 'z', id));
      tiles.push({
        id, mapId: DEFAULT_MAP_ID, col, row, type: 'forest', zone: 'z', name: `Room ${col}-${row}`,
        encounterTable: [{ encounterId, weight: 1 }],
        ...(dungeonId ? { dungeonId } : {}),
      });
    }
  }
  tiles.push({ id: 'elsewhere', mapId: 'other_map', col: 0, row: 0, type: 'forest', zone: 'z', name: 'Elsewhere' });

  const zone = { id: 'z', displayName: 'Zed Wilds', encounterTable: [{ encounterId: 'ogres', weight: 1 }], levelRange: [1, 5] } as ZoneDefinition;
  const dungeons: Record<string, DungeonDefinition> = opts.dungeon ? { [opts.dungeon.def.id]: opts.dungeon.def } : {};
  const contentState = { contentEpoch: 0 };
  const content = {
    get contentEpoch() { return contentState.contentEpoch; },
    getStartTile: () => START,
    getMonster: (id: string) => MONSTERS[id],
    getItem: () => undefined,
    getAllMonsters: () => MONSTERS,
    getAllItems: () => ({}),
    getZone: (id: string) => (id === 'z' ? zone : undefined),
    getAllZones: () => ({ z: zone }),
    getEncounter: (id: string) => ENCOUNTERS[id],
    getAllEncounters: () => ENCOUNTERS,
    getTileById: (id: string) => tiles.find(t => t.id === id),
    getAllShops: () => ({}),
    getShop: () => undefined,
    getWorld: () => ({ tiles, startTile: START, ...fakeWorldMeta(START) }),
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
    getDungeon: (id: string) => dungeons[id],
    getAllDungeons: () => dungeons,
    getHenchman: () => undefined,
    ...fakeSkillContent(),
  } as unknown as ContentStore;

  const users = opts.users ?? ['alice', 'bob'];
  const accounts: Record<string, Account> = {};
  for (const u of users) accounts[u] = { username: u, email: `${u}@x.com`, deactivated: false } as unknown as Account;
  const accountStore = {
    findByUsername: (u: string) => accounts[u] ?? null,
    getAllUsernames: () => users,
    updateLastActive: vi.fn().mockResolvedValue(undefined),
  } as unknown as AccountStore;
  const store = {
    save: vi.fn().mockResolvedValue(undefined),
    saveAll: vi.fn().mockResolvedValue(undefined),
    load: vi.fn().mockResolvedValue(null),
    loadAll: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
  } as unknown as GameStateStore;

  const pm = new PlayerManager(wrapGrids(grid), content, new GuildStore(), accountStore, store);
  const ws = createWs();
  const session = await pm.login(ws as unknown as WebSocket, 'alice');
  session.setClass('Knight');
  pm.ensureParty('alice');
  const partyId = session.getPartyId()!;

  const clock = { extra: 0 };
  const stub = forecastStub(clock);
  const svc = new ForecastService({ clock: { now: () => Date.now() + clock.extra }, createJob: stub.createJob });

  const entries = (pm.partyBattles as unknown as { entries: Map<string, EntryView> }).entries;
  const entry = (id = partyId): EntryView => entries.get(id)!;
  const tileAt = (col: number, row: number): HexTile => grid.getTile(offsetToCube({ col, row }))!;
  const journal = (username = 'alice'): string[] => pm.getSessionByUsername(username)!.toSaveData().combatLog.map(l => l.text);
  const roomKey = (id: string): string => roomForecastKey(content.contentEpoch, pm.partyBattles.forecastKey(partyId)!, id);

  /** Put forecasts for these rooms into the cache. */
  const prefill = (ids: string[]): void => {
    for (const id of ids) {
      svc.request({ key: roomKey(id), priority: 'precheck', build: () => ({ input: { kind: 'room', players: [], table: [], monsters: {}, encounters: {} } }) });
    }
    vi.advanceTimersByTime(50);
  };

  return { grid, tiles, pm, ws, session, partyId, svc, stub, content, contentState, entry, tileAt, journal, roomKey, prefill };
}

export type ForecastWorld = Awaited<ReturnType<typeof forecastWorld>>;

/** Log `username` in as `className` and bring them into alice's party as a member. Returns their socket. */
export async function joinAlice(w: ForecastWorld, username: string, className: ClassName): Promise<FakeWs> {
  const ws = createWs();
  const session = await w.pm.login(ws as unknown as WebSocket, username);
  session.setClass(className);
  w.pm.applyClassChange(username);
  const getPartyId = (u: string) => w.pm.getSessionByUsername(u)?.getPartyId() ?? null;
  const setPartyId = (u: string, id: string | null) => { w.pm.getSessionByUsername(u)?.setPartyId(id); };
  const oldParty = getPartyId(username);
  const sameTile = (a: string, b: string) => w.pm.areSameTile(a, b);
  if (w.pm.parties.inviteToParty('alice', username, getPartyId, sameTile) !== true) throw new Error('invite failed');
  const accepted = w.pm.parties.acceptInvite(username, w.partyId, getPartyId, setPartyId, sameTile);
  if (typeof accepted === 'string') throw new Error(accepted);
  w.pm.handlePartyJoin(username, w.partyId, oldParty);
  return ws;
}
