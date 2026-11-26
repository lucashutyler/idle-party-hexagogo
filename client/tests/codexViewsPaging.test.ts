import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexMonster, ServerCodexMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../src/network/WorldCache';
import { renderAssetImg, renderTrackedImg } from '../src/ui/assets';
import { buildCodexIndex, roomGroups, searchCodex, sortItems, sortMonsters } from '../src/ui/codex/codexModel';
import type { CodexViewContext } from '../src/ui/codex/codexViews';
import { CODEX_PAGE, codexListHtml } from '../src/ui/codex/codexViews';
import { CODEX_WORLD, codexReply, codexState, loadCodexWorld } from './codexFixture';

vi.mock('../src/ui/assets', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/assets')>();
  return { ...actual, renderAssetImg: vi.fn(actual.renderAssetImg), renderTrackedImg: vi.fn(actual.renderTrackedImg) };
});

vi.mock('../src/ui/codex/codexModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui/codex/codexModel')>();
  return {
    ...actual,
    sortMonsters: vi.fn(actual.sortMonsters),
    sortItems: vi.fn(actual.sortItems),
    roomGroups: vi.fn(actual.roomGroups),
    searchCodex: vi.fn(actual.searchCodex),
  };
});

const ROOMS = 500;
const LIST = { query: '', sort: 'newest' as const, shown: CODEX_PAGE, zones: new Map<string, boolean>(), zoneShown: new Map<string, number>() };

let world: WorldCache;

function largeReply(): ServerCodexMessage {
  const monsters: CodexMonster[] = Array.from({ length: 5000 }, (_, i) => ({ id: `m${i}`, name: `Monster ${i}`, tier: 'trash', kills: i, drops: [], dropKinds: 0 }));
  const items = Array.from({ length: 3000 }, (_, i) => ({ def: { id: `i${i}`, name: `Item ${i}`, rarity: 'common' as const }, found: true }));
  return codexReply({ monsters, items, tables: [], fights: [], dungeons: [], recent: [] });
}

function ctx(reply: ServerCodexMessage, state: ServerStateMessage): CodexViewContext {
  return { index: buildCodexIndex(reply, state, world), state, world };
}

beforeEach(async () => {
  const tiles = Array.from({ length: ROOMS }, (_, i) => ({ id: `r${i}`, mapId: 'gull', col: i % 50, row: Math.floor(i / 50), type: 'plains', zone: 'shore', zoneName: 'Shore', name: `Room ${i}` }));
  world = await loadCodexWorld({ ...CODEX_WORLD, tiles });
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Codex lists build only the rows they show', () => {
  const state = () => codexState({ unlocked: Array.from({ length: ROOMS }, (_, i) => `r${i}`) });

  it('renders a hundred monster and item rows however many entries there are', () => {
    const view = ctx(largeReply(), state());

    codexListHtml('monster', view, LIST);
    expect(vi.mocked(renderAssetImg)).toHaveBeenCalledTimes(CODEX_PAGE);

    codexListHtml('item', view, LIST);
    expect(vi.mocked(renderTrackedImg)).toHaveBeenCalledTimes(CODEX_PAGE);
  });

  it('renders a hundred room rows in a search and in an open zone', () => {
    const view = ctx(largeReply(), state());
    const levels = vi.spyOn(world, 'getRoomLevels');

    codexListHtml('room', view, { ...LIST, query: 'room' });
    expect(levels).toHaveBeenCalledTimes(CODEX_PAGE);

    levels.mockClear();
    codexListHtml('room', view, LIST);
    expect(levels).toHaveBeenCalledTimes(CODEX_PAGE);
  });

  it('sorts and groups once per index, query and sort', () => {
    const view = ctx(largeReply(), state());
    for (let i = 0; i < 3; i++) {
      codexListHtml('monster', view, LIST);
      codexListHtml('item', view, { ...LIST, sort: 'name' });
      codexListHtml('room', view, LIST);
      codexListHtml('room', view, { ...LIST, query: 'room 4' });
    }
    expect(vi.mocked(sortMonsters)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(sortItems)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(roomGroups)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(searchCodex)).toHaveBeenCalledTimes(1);

    codexListHtml('monster', view, { ...LIST, sort: 'name' });
    codexListHtml('monster', ctx(largeReply(), state()), LIST);
    expect(vi.mocked(sortMonsters)).toHaveBeenCalledTimes(3);
  });
});
