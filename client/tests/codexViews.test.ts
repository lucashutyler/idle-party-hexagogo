import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexMonster, ServerCodexMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import type { WorldCache } from '../src/network/WorldCache';
import { buildCodexIndex } from '../src/ui/codex/codexModel';
import type { CodexViewContext } from '../src/ui/codex/codexViews';
import {
  CODEX_PAGE,
  codexEntryHtml,
  codexHomeHtml,
  codexListHtml,
  codexMissingHtml,
  codexZoneKey,
  monsterKillsText,
  patchMonsterKills,
} from '../src/ui/codex/codexViews';
import { CODEX_WORLD, codexReply, codexState, loadCodexWorld } from './codexFixture';

let world: WorldCache;

beforeEach(async () => {
  world = await loadCodexWorld();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ctx(reply: ServerCodexMessage = codexReply(), state: ServerStateMessage = codexState()): CodexViewContext {
  return { index: buildCodexIndex(reply, state, world), state, world };
}

function render(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

function text(el: Element | null | undefined): string {
  if (!el) return '';
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const part = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (part) parts.push(part);
  }
  return parts.join(' ');
}
const links = (el: HTMLElement) => [...el.querySelectorAll<HTMLElement>('[data-codex]')].map(a => a.getAttribute('data-codex'));
const sectionText = (el: HTMLElement, title: string) =>
  text([...el.querySelectorAll('.codex-section')].find(s => s.querySelector('.codex-section-title')?.textContent?.startsWith(title)));

const LIST = { query: '', sort: 'newest' as const, shown: CODEX_PAGE, zones: new Map<string, boolean>(), zoneShown: new Map<string, number>() };

describe('monster entry', () => {
  it('shows its record, the drops found and where it lives', () => {
    const el = render(codexEntryHtml({ kind: 'monster', id: 'goblin' }, ctx(), false));
    expect(text(el.querySelector('.codex-hero-name'))).toBe('Goblin');
    expect(el.querySelector('.bestiary-lvl')?.getAttribute('aria-label')).toMatch(/^Level 3/);
    expect(text(el.querySelector('.codex-record'))).toContain('Defeated 15 times');
    expect(sectionText(el, 'Drops')).toBe('Drops · 2 of 3 found Sharp Fang seen 9 times Wolf Pelt seen 4 times');
    expect(sectionText(el, 'Where it lives')).toContain('It lives here, in the room your party is in.');
    expect(el.querySelector('[data-codex-go]')).toBeNull();
    expect(links(el)).toEqual(['item:fang', 'item:pelt', 'room:g_field', 'room:g_dock', 'room:g_wood']);
  });

  it('offers the nearest room and names a dungeon it lives in, linking its entrance', () => {
    const el = render(codexEntryHtml({ kind: 'monster', id: 'wolf' }, ctx(), false));
    expect(text(el.querySelector('.codex-desc'))).toBe('A grey wolf.');
    expect(text(el.querySelector('.codex-record'))).toBe('Not defeated yet.');
    expect(sectionText(el, 'Drops')).toBe('Drops · 0 of 2 found No drops found yet. Drops are added when they land in your bags.');
    const go = el.querySelector<HTMLButtonElement>('[data-codex-go]')!;
    expect(text(go)).toBe('Go to the nearest: Wood');
    expect(go.dataset.codexGo).toBe('g_wood');
    expect(go.disabled).toBe(false);
    expect(sectionText(el, 'Where it lives')).toContain('In Damp Trial (dungeon)');
    expect(links(el)).toEqual(['room:g_wood', 'room:g_far', 'room:g_wood']);
  });

  it('says nothing of kills or drops for a wall, and that its home is unknown', () => {
    const el = render(codexEntryHtml({ kind: 'monster', id: 'wall' }, ctx(), false));
    expect(el.querySelector('.codex-record')).toBeNull();
    expect(sectionText(el, 'Drops')).toBe('');
    expect(sectionText(el, 'Where it lives')).toBe("Where it lives You haven't found where it lives yet.");
  });

  it('lists ten rooms, then all of them once expanded', async () => {
    const tiles = Array.from({ length: 12 }, (_, i) => ({ id: `r${i}`, mapId: 'gull', col: 10 + i, row: 5, type: 'plains', zone: 'shore', zoneName: 'Shore', name: `Room ${i}` }));
    const w = await loadCodexWorld({ ...CODEX_WORLD, tiles: [...CODEX_WORLD.tiles, ...tiles] });
    const state = codexState({ unlocked: tiles.map(t => t.id) });
    const c = { index: buildCodexIndex(codexReply(), state, w), state, world: w };
    const collapsed = render(codexEntryHtml({ kind: 'monster', id: 'goblin' }, c, false));
    expect(collapsed.querySelectorAll('.codex-section:last-child .codex-line')).toHaveLength(10);
    expect(text(collapsed.querySelector('[data-codex-expand]'))).toBe('Show all 12');
    const open = render(codexEntryHtml({ kind: 'monster', id: 'goblin' }, c, true));
    expect(open.querySelectorAll('.codex-section:last-child .codex-line')).toHaveLength(12);
    expect(open.querySelector('[data-codex-expand]')).toBeNull();
  });

  it('withholds Go with the reason while in a dungeon or not leading', () => {
    const inDungeon = render(codexEntryHtml({ kind: 'monster', id: 'wolf' }, ctx(codexReply(), codexState({ dungeon: { dungeonId: 'damp_trial' } })), false));
    expect(inDungeon.querySelector<HTMLButtonElement>('[data-codex-go]')!.disabled).toBe(true);
    expect(text(inDungeon.querySelector('.codex-note'))).toBe('Leave the dungeon before traveling');
    const member = codexState({ social: { party: { members: [{ username: 'me', role: 'member' }] } } });
    const el = render(codexEntryHtml({ kind: 'monster', id: 'wolf' }, ctx(codexReply(), member), false));
    expect(text(el.querySelector('.codex-note'))).toBe('Only the party owner or a leader can move');
  });
});

describe('item entry', () => {
  it('shows the card, who dropped it, quests and dungeon rewards', () => {
    const el = render(codexEntryHtml({ kind: 'item', id: 'fang' }, ctx(), false));
    expect(text(el.querySelector('.item-popup-name'))).toBe('Sharp Fang');
    expect(el.querySelector('.item-popup-codex')).toBeNull();
    expect(sectionText(el, 'Dropped by')).toBe('Dropped by Goblin seen 9 times');
    expect(sectionText(el, 'Quests')).toBe('Quests Reward from Fangs for Fern (in progress) Reward from Old Debts');
    expect(sectionText(el, 'Dungeon reward')).toBe('Dungeon reward Reward in Damp Trial (dungeon)');
    expect(sectionText(el, 'Sold at')).toBe('');
  });

  it('shows what is owned, where it is sold and what it makes', () => {
    const el = render(codexEntryHtml({ kind: 'item', id: 'pelt' }, ctx(), false));
    expect(text(el.querySelector('.codex-owned'))).toBe('You have 3');
    expect(sectionText(el, 'Sold at')).toBe('Sold at Mill Trading Post 12 gold');
    expect(sectionText(el, 'Used to craft')).toBe('Used to craft Pelt Cloak');
    expect(sectionText(el, 'Quests')).toBe('Quests Needed for Fangs for Fern');
    expect(links(el)).toEqual(['monster:goblin', 'shop:mill_post', 'item:cloak']);
  });

  it('shows a recipe with its ingredients and a way to the Craft screen', () => {
    const el = render(codexEntryHtml({ kind: 'item', id: 'cloak' }, ctx(), false));
    expect(sectionText(el, 'Crafted from')).toBe('Crafted from Pelt Cloak Wolf Pelt ×2 Thread ×1 Requires level 5 Open Craft');
    expect(el.querySelector('[data-codex-craft]')).not.toBeNull();
    expect(links(el)).toEqual(['item:pelt', 'item:thread', 'room:g_wood']);
  });

  it('marks an equipped item and says when nothing is known of where it comes from', () => {
    const blade = render(codexEntryHtml({ kind: 'item', id: 'blade' }, ctx(), false));
    expect(text(blade.querySelector('.codex-owned'))).toBe('Equipped');
    const potion = render(codexEntryHtml({ kind: 'item', id: 'potion' }, ctx(), false));
    expect(text(potion.querySelector('.codex-empty'))).toBe("You haven't found where this comes from yet.");
  });
});

describe('room entry', () => {
  it('lists what is here, linking only what has an entry, and the fights known here', () => {
    const el = render(codexEntryHtml({ kind: 'room', id: 'g_dock' }, ctx(), false));
    expect(text(el.querySelector('.codex-hero-name'))).toBe('Dock');
    expect(text(el.querySelector('.codex-sub'))).toBe('Shore · Gull Isle');
    expect(sectionText(el, 'Here')).toBe("Here 🧓 Old Wren 🪙 Mill Trading Post 🌀 Door to Cave Mouth 🌀 A door to a room you haven't found");
    expect(sectionText(el, 'Fights you know here')).toBe('Fights you know here Goblin');
    expect(el.textContent).not.toContain("monsters you've met");
    expect(links(el)).toEqual(['shop:mill_post', 'room:c_mouth', 'monster:goblin']);
    expect(el.querySelector<HTMLElement>('[data-codex-go]')!.dataset.codexGo).toBe('g_dock');
    expect(el.querySelector<HTMLElement>('[data-codex-show]')!.dataset.codexShow).toBe('g_dock');
  });

  it('shows the party\'s own room without Go', () => {
    const el = render(codexEntryHtml({ kind: 'room', id: 'g_field' }, ctx(), false));
    expect(text(el.querySelector('.codex-chip-here'))).toBe('You are here');
    expect(el.querySelector('[data-codex-go]')).toBeNull();
    expect(el.querySelector('[data-codex-show]')).not.toBeNull();
    expect(text(el.querySelector('.codex-level'))).toBe('Lv 3–4');
  });

  it('warns when the monsters are far above the party', () => {
    const el = render(codexEntryHtml({ kind: 'room', id: 'g_wood' }, ctx(), false));
    expect(el.querySelector('.codex-level')!.getAttribute('data-danger')).toBe('1');
    expect(text(el.querySelector('.codex-note[data-danger]'))).toBe("Monsters there are level 20–22. You're level 4.");
    expect(sectionText(el, 'Fights you know here')).toBe('Fights you know here Goblin , Wolf');
    expect(sectionText(el, 'Here')).toBe('Here 🗝️ Damp Trial (dungeon)');
  });

  it('names an unvisited shop without its stock, and the monsters met that live here', () => {
    const el = render(codexEntryHtml({ kind: 'room', id: 'g_far' }, ctx(), false));
    expect(sectionText(el, 'Here')).toBe('Here 🪙 Tannery: visit it to see what it sells.');
    expect(sectionText(el, "Monsters you've met that live here")).toBe("Monsters you've met that live here Wolf");
    expect(links(el)).toEqual(['monster:wolf']);
  });

  it('calls the rest "other monsters" when fight lines are shown too', () => {
    const reply = codexReply({ tables: [{ key: 'z:shore', monsters: ['goblin', 'wolf'], fights: [0] }] });
    const el = render(codexEntryHtml({ kind: 'room', id: 'g_dock' }, ctx(reply), false));
    expect(sectionText(el, "Other monsters you've met that live here")).toBe("Other monsters you've met that live here Wolf");
  });

  it('says so when nothing met lives here', () => {
    const el = render(codexEntryHtml({ kind: 'room', id: 'c_mouth' }, ctx(), false));
    expect(text(el.querySelector('.codex-empty'))).toBe("You haven't met anything that lives here yet.");
  });
});

describe('shop entry', () => {
  it('shows where it is with Go, its stock cheapest first and its hires', () => {
    const el = render(codexEntryHtml({ kind: 'shop', id: 'mill_post' }, ctx(), false));
    expect(text(el.querySelector('.codex-hero-name'))).toBe('Mill Trading Post');
    expect(sectionText(el, 'Found in')).toBe('Found in Dock Shore · Gull Isle Go');
    expect(sectionText(el, 'Sells')).toBe('Sells WP Wolf Pelt 12 gold RO Rope 40 gold');
    expect(sectionText(el, 'Hires')).toBe('Hires 🛡️ Brin Level 8');
    expect(el.querySelector<HTMLElement>('[data-codex-go]')!.dataset.codexGo).toBe('g_dock');
  });
});

describe('not discovered', () => {
  it.each([
    ['monster', 'ghost', "Monsters appear here once you've fought them."],
    ['item', 'gem', "Items appear here once you've had one, or seen it in a shop or a recipe."],
    ['room', 'g_secret', "Rooms appear here once you've found them on the map."],
    ['shop', 'tannery', 'Shops appear here once your party has stood in their room.'],
  ] as const)('%s', (kind, id, hint) => {
    const el = render(codexEntryHtml({ kind, id }, ctx(), false));
    expect(text(el.querySelector('.codex-missing-title'))).toBe("You haven't discovered this yet.");
    expect(text(el.querySelector('.codex-missing-hint'))).toBe(hint);
    expect(el.innerHTML).toBe(render(codexMissingHtml(kind)).innerHTML);
  });
});

describe('home', () => {
  it('shows what was found lately, with New on what this device has not shown, and the section counts', () => {
    const el = render(codexHomeHtml(ctx(), { query: '', newKeys: new Set(['monster:wolf']) }));
    expect([...el.querySelectorAll('.codex-recent .codex-row')].map(r => r.getAttribute('data-codex'))).toEqual(['monster:wolf', 'item:fang', 'shop:mill_post']);
    expect([...el.querySelectorAll('.codex-chip-new')].map(c => c.closest('.codex-row')!.getAttribute('data-codex'))).toEqual(['monster:wolf']);
    expect([...el.querySelectorAll('.codex-list-link')].map(text)).toEqual(['Monsters 3 ›', 'Items 7 ›', 'Rooms 5 ›', 'Shops 1 ›']);
    expect(text(el.querySelector('.codex-footnote'))).toBe('Drops, fights and shop visits are added as you play.');
  });

  it('says it is empty before anything is found', () => {
    const empty = codexReply({ monsters: [], items: [], shops: [], fights: [], tables: [], dungeons: [], recent: [] });
    const state = codexState({ craftingCatalog: undefined, character: { ...codexState().character!, inventory: {}, equipment: {} } });
    const el = render(codexHomeHtml(ctx(empty, state), { query: '', newKeys: new Set() }));
    expect(text(el.querySelector('.codex-empty'))).toBe('Nothing here yet. Fight, explore and shop, and what you find is written down here.');
    expect(el.querySelector('.codex-recent')).toBeNull();
    expect(text([...el.querySelectorAll('.codex-list-link')][2])).toBe('Rooms 5 ›');
  });

  it('searches every kind, five each with a way to see the rest, and says when nothing matches', () => {
    const monsters: CodexMonster[] = Array.from({ length: 7 }, (_, i) => ({ id: `rat${i}`, name: `Rat ${i}`, tier: 'trash', kills: 0, drops: [], dropKinds: 0 }));
    const el = render(codexHomeHtml(ctx(codexReply({ monsters })), { query: 'rat', newKeys: new Set() }));
    expect(el.querySelectorAll('.codex-row')).toHaveLength(5);
    expect(text(el.querySelector('[data-codex-see="monster"]'))).toBe('See all 7');
    const none = render(codexHomeHtml(ctx(), { query: 'dragon', newKeys: new Set() }));
    expect(text(none)).toBe("Nothing you've discovered matches “dragon”.");
  });
});

describe('lists', () => {
  it('shows monster rows with their record and drops found, the record patched in place to the live count', () => {
    const view = ctx();
    const el = render(codexListHtml('monster', view, LIST));
    const subs = () => [...el.querySelectorAll('.codex-row')].map(r => text(r.querySelector('.codex-row-sub')));
    expect(subs()).toEqual(['', 'Not defeated yet · 0 of 2 drops found', '12 defeated · 2 of 3 drops found']);
    expect(el.querySelector('[data-codex-kills="goblin"]')).not.toBeNull();
    expect(el.querySelector('[data-codex-kills="wall"]')).toBeNull();

    patchMonsterKills(el, view.index, view.state);
    expect(subs()).toEqual(['', 'Not defeated yet · 0 of 2 drops found', '15 defeated · 2 of 3 drops found']);
  });

  it('gives a row the same record text from the snapshot as from the live count', () => {
    expect(monsterKillsText({}, 0)).toBe('Not defeated yet');
    expect(monsterKillsText({}, 1200)).toBe('1,200 defeated');
    expect(monsterKillsText({ passive: true }, 9)).toBe('');
  });

  it('shows items with their kind and whether they are held, found or only seen', () => {
    const el = render(codexListHtml('item', ctx(), { ...LIST, sort: 'name' }));
    const subs = Object.fromEntries([...el.querySelectorAll('.codex-row')].map(r => [r.getAttribute('data-codex'), text(r.querySelector('.codex-row-sub'))]));
    expect(subs['item:pelt']).toBe('Material · You have 3');
    expect(subs['item:fang']).toBe('Material · Found');
    expect(subs['item:rope']).toBe('Material · Not found yet');
    expect(subs['item:blade']).toBe('Main Hand · Equipped');
    expect(subs['item:potion']).toBe('Consumable · You have 1');
  });

  it('shows a hundred rows, then more on request', () => {
    const monsters: CodexMonster[] = Array.from({ length: 150 }, (_, i) => ({ id: `m${i}`, name: `Monster ${i}`, tier: 'trash', kills: 0, drops: [], dropKinds: 0 }));
    const c = ctx(codexReply({ monsters }));
    const first = render(codexListHtml('monster', c, LIST));
    expect(first.querySelectorAll('.codex-row')).toHaveLength(100);
    expect(text(first.querySelector('[data-codex-more="list"]'))).toBe('Show more (50 left)');
    const all = render(codexListHtml('monster', c, { ...LIST, shown: 200 }));
    expect(all.querySelectorAll('.codex-row')).toHaveLength(150);
    expect(all.querySelector('[data-codex-more]')).toBeNull();
  });

  it('groups rooms by map and zone, the party\'s zone open, and flattens them for a search', () => {
    const el = render(codexListHtml('room', ctx(), LIST));
    expect([...el.querySelectorAll('.codex-map-title')].map(text)).toEqual(['Gull Isle · 4 rooms', 'Damp Cave · 1 room']);
    expect([...el.querySelectorAll('.codex-zone')].map(z => [text(z), z.getAttribute('aria-expanded')])).toEqual([
      ['▸ Pinefold 2 rooms', 'false'],
      ['▾ Shore 2 rooms', 'true'],
      ['▸ Damp Cave 1 room', 'false'],
    ]);
    expect(links(el)).toEqual(['room:g_dock', 'room:g_field']);
    expect(text(el.querySelector('[data-codex="room:g_field"] .codex-chip-here'))).toBe('You are here');

    const opened = render(codexListHtml('room', ctx(), { ...LIST, zones: new Map([[codexZoneKey('gull', 'shore'), false], [codexZoneKey('gull', 'pinefold'), true]]) }));
    expect(links(opened)).toEqual(['room:g_far', 'room:g_wood']);

    const search = render(codexListHtml('room', ctx(), { ...LIST, query: 'shore' }));
    expect(search.querySelector('.codex-zone')).toBeNull();
    expect([...search.querySelectorAll('.codex-row-sub')].map(text)).toEqual(['Shore · Gull Isle', 'Lv 3–4 · Shore · Gull Isle']);
  });

  it('shows shops with what they offer and where', () => {
    const el = render(codexListHtml('shop', ctx(), LIST));
    expect(text(el.querySelector('.codex-row-sub'))).toBe('Sells 2 items · Hires fighters · In 1 room');
  });
});

describe('safety', () => {
  const evil = '<img src=x onerror="alert(1)">';

  function evilCtx(): CodexViewContext {
    const reply = codexReply({
      monsters: [{ id: 'goblin', name: evil, description: evil, tier: 'trash', kills: 1, drops: [{ itemId: 'fang', seen: 1 }], dropKinds: 1 }],
      items: [{ def: { id: 'fang', name: evil, rarity: 'common' }, found: true }],
      shops: [{ id: 'mill_post', name: evil, stock: [{ itemId: 'fang', price: 1 }], hires: [{ name: evil, emoji: evil, level: 1 }] }],
    });
    return ctx(reply);
  }

  it('escapes every name from content', () => {
    const c = evilCtx();
    const pages = [
      codexHomeHtml(c, { query: '', newKeys: new Set() }),
      codexHomeHtml(c, { query: 'img', newKeys: new Set() }),
      ...(['monster', 'item', 'room', 'shop'] as const).map(kind => codexListHtml(kind, c, LIST)),
      codexEntryHtml({ kind: 'monster', id: 'goblin' }, c, false),
      codexEntryHtml({ kind: 'item', id: 'fang' }, c, false),
      codexEntryHtml({ kind: 'room', id: 'g_dock' }, c, false),
      codexEntryHtml({ kind: 'shop', id: 'mill_post' }, c, false),
    ];
    for (const html of pages) {
      const el = render(html);
      expect(el.querySelector('img[src="x"]')).toBeNull();
      expect(el.querySelector('[onerror]')).toBeNull();
    }
    expect(text(render(pages[6]).querySelector('.codex-hero-name'))).toBe(evil);
  });

  it('never says tile or tiles to the player', () => {
    const c = ctx();
    const refs = [
      ...['goblin', 'wolf', 'wall', 'ghost'].map(id => ({ kind: 'monster' as const, id })),
      ...['fang', 'pelt', 'cloak', 'blade', 'potion', 'rope', 'gem'].map(id => ({ kind: 'item' as const, id })),
      ...['g_dock', 'g_field', 'g_wood', 'g_far', 'c_mouth', 'g_secret'].map(id => ({ kind: 'room' as const, id })),
      ...['mill_post', 'tannery'].map(id => ({ kind: 'shop' as const, id })),
    ];
    const pages = [
      codexHomeHtml(c, { query: '', newKeys: new Set() }),
      ...(['monster', 'item', 'room', 'shop'] as const).map(kind => codexListHtml(kind, c, LIST)),
      ...refs.map(ref => codexEntryHtml(ref, c, true)),
    ];
    for (const html of pages) {
      const el = render(html);
      expect(el.textContent).not.toMatch(/\btiles?\b/i);
      for (const node of el.querySelectorAll('[aria-label], [title]')) {
        expect(`${node.getAttribute('aria-label') ?? ''} ${node.getAttribute('title') ?? ''}`).not.toMatch(/\btiles?\b/i);
      }
    }
  });
});
