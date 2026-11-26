import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServerCodexMessage, ServerStateMessage } from '@idle-party-rpg/shared';
import { CODEX_RETRY_MS } from '../src/network/GameClient';
import type { GameClient } from '../src/network/GameClient';
import type { WorldCache } from '../src/network/WorldCache';
import { CODEX_REFRESH_MS, CODEX_SEARCH_DEBOUNCE_MS, CodexModal } from '../src/ui/codex/CodexModal';
import { CODEX_LOAD_FAILED_TEXT, CODEX_UNAVAILABLE_TEXT, createCodexOpener, installCodexDelegate } from '../src/ui/codexLinks';
import type { CodexTarget } from '../src/ui/codexLinks';
import { bringToFront, dismissModals, dismissTop, release } from '../src/ui/ModalStack';
import { codexReply, codexState, loadCodexWorld } from './codexFixture';

function fakeClient(state: ServerStateMessage, codex: ServerCodexMessage | null) {
  const stateListeners = new Set<(s: ServerStateMessage) => void>();
  const codexListeners = new Set<(m: ServerCodexMessage) => void>();
  const client = {
    lastState: state,
    lastCodex: codex,
    requestedAt: null as number | null,
    /** When a request really went out, by GameClient's rule: only while stale, at most once per CODEX_RETRY_MS while unanswered. */
    sent: [] as number[],
    requestCodex: vi.fn(() => {
      const marker = client.lastState.character?.codexVersion;
      if (marker === undefined || client.lastCodex?.version === marker) return client.lastCodex;
      const now = Date.now();
      if (client.requestedAt === null || now - client.requestedAt >= CODEX_RETRY_MS) {
        client.requestedAt = now;
        client.sent.push(now);
      }
      return client.lastCodex;
    }),
    subscribe(cb: (s: ServerStateMessage) => void) {
      stateListeners.add(cb);
      return () => { stateListeners.delete(cb); };
    },
    onCodex(cb: (m: ServerCodexMessage) => void) {
      codexListeners.add(cb);
      return () => { codexListeners.delete(cb); };
    },
    push(next: ServerStateMessage) {
      client.lastState = next;
      for (const l of stateListeners) l(next);
    },
    reply(message: ServerCodexMessage) {
      client.lastCodex = message;
      client.requestedAt = null;
      for (const l of codexListeners) l(message);
    },
    get listening() {
      return stateListeners.size + codexListeners.size;
    },
  };
  return client;
}

let world: WorldCache;
let client: ReturnType<typeof fakeClient>;
let host: { showRoom: ReturnType<typeof vi.fn>; goToRoom: ReturnType<typeof vi.fn> };
let modal: CodexModal;
let removeDelegate: () => void;

const overlay = () => document.querySelector<HTMLElement>('.codex-overlay');
const body = () => document.querySelector<HTMLElement>('.codex-body')!;
const title = () => document.querySelector('.codex-title')!.textContent;
const backBtn = () => document.querySelector<HTMLButtonElement>('.codex-back')!;
const homeBtn = () => document.querySelector<HTMLButtonElement>('.codex-home')!;
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();

function mount(state = codexState(), codex: ServerCodexMessage | null = codexReply()): void {
  client = fakeClient(state, codex);
  host = { showRoom: vi.fn(), goToRoom: vi.fn() };
  modal = new CodexModal({ gameClient: client as unknown as GameClient, worldCache: world, ...host });
  removeDelegate = installCodexDelegate((target: CodexTarget) => modal.open(target));
}

beforeEach(async () => {
  document.body.innerHTML = '';
  world = await loadCodexWorld();
});

afterEach(() => {
  document.dispatchEvent(new PointerEvent('pointercancel'));
  modal?.destroy();
  removeDelegate?.();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('CodexModal', () => {
  it('opens at home on the modal stack and asks for the Codex', () => {
    mount();
    modal.open({ kind: 'home' });
    expect(parseInt(overlay()!.style.zIndex, 10)).toBeGreaterThanOrEqual(1500);
    expect(title()).toBe('Codex');
    expect(backBtn().hidden).toBe(true);
    expect(homeBtn().hidden).toBe(true);
    expect(document.querySelector<HTMLElement>('.codex-controls')!.hidden).toBe(false);
    expect(body().querySelectorAll('.codex-list-link')).toHaveLength(4);
    expect(client.requestCodex).toHaveBeenCalledOnce();
  });

  it('says it is opening until the first reply, then shows it', () => {
    mount(codexState(), null);
    modal.open({ kind: 'home' });
    expect(body().textContent).toBe('Opening your Codex…');
    client.reply(codexReply());
    expect(body().querySelectorAll('.codex-list-link')).toHaveLength(4);
  });

  it('opened from a link shows just that entry, and Back closes it', () => {
    mount();
    modal.open({ kind: 'monster', id: 'wolf' });
    expect(body().querySelector('.codex-hero-name')!.textContent).toBe('Wolf');
    expect(backBtn().hidden).toBe(true);
    expect(homeBtn().hidden).toBe(false);
    expect(document.querySelector<HTMLElement>('.codex-controls')!.hidden).toBe(true);
    expect(dismissTop()).toBe(true);
    expect(overlay()).toBeNull();
    expect(client.listening).toBe(0);
  });

  it('pushes a view for each link, steps back one at a time, then closes', () => {
    mount();
    modal.open({ kind: 'home' });
    click('[data-codex="list:monster"]');
    expect(title()).toBe('Monsters');
    click('[data-codex="monster:goblin"]');
    expect(body().querySelector('.codex-hero-name')!.textContent).toBe('Goblin');
    click('.codex-line [data-codex="item:fang"]');
    expect(body().querySelector('.item-popup-name')!.textContent).toBe('Sharp Fang');
    expect(backBtn().hidden).toBe(false);

    backBtn().click();
    expect(body().querySelector('.codex-hero-name')!.textContent).toBe('Goblin');
    expect(dismissTop()).toBe(true);
    expect(title()).toBe('Monsters');
    expect(dismissTop()).toBe(true);
    expect(title()).toBe('Codex');
    expect(backBtn().hidden).toBe(true);
    expect(dismissTop()).toBe(true);
    expect(overlay()).toBeNull();
  });

  it('closes outright from a deep stack with dismissModals and the close button', () => {
    mount();
    modal.open({ kind: 'home' });
    click('[data-codex="list:shop"]');
    click('[data-codex="shop:mill_post"]');
    dismissModals();
    expect(overlay()).toBeNull();

    modal.open({ kind: 'home' });
    click('[data-codex="list:item"]');
    click('.player-options-close');
    expect(overlay()).toBeNull();
  });

  it('goes home from an entry with the home button', () => {
    mount();
    modal.open({ kind: 'room', id: 'g_dock' });
    homeBtn().click();
    expect(body().querySelectorAll('.codex-list-link')).toHaveLength(4);
    expect(dismissTop()).toBe(true);
    expect(body().querySelector('.codex-hero-name')!.textContent).toBe('Dock');
  });

  it('keeps each view\'s scroll position', () => {
    mount();
    modal.open({ kind: 'list', list: 'item' });
    body().scrollTop = 120;
    click('[data-codex="item:pelt"]');
    expect(body().scrollTop).toBe(0);
    modal.back();
    expect(body().scrollTop).toBe(120);
  });

  it('searches from home and opens the whole list with the query kept', () => {
    vi.useFakeTimers();
    mount();
    modal.open({ kind: 'home' });
    const search = document.querySelector<HTMLInputElement>('.codex-search')!;
    search.value = 'o';
    search.dispatchEvent(new Event('input'));
    expect(body().querySelector('.codex-list-link')).not.toBeNull();
    vi.advanceTimersByTime(CODEX_SEARCH_DEBOUNCE_MS);
    expect(body().querySelector('.codex-list-link')).toBeNull();
    expect(body().querySelectorAll('.codex-section-title')[0].textContent).toBe('Monsters');

    const fewer = codexReply({ monsters: Array.from({ length: 7 }, (_, i) => ({ id: `o${i}`, name: `Ooze ${i}`, tier: 'trash' as const, kills: 0, drops: [], dropKinds: 0 })) });
    client.reply(fewer);
    click('[data-codex-see="monster"]');
    expect(title()).toBe('Monsters');
    expect(search.value).toBe('o');
    expect(body().querySelectorAll('.codex-row')).toHaveLength(7);
    modal.back();
    expect(search.value).toBe('o');
  });

  it('sorts a list and shows more rows on request', () => {
    const monsters = Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, name: `Monster ${String(i).padStart(3, '0')}`, tier: 'trash' as const, kills: 0, drops: [], dropKinds: 0 }));
    mount(codexState(), codexReply({ monsters }));
    modal.open({ kind: 'list', list: 'monster' });
    const sort = document.querySelector<HTMLSelectElement>('.codex-sort')!;
    expect([...sort.options].map(o => o.textContent)).toEqual(['Newest', 'Name', 'Level']);
    expect(body().querySelector('.codex-row')!.getAttribute('data-codex')).toBe('monster:m119');
    sort.value = 'name';
    sort.dispatchEvent(new Event('change'));
    expect(body().querySelector('.codex-row')!.getAttribute('data-codex')).toBe('monster:m0');
    expect(body().querySelectorAll('.codex-row')).toHaveLength(100);
    click('[data-codex-more="list"]');
    expect(body().querySelectorAll('.codex-row')).toHaveLength(120);
  });

  it('opens and closes zones in the room list', () => {
    mount();
    modal.open({ kind: 'list', list: 'room' });
    expect(document.querySelector<HTMLElement>('.codex-sort')!.hidden).toBe(true);
    expect(body().querySelector('[data-codex="room:g_far"]')).toBeNull();
    click('[data-codex-zone="gull|pinefold"]');
    expect(body().querySelector('[data-codex="room:g_far"]')).not.toBeNull();
    click('[data-codex-zone="gull|shore"]');
    expect(body().querySelector('[data-codex="room:g_dock"]')).toBeNull();
  });

  it('Go and Show on map close every modal first, then hand over to the map', () => {
    mount();
    const popup = document.createElement('div');
    document.body.appendChild(popup);
    const popupClosed = vi.fn(() => { release(popup); popup.remove(); });
    bringToFront(popup, popupClosed);

    modal.open({ kind: 'room', id: 'g_dock' });
    click('[data-codex-go="g_dock"]');
    expect(popupClosed).toHaveBeenCalled();
    expect(overlay()).toBeNull();
    expect(host.goToRoom).toHaveBeenCalledWith('g_dock');

    modal.open({ kind: 'room', id: 'g_dock' });
    click('[data-codex-show="g_dock"]');
    expect(overlay()).toBeNull();
    expect(host.showRoom).toHaveBeenCalledWith('g_dock');
  });

  it('sends nothing from a Go the party can\'t take', () => {
    mount(codexState({ dungeon: { dungeonId: 'damp_trial' } }));
    modal.open({ kind: 'room', id: 'g_dock' });
    const go = document.querySelector<HTMLButtonElement>('[data-codex-go]')!;
    expect(go.disabled).toBe(true);
    go.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(host.goToRoom).not.toHaveBeenCalled();
    expect(body().querySelector('.codex-note')!.textContent).toBe('Leave the dungeon before traveling');
  });

  it('asks again when the marker moves, at most once per refresh window, with a timer for the last change', () => {
    vi.useFakeTimers();
    mount();
    modal.open({ kind: 'home' });
    expect(client.requestCodex).toHaveBeenCalledTimes(1);
    const moved = (marker: string) => codexState({ character: { ...codexState().character!, codexVersion: marker } });

    client.push(moved('v2'));
    client.push(moved('v3'));
    expect(client.requestCodex).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CODEX_REFRESH_MS);
    expect(client.requestCodex).toHaveBeenCalledTimes(2);

    client.reply(codexReply({ version: 'v3' }));
    client.push(moved('v3'));
    vi.advanceTimersByTime(CODEX_REFRESH_MS * 2);
    expect(client.requestCodex).toHaveBeenCalledTimes(2);

    modal.close();
    client.push(moved('v4'));
    vi.advanceTimersByTime(CODEX_REFRESH_MS * 2);
    expect(client.requestCodex).toHaveBeenCalledTimes(2);
  });

  it('retries on its own when no reply comes', () => {
    vi.useFakeTimers();
    mount(codexState(), null);
    modal.open({ kind: 'home' });
    expect(client.requestCodex).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(CODEX_RETRY_MS);
    expect(client.requestCodex).toHaveBeenCalledTimes(2);
  });

  describe('with nothing true to show', () => {
    const moved = (marker: string) => codexState({ character: { ...codexState().character!, codexVersion: marker } });
    const sentAt = (start: number) => client.sent.map(at => at - start);
    /** No reply ever comes; state pushes arrive every second. */
    const playWithoutReply = (seconds: number) => {
      for (let i = 0; i < seconds; i++) {
        vi.advanceTimersByTime(1000);
        client.push(client.lastState);
      }
    };

    it('shows the loading line, not "not discovered", for an entry missing from a stale snapshot', () => {
      mount(moved('v2'), codexReply({ version: 'v1' }));
      modal.open({ kind: 'monster', id: 'bear' });
      expect(body().textContent).toBe('Opening your Codex…');

      client.reply(codexReply({ version: 'v2', monsters: [...codexReply().monsters, { id: 'bear', name: 'Bear', tier: 'trash', kills: 0, drops: [], dropKinds: 0 }] }));
      expect(body().querySelector('.codex-hero-name')!.textContent).toBe('Bear');
    });

    it('says "not discovered" once the snapshot is current and the entry is still missing', () => {
      mount(moved('v2'), codexReply({ version: 'v1' }));
      modal.open({ kind: 'monster', id: 'bear' });
      client.reply(codexReply({ version: 'v2' }));
      expect(body().querySelector('.codex-missing-title')!.textContent).toBe('You haven\'t discovered this yet.');
    });

    it('asks again at once when the snapshot is dropped while open', () => {
      vi.useFakeTimers();
      mount();
      const start = Date.now();
      modal.open({ kind: 'home' });
      vi.advanceTimersByTime(5000);
      client.lastCodex = null;
      client.push(moved('v2'));
      expect(sentAt(start)).toEqual([5000]);
    });

    it('with no snapshot, asks every 15 s and never faster', () => {
      vi.useFakeTimers();
      mount(codexState(), null);
      const start = Date.now();
      modal.open({ kind: 'home' });
      playWithoutReply(40);
      expect(sentAt(start)).toEqual([0, CODEX_RETRY_MS, 2 * CODEX_RETRY_MS]);
    });

    it('with an entry missing from a stale snapshot, asks every 15 s and never faster', () => {
      vi.useFakeTimers();
      mount(moved('v2'), codexReply({ version: 'v1' }));
      const start = Date.now();
      modal.open({ kind: 'monster', id: 'bear' });
      playWithoutReply(40);
      expect(sentAt(start)).toEqual([0, CODEX_RETRY_MS, 2 * CODEX_RETRY_MS]);
    });
  });

  it('holds a repaint from a push while the player presses inside', () => {
    vi.useFakeTimers();
    mount();
    modal.open({ kind: 'item', id: 'pelt' });
    const owned = () => body().querySelector('.codex-owned')!.textContent;
    expect(owned()).toBe('You have 3');
    const row = body().querySelector('.codex-line')!;
    row.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }));
    client.push(codexState({ character: { ...codexState().character!, inventory: { pelt: 5 } } }));
    expect(owned()).toBe('You have 3');
    document.dispatchEvent(new PointerEvent('pointercancel'));
    expect(owned()).toBe('You have 5');
  });

  it('marks what was found since the last visit as New, once', () => {
    mount();
    localStorage.setItem('codexSeen:me', JSON.stringify(['item:fang']));
    modal.open({ kind: 'home' });
    const tagged = () => [...body().querySelectorAll('.codex-chip-new')].map(c => c.closest('[data-codex]')!.getAttribute('data-codex'));
    expect(tagged()).toEqual(['monster:wolf', 'shop:mill_post']);
    expect(JSON.parse(localStorage.getItem('codexSeen:me')!)).toEqual(['monster:wolf', 'item:fang', 'shop:mill_post']);
    modal.close();
    modal.open({ kind: 'home' });
    expect(tagged()).toEqual([]);
  });

  it('tags what a fresh reply brings over a cached older one, and what arrives while home stays open', () => {
    const older = codexReply({ version: 'v1', recent: [{ kind: 'item', id: 'fang' }, { kind: 'shop', id: 'mill_post' }] });
    mount(codexState({ character: { ...codexState().character!, codexVersion: 'v2' } }), older);
    localStorage.setItem('codexSeen:me', JSON.stringify(['item:fang', 'shop:mill_post']));
    const tagged = () => [...body().querySelectorAll('.codex-chip-new')].map(c => c.closest('[data-codex]')!.getAttribute('data-codex'));

    modal.open({ kind: 'home' });
    expect(tagged()).toEqual([]);

    client.reply(codexReply({ version: 'v2', recent: [{ kind: 'monster', id: 'wolf' }, { kind: 'item', id: 'fang' }, { kind: 'shop', id: 'mill_post' }] }));
    expect(tagged()).toEqual(['monster:wolf']);

    client.reply(codexReply({ version: 'v3', recent: [{ kind: 'monster', id: 'goblin' }, { kind: 'monster', id: 'wolf' }, { kind: 'item', id: 'fang' }, { kind: 'shop', id: 'mill_post' }] }));
    expect(tagged()).toEqual(['monster:goblin', 'monster:wolf']);

    modal.close();
    modal.open({ kind: 'home' });
    expect(tagged()).toEqual([]);
  });
});

describe('createCodexOpener', () => {
  it('loads the real window on first use and reuses it', async () => {
    mount();
    const toast = vi.fn();
    const load = vi.fn(async () => {
      const { CodexModal: Loaded } = await import('../src/ui/codex/CodexModal');
      modal = new Loaded({ gameClient: client as unknown as GameClient, worldCache: world, ...host });
      return modal;
    });
    const open = createCodexOpener({ available: () => true, load, toast });
    void open({ kind: 'home' });
    void open({ kind: 'home' });
    await vi.waitFor(() => expect(document.querySelector('.codex-overlay .codex-list-link')).not.toBeNull());
    await open({ kind: 'monster', id: 'wolf' });
    expect(load).toHaveBeenCalledOnce();
    expect(document.querySelectorAll('.codex-overlay')).toHaveLength(1);
    expect(document.querySelector('.codex-hero-name')!.textContent).toBe('Wolf');
    expect(toast).not.toHaveBeenCalled();
  });

  it('says when the Codex is unavailable or could not be loaded, and tries again next time', async () => {
    const toast = vi.fn();
    const unavailable = createCodexOpener({ available: () => false, load: vi.fn(), toast });
    await unavailable({ kind: 'home' });
    expect(toast).toHaveBeenLastCalledWith(CODEX_UNAVAILABLE_TEXT);

    const load = vi.fn().mockRejectedValueOnce(new Error('chunk gone')).mockResolvedValueOnce({ open: vi.fn() });
    const flaky = createCodexOpener({ available: () => true, load, toast });
    await flaky({ kind: 'home' });
    expect(toast).toHaveBeenLastCalledWith(CODEX_LOAD_FAILED_TEXT);
    await flaky({ kind: 'home' });
    expect(load).toHaveBeenCalledTimes(2);
  });
});
