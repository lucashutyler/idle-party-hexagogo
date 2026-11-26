import type { CodexKind, ServerStateMessage } from '@idle-party-rpg/shared';
import { CODEX_RECENT_MAX, codexRefKey } from '@idle-party-rpg/shared';
import type { GameClient } from '../../network/GameClient';
import type { WorldCache } from '../../network/WorldCache';
import { codexTargetKey } from '../codexLinks';
import type { CodexTarget } from '../codexLinks';
import { escapeHtml } from '../ItemIcon';
import { bringToFront, dismissModals, release, wireFocusOnInteract } from '../ModalStack';
import { navigate } from '../navigate';
import { deferWhilePressed, setHtml } from '../render';
import type { CodexIndex, CodexListSort, CodexSort } from './codexModel';
import { CODEX_SORT_LABELS, CODEX_SORTS, buildCodexIndex, newRecentKeys, ownedItemIds } from './codexModel';
import type { CodexListOptions, CodexViewContext } from './codexViews';
import {
  CODEX_PAGE,
  LIST_TITLES,
  codexEntryHtml,
  codexHomeHtml,
  codexListHtml,
  codexLoadingHtml,
} from './codexViews';

export const CODEX_REFRESH_MS = 30_000;
export const CODEX_SEARCH_DEBOUNCE_MS = 120;
export const CODEX_STACK_MAX = 30;
const SEEN_KEY_PREFIX = 'codexSeen:';

export interface CodexHost {
  gameClient: GameClient;
  worldCache: WorldCache;
  showRoom(roomId: string): void;
  goToRoom(roomId: string): void;
}

interface CodexView {
  target: CodexTarget;
  scrollTop: number;
  expanded: boolean;
}

interface ListState {
  query: string;
  sort: CodexSort;
  shown: number;
  zones: Map<string, boolean>;
  zoneShown: Map<string, number>;
}

function listState(sort: CodexSort): ListState {
  return { query: '', sort, shown: CODEX_PAGE, zones: new Map(), zoneShown: new Map() };
}

function readSeen(username: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(SEEN_KEY_PREFIX + username) ?? '[]');
    return Array.isArray(raw) ? raw.filter((key): key is string => typeof key === 'string') : [];
  } catch {
    return [];
  }
}

function writeSeen(username: string, keys: readonly string[]): void {
  try {
    localStorage.setItem(SEEN_KEY_PREFIX + username, JSON.stringify(keys.slice(0, CODEX_RECENT_MAX)));
  } catch {
    // Private mode: "New" tags just show again next time.
  }
}

/** The Codex window: a stack of views over one snapshot. See docs/architecture/codex.md → Client. */
export class CodexModal {
  private overlay: HTMLElement | null = null;
  private titleEl: HTMLElement | null = null;
  private backBtn: HTMLButtonElement | null = null;
  private homeBtn: HTMLButtonElement | null = null;
  private controlsEl: HTMLElement | null = null;
  private searchEl: HTMLInputElement | null = null;
  private sortEl: HTMLSelectElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private stack: CodexView[] = [];
  private paintedView: CodexView | null = null;
  private homeQuery = '';
  private readonly lists: Record<CodexKind, ListState> = {
    monster: listState('newest'),
    item: listState('newest'),
    room: listState('name'),
    shop: listState('newest'),
  };
  private seenAtOpen: readonly string[] | null = null;
  private memo: { key: readonly unknown[]; index: CodexIndex } | null = null;
  private requestedAt = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private searchTimer?: ReturnType<typeof setTimeout>;
  private unsubscribers: (() => void)[] = [];

  constructor(private host: CodexHost) {}

  isOpen(): boolean {
    return this.overlay !== null;
  }

  /** Closed: opens with just `target`. Open: shows `target` on top of the views already open. */
  open(target: CodexTarget): void {
    if (!this.overlay) {
      this.mount();
      this.stack = [{ target, scrollTop: 0, expanded: false }];
    } else {
      const top = this.top();
      if (top && codexTargetKey(top.target) === codexTargetKey(target)) return;
      this.stack.push({ target, scrollTop: 0, expanded: false });
      if (this.stack.length > CODEX_STACK_MAX) this.stack.shift();
    }
    this.paint();
  }

  close(): void {
    if (!this.overlay) return;
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    clearTimeout(this.refreshTimer);
    clearTimeout(this.searchTimer);
    this.refreshTimer = undefined;
    this.searchTimer = undefined;
    release(this.overlay);
    this.overlay.remove();
    this.overlay = null;
    this.titleEl = this.backBtn = this.homeBtn = this.controlsEl = this.searchEl = this.sortEl = this.bodyEl = null;
    this.stack = [];
    this.paintedView = null;
    this.seenAtOpen = null;
    this.memo = null;
  }

  destroy(): void {
    this.close();
  }

  /** One view back; false at the first view. */
  back(): boolean {
    if (this.stack.length <= 1) return false;
    this.stack.pop();
    this.paint();
    return true;
  }

  private top(): CodexView | undefined {
    return this.stack[this.stack.length - 1];
  }

  private mount(): void {
    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay codex-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal codex-modal" role="dialog" aria-modal="true" aria-label="Codex">
        <div class="player-options-header codex-header">
          <button type="button" class="codex-head-btn codex-back" aria-label="Back" hidden>‹</button>
          <span class="player-options-title codex-title">Codex</span>
          <button type="button" class="codex-head-btn codex-home" aria-label="Codex home" hidden>⌂</button>
          <button type="button" class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="items-search-sort codex-controls">
          <input type="search" class="items-search-input codex-search" placeholder="Search the Codex" aria-label="Search the Codex" />
          <select class="items-sort-select codex-sort" aria-label="Sort by"></select>
        </div>
        <div class="codex-body"></div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.titleEl = overlay.querySelector('.codex-title');
    this.backBtn = overlay.querySelector('.codex-back');
    this.homeBtn = overlay.querySelector('.codex-home');
    this.controlsEl = overlay.querySelector('.codex-controls');
    this.searchEl = overlay.querySelector('.codex-search');
    this.sortEl = overlay.querySelector('.codex-sort');
    this.bodyEl = overlay.querySelector('.codex-body');

    overlay.addEventListener('click', (e) => this.onClick(e));
    this.searchEl!.addEventListener('input', () => this.onSearch());
    this.sortEl!.addEventListener('change', () => this.onSort());

    const { gameClient } = this.host;
    this.unsubscribers.push(
      gameClient.subscribe(state => this.onState(state)),
      gameClient.onCodex(() => this.onCodex()),
    );
    this.refetch();
    bringToFront(overlay, () => this.close(), { back: () => this.back() });
    wireFocusOnInteract(overlay);
  }

  private onClick(e: MouseEvent): void {
    const target = e.target as Element | null;
    if (!target || !this.overlay) return;
    if (target === this.overlay || target.closest('.player-options-close')) {
      this.close();
      return;
    }
    if (target.closest('[data-codex]')) return;
    if (target.closest('.codex-back')) {
      if (!this.back()) this.close();
      return;
    }
    if (target.closest('.codex-home')) {
      this.open({ kind: 'home' });
      return;
    }
    const control = target.closest<HTMLElement>('[data-codex-more], [data-codex-see], [data-codex-zone], [data-codex-expand], [data-codex-go], [data-codex-show], [data-codex-craft]');
    if (!control || (control as HTMLButtonElement).disabled) return;
    const data = control.dataset;
    if (data.codexGo) this.leaveFor(() => this.host.goToRoom(data.codexGo!));
    else if (data.codexShow) this.leaveFor(() => this.host.showRoom(data.codexShow!));
    else if (data.codexCraft) this.leaveFor(() => navigate('craft'));
    else if (data.codexMore) this.showMore(data.codexMore);
    else if (data.codexSee) this.seeAll(data.codexSee as CodexKind);
    else if (data.codexZone) this.toggleZone(data.codexZone, control.getAttribute('aria-expanded') === 'true');
    else if (data.codexExpand) this.expand();
  }

  /** Every modal closes first: `navigate` leaves them up. */
  private leaveFor(go: () => void): void {
    dismissModals();
    go();
  }

  private listOf(view: CodexView | undefined): ListState | null {
    return view?.target.kind === 'list' ? this.lists[view.target.list] : null;
  }

  private showMore(key: string): void {
    const list = this.listOf(this.top());
    if (!list) return;
    if (key === 'list') {
      list.shown += CODEX_PAGE;
    } else if (key.startsWith('zone:')) {
      const zone = key.slice('zone:'.length);
      list.zoneShown.set(zone, (list.zoneShown.get(zone) ?? CODEX_PAGE) + CODEX_PAGE);
    }
    this.paint();
  }

  private seeAll(kind: CodexKind): void {
    const list = this.lists[kind];
    list.query = this.homeQuery;
    list.shown = CODEX_PAGE;
    this.open({ kind: 'list', list: kind });
  }

  private toggleZone(key: string, open: boolean): void {
    this.lists.room.zones.set(key, !open);
    this.paint();
  }

  private expand(): void {
    const top = this.top();
    if (!top) return;
    top.expanded = true;
    this.paint();
  }

  private onSearch(): void {
    const value = this.searchEl?.value ?? '';
    const top = this.top();
    const list = this.listOf(top);
    if (list) {
      list.query = value;
      list.shown = CODEX_PAGE;
    } else if (top?.target.kind === 'home') {
      this.homeQuery = value;
    }
    clearTimeout(this.searchTimer);
    this.searchTimer = setTimeout(() => {
      this.searchTimer = undefined;
      if (this.overlay) deferWhilePressed(this.overlay, () => this.paint());
    }, CODEX_SEARCH_DEBOUNCE_MS);
  }

  private onSort(): void {
    const list = this.listOf(this.top());
    if (!list || !this.sortEl) return;
    list.sort = this.sortEl.value as CodexSort;
    list.shown = CODEX_PAGE;
    this.paint();
  }

  private onState(state: ServerStateMessage): void {
    if (!this.overlay) return;
    const marker = state.character?.codexVersion;
    if (marker !== undefined && this.host.gameClient.lastCodex?.version !== marker) this.scheduleRefetch();
    deferWhilePressed(this.overlay, () => this.paint());
  }

  private onCodex(): void {
    if (!this.overlay) return;
    const marker = this.host.gameClient.lastState?.character?.codexVersion;
    if (this.host.gameClient.lastCodex?.version === marker) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    deferWhilePressed(this.overlay, () => this.paint());
  }

  private refetch(): void {
    this.requestedAt = Date.now();
    const { gameClient } = this.host;
    gameClient.requestCodex();
    if (gameClient.lastCodex?.version !== gameClient.lastState?.character?.codexVersion) this.scheduleRefetch();
  }

  /** At most one fetch per CODEX_REFRESH_MS while open; a timer covers the last change in a window. */
  private scheduleRefetch(): void {
    if (this.refreshTimer) return;
    const wait = this.requestedAt + CODEX_REFRESH_MS - Date.now();
    if (wait <= 0) {
      this.refetch();
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      if (this.overlay) this.refetch();
    }, wait);
  }

  private index(state: ServerStateMessage | null): CodexIndex {
    const { gameClient, worldCache } = this.host;
    const key = [
      gameClient.lastCodex,
      state?.unlocked,
      state?.craftingCatalog,
      worldCache.contentGeneration,
      [...ownedItemIds(state)].join('\n'),
    ];
    if (this.memo && this.memo.key.every((part, i) => part === key[i])) return this.memo.index;
    const index = buildCodexIndex(gameClient.lastCodex, state, worldCache);
    this.memo = { key, index };
    return index;
  }

  private saveScroll(): void {
    if (this.paintedView && this.bodyEl) this.paintedView.scrollTop = this.bodyEl.scrollTop;
  }

  private paint(): void {
    const view = this.top();
    if (!this.overlay || !this.bodyEl || !view) return;
    const state = this.host.gameClient.lastState;
    const switched = this.paintedView !== view;
    if (switched) this.saveScroll();
    this.paintHeader(view);
    this.paintControls(view, switched);
    const loaded = !!this.host.gameClient.lastCodex;
    const scrollTop = this.bodyEl.scrollTop;
    const wrote = setHtml(this.bodyEl, loaded ? this.bodyHtml(view, state) : codexLoadingHtml());
    if (switched) this.bodyEl.scrollTop = view.scrollTop;
    else if (wrote) this.bodyEl.scrollTop = scrollTop;
    this.paintedView = view;
    if (loaded && view.target.kind === 'home' && (wrote || switched)) this.rememberSeen();
  }

  private bodyHtml(view: CodexView, state: ServerStateMessage | null): string {
    const index = this.index(state);
    const ctx: CodexViewContext = { index, state, world: this.host.worldCache };
    const { target } = view;
    if (target.kind === 'home') {
      if (!this.seenAtOpen && state?.username) this.seenAtOpen = readSeen(state.username);
      const newKeys = this.seenAtOpen ? newRecentKeys(index.recent, this.seenAtOpen) : new Set<string>();
      return codexHomeHtml(ctx, { query: this.homeQuery, newKeys });
    }
    if (target.kind === 'list') {
      const list = this.lists[target.list];
      const opts: CodexListOptions = { query: list.query, sort: list.sort, shown: list.shown, zones: list.zones, zoneShown: list.zoneShown };
      return codexListHtml(target.list, ctx, opts);
    }
    return codexEntryHtml(target, ctx, view.expanded);
  }

  /** "New" is judged against the seen list as it stood at this opening; the next opening shows only what arrived since. */
  private rememberSeen(): void {
    const username = this.host.gameClient.lastState?.username;
    if (username && this.memo) writeSeen(username, this.memo.index.recent.map(codexRefKey));
  }

  private paintHeader(view: CodexView): void {
    const { target } = view;
    const title = target.kind === 'list' ? LIST_TITLES[target.list] : 'Codex';
    if (this.titleEl && this.titleEl.textContent !== title) this.titleEl.textContent = title;
    if (this.backBtn) this.backBtn.hidden = this.stack.length <= 1;
    if (this.homeBtn) this.homeBtn.hidden = target.kind === 'home';
  }

  private paintControls(view: CodexView, switched: boolean): void {
    const { controlsEl, searchEl, sortEl } = this;
    if (!controlsEl || !searchEl || !sortEl) return;
    const { target } = view;
    const searchable = target.kind === 'home' || target.kind === 'list';
    controlsEl.hidden = !searchable;
    if (!switched || !searchable) return;
    const list = this.listOf(view);
    searchEl.value = list ? list.query : this.homeQuery;
    searchEl.placeholder = target.kind === 'list' ? `Search ${LIST_TITLES[target.list].toLowerCase()}` : 'Search the Codex';
    searchEl.setAttribute('aria-label', searchEl.placeholder);
    const sorts = target.kind === 'list' && target.list !== 'room' ? CODEX_SORTS[target.list as CodexListSort] : [];
    sortEl.hidden = sorts.length === 0;
    sortEl.innerHTML = sorts
      .map(sort => `<option value="${sort}"${sort === list?.sort ? ' selected' : ''}>${escapeHtml(CODEX_SORT_LABELS[sort])}</option>`)
      .join('');
  }
}
