import type { MasteryEntry, MasterySummary, MonsterTier } from '@idle-party-rpg/shared';
import { LEVEL_CON_INFO, isMasteryMoment, levelCon } from '@idle-party-rpg/shared';
import type { GameClient } from '../network/GameClient';
import { bringToFront, release, wireFocusOnInteract } from './ModalStack';
import { renderAssetImg } from './assets';

export type BestiarySort = 'closest' | 'kills' | 'name' | 'rank';

export const BESTIARY_SORT_LABELS: Record<BestiarySort, string> = {
  closest: 'Closest',
  kills: 'Kills',
  rank: 'Rank',
  name: 'Name',
};

const TIER_BADGES: Partial<Record<MonsterTier, { glyph: string; label: string }>> = {
  elite: { glyph: '◆', label: 'Elite' },
  boss: { glyph: '♛', label: 'Boss' },
  raid: { glyph: '♛', label: 'Raid boss' },
};

const PCT = ' %';
const MASTERY_TOAST_MS = 5000;
const BESTIARY_CARD_ROWS = 3;
export const BESTIARY_REFRESH_MS = 1000;

/** Progress from the current rank's threshold to the next (1 when mastered). */
export function masteryProgress(entry: Pick<MasteryEntry, 'kills' | 'prevAt' | 'nextAt'>): number {
  if (entry.nextAt === null) return 1;
  const span = entry.nextAt - entry.prevAt;
  if (!(span > 0)) return 0;
  return Math.max(0, Math.min(1, (entry.kills - entry.prevAt) / span));
}

export function nextRankText(entry: Pick<MasteryEntry, 'nextAt'>): string {
  return entry.nextAt === null ? 'Mastered' : `Next rank at ${entry.nextAt.toLocaleString('en-US')}`;
}

export function masteryStars(entry: Pick<MasteryEntry, 'rank' | 'maxRank'>): string {
  const max = Math.max(1, entry.maxRank);
  const rank = Math.max(0, Math.min(max, entry.rank));
  return '★'.repeat(rank) + '☆'.repeat(max - rank);
}

function compareClosest(a: MasteryEntry, b: MasteryEntry): number {
  const aDone = a.nextAt === null;
  const bDone = b.nextAt === null;
  if (aDone !== bDone) return aDone ? 1 : -1;
  const diff = masteryProgress(b) - masteryProgress(a);
  if (diff !== 0) return diff;
  const aLeft = (a.nextAt ?? 0) - a.kills;
  const bLeft = (b.nextAt ?? 0) - b.kills;
  return aLeft - bLeft || a.name.localeCompare(b.name);
}

export function sortBestiary(entries: readonly MasteryEntry[], mode: BestiarySort): MasteryEntry[] {
  const list = [...entries];
  switch (mode) {
    case 'closest':
      return list.sort(compareClosest);
    case 'kills':
      return list.sort((a, b) => b.kills - a.kills || a.name.localeCompare(b.name));
    case 'rank':
      return list.sort((a, b) => b.rank - a.rank || masteryProgress(b) - masteryProgress(a) || a.name.localeCompare(b.name));
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export function filterBestiary(entries: readonly MasteryEntry[], query: string): MasteryEntry[] {
  const q = query.trim().toLowerCase();
  return q ? entries.filter(e => e.name.toLowerCase().includes(q)) : [...entries];
}

/** The `count` entries nearest to their next rank (mastered entries excluded). */
export function closestToNextRank(entries: readonly MasteryEntry[], count: number): MasteryEntry[] {
  return sortBestiary(entries.filter(e => e.nextAt !== null && e.kills > 0), 'closest').slice(0, Math.max(0, count));
}

/** Full-list entries refreshed with the (fresher) recent entries from state. */
export function mergeBestiaryEntries(full: readonly MasteryEntry[], recent: readonly MasteryEntry[]): MasteryEntry[] {
  const byId = new Map<string, MasteryEntry>();
  for (const e of full) byId.set(e.monsterId, e);
  for (const e of recent) byId.set(e.monsterId, e);
  return [...byId.values()];
}

export function bestiarySummaryText(summary: Pick<MasterySummary, 'discovered' | 'mastered'>): string {
  return `${summary.discovered.toLocaleString('en-US')} discovered · ${summary.mastered.toLocaleString('en-US')} mastered`;
}

/** One bestiary row; levels show only when authored. */
export function renderBestiaryRow(entry: MasteryEntry, viewerLevel: number | undefined, opts?: { compact?: boolean }): string {
  const progress = masteryProgress(entry);
  const pct = Math.round(progress * 100);
  const levelHtml = entry.level !== undefined && !entry.levelDerived && entry.level > 0
    ? levelBadge(entry.level, viewerLevel)
    : '';
  const tier = entry.tier ? TIER_BADGES[entry.tier] : undefined;
  const tierHtml = tier
    ? `<span class="bestiary-tier" data-tier="${entry.tier}">${tier.glyph} ${tier.label}</span>`
    : '';
  const bonus = entry.bonusPct > 0
    ? `<span class="bestiary-bonus">+${entry.bonusPct}${PCT} damage · −${entry.bonusPct}${PCT} taken</span>`
    : '';
  const kills = `<span class="bestiary-kills">${entry.kills.toLocaleString('en-US')} defeated</span>`;
  const next = `<span class="bestiary-next">${nextRankText(entry)}</span>`;
  const art = renderAssetImg('monster', entry.monsterId, { label: entry.name, width: 96, height: 96, alt: '' });
  const compact = opts?.compact ? ' bestiary-row-compact' : '';
  return `<div class="bestiary-row${compact}" role="listitem" data-monster-id="${escapeHtml(entry.monsterId)}" data-rank="${entry.rank}"${entry.nextAt === null ? ' data-mastered="true"' : ''}>`
    + `<span class="bestiary-art">${art}</span>`
    + '<div class="bestiary-main">'
    + `<div class="bestiary-title"><span class="bestiary-name">${escapeHtml(entry.name)}</span>${levelHtml}${tierHtml}</div>`
    + '<div class="bestiary-progress">'
    + `<div class="bestiary-bar" role="progressbar" aria-label="Progress to next rank" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}">`
    + `<div class="bestiary-bar-fill" style="width:${pct}%"></div></div>`
    + `<span class="bestiary-stars" role="img" aria-label="Rank ${entry.rank} of ${entry.maxRank}">${masteryStars(entry)}</span></div>`
    + `<div class="bestiary-sub">${kills}${next}${opts?.compact ? '' : bonus}</div>`
    + '</div></div>';
}

/** Shows `entries` as rows in `container`, patching rows in place so their portraits and position survive. */
export function syncBestiaryRows(
  container: HTMLElement,
  entries: readonly MasteryEntry[],
  viewerLevel: number | undefined,
  opts?: { compact?: boolean },
): void {
  const existing = new Map<string, HTMLElement>();
  for (const row of Array.from(container.children) as HTMLElement[]) {
    if (row.classList.contains('bestiary-row')) existing.set(row.dataset.monsterId ?? '', row);
  }
  const template = document.createElement('template');
  const rows = entries.map(entry => {
    template.innerHTML = renderBestiaryRow(entry, viewerLevel, opts);
    const fresh = template.content.firstElementChild as HTMLElement;
    const row = existing.get(entry.monsterId);
    if (!row) return fresh;
    for (const name of row.getAttributeNames()) if (!fresh.hasAttribute(name)) row.removeAttribute(name);
    for (const name of fresh.getAttributeNames()) row.setAttribute(name, fresh.getAttribute(name)!);
    const main = row.querySelector('.bestiary-main');
    const freshMain = fresh.querySelector('.bestiary-main');
    if (main && freshMain && main.innerHTML !== freshMain.innerHTML) main.replaceWith(freshMain);
    return row;
  });
  rows.forEach((row, i) => {
    const at = container.children[i] ?? null;
    if (at !== row) container.insertBefore(row, at);
  });
  while (container.children.length > rows.length) container.lastElementChild!.remove();
}

/** The Hero screen's bestiary card; re-renders only when what it shows changes. */
export class BestiaryCard {
  private key = '';

  constructor(private el: HTMLElement) {}

  update(summary: MasterySummary | undefined, full: readonly MasteryEntry[], viewerLevel: number | undefined): void {
    if (!summary) {
      this.key = '';
      delete this.el.dataset.mode;
      this.el.innerHTML = '';
      return;
    }
    const rows = closestToNextRank(mergeBestiaryEntries(full, summary.recent), BESTIARY_CARD_ROWS);
    const key = JSON.stringify([summary.discovered, summary.mastered, viewerLevel, rows]);
    if (key === this.key) return;
    this.key = key;
    this.render(summary, rows, viewerLevel);
  }

  private render(summary: MasterySummary, rows: readonly MasteryEntry[], viewerLevel: number | undefined): void {
    const mode = summary.discovered === 0 ? 'empty' : 'list';
    if (this.el.dataset.mode !== mode) {
      this.el.dataset.mode = mode;
      const label = '<div class="items-section-label">Bestiary <span class="items-section-count"></span></div>';
      this.el.innerHTML = mode === 'empty'
        ? `${label}<div class="bestiary-card"><div class="bestiary-card-empty">`
          + 'Defeat monsters to fill your bestiary. Each rank makes you a little stronger against them.</div></div>'
        : `${label}<div class="bestiary-card">`
          + '<div class="bestiary-card-summary"></div>'
          + '<div class="bestiary-card-rows" role="list" aria-label="Closest to the next rank"></div>'
          + '<button type="button" class="pixel-btn bestiary-view-all">View all ›</button>'
          + '</div>';
    }
    this.el.querySelector('.items-section-count')!.textContent = `(${summary.discovered})`;
    if (mode === 'empty') return;
    this.el.querySelector('.bestiary-card-summary')!.textContent = bestiarySummaryText(summary);
    const rowsEl = this.el.querySelector<HTMLElement>('.bestiary-card-rows')!;
    rowsEl.hidden = rows.length === 0;
    syncBestiaryRows(rowsEl, rows, viewerLevel, { compact: true });
  }
}

function levelBadge(level: number, viewerLevel: number | undefined): string {
  const con = levelCon(level, viewerLevel ?? level);
  const info = LEVEL_CON_INFO[con];
  return `<span class="lvl-badge bestiary-lvl" data-con="${con}" aria-label="Level ${level}, ${info.label}">`
    + `<span aria-hidden="true">${info.glyph} L${level}</span></span>`;
}

/** Full bestiary list on the modal stack: search, sort, rank bars. */
export class BestiaryModal {
  private overlay: HTMLElement | null = null;
  private listEl: HTMLElement | null = null;
  private summaryEl: HTMLElement | null = null;
  private query = '';
  private sort: BestiarySort = 'closest';
  private unsubBestiary?: () => void;
  private unsubState?: () => void;
  private shownVersion: number | undefined;
  private renderedAt = 0;
  private refreshTimer?: ReturnType<typeof setTimeout>;
  private keyHandler = (e: KeyboardEvent): void => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    this.close();
  };

  constructor(private gameClient: GameClient) {}

  get isOpen(): boolean {
    return this.overlay !== null;
  }

  open(): void {
    if (this.overlay) return;
    const overlay = document.createElement('div');
    overlay.className = 'player-options-overlay bestiary-overlay';
    overlay.innerHTML = `
      <div class="player-options-modal bestiary-modal" role="dialog" aria-modal="true" aria-label="Bestiary">
        <div class="player-options-header">
          <span class="player-options-title">Bestiary</span>
          <button type="button" class="player-options-close" aria-label="Close">×</button>
        </div>
        <div class="bestiary-body">
          <div class="bestiary-summary"></div>
          <div class="items-search-sort bestiary-controls">
            <input type="search" class="items-search-input bestiary-search" placeholder="Search…" aria-label="Search monsters" />
            <select class="items-sort-select bestiary-sort" aria-label="Sort by">
              ${(Object.keys(BESTIARY_SORT_LABELS) as BestiarySort[])
                .map(k => `<option value="${k}"${k === this.sort ? ' selected' : ''}>${BESTIARY_SORT_LABELS[k]}</option>`).join('')}
            </select>
          </div>
          <div class="bestiary-list" role="list"></div>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);
    this.overlay = overlay;
    this.listEl = overlay.querySelector('.bestiary-list');
    this.summaryEl = overlay.querySelector('.bestiary-summary');

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) this.close();
    });
    overlay.querySelector('.player-options-close')!.addEventListener('click', () => this.close());
    const search = overlay.querySelector('.bestiary-search') as HTMLInputElement;
    search.value = this.query;
    search.addEventListener('input', () => {
      this.query = search.value;
      this.renderList();
    });
    const sort = overlay.querySelector('.bestiary-sort') as HTMLSelectElement;
    sort.addEventListener('change', () => {
      this.sort = sort.value as BestiarySort;
      this.renderList();
    });
    document.addEventListener('keydown', this.keyHandler);

    this.unsubBestiary = this.gameClient.onBestiary(() => this.renderList());
    this.unsubState = this.gameClient.subscribe(state => this.onMasteryVersion(state.character?.mastery?.version));
    this.gameClient.requestBestiary();
    this.renderList();

    bringToFront(overlay, () => this.close());
    wireFocusOnInteract(overlay);
  }

  close(): void {
    if (!this.overlay) return;
    this.unsubBestiary?.();
    this.unsubBestiary = undefined;
    this.unsubState?.();
    this.unsubState = undefined;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    this.refreshTimer = undefined;
    document.removeEventListener('keydown', this.keyHandler);
    release(this.overlay);
    this.overlay.remove();
    this.overlay = null;
    this.listEl = null;
    this.summaryEl = null;
  }

  private onMasteryVersion(version: number | undefined): void {
    if (version === this.shownVersion || this.refreshTimer) return;
    const wait = this.renderedAt + BESTIARY_REFRESH_MS - Date.now();
    if (wait <= 0) {
      this.renderList();
      return;
    }
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = undefined;
      this.renderList();
    }, wait);
  }

  private renderList(): void {
    if (!this.listEl || !this.summaryEl) return;
    const state = this.gameClient.lastState;
    const summary = state?.character?.mastery;
    this.shownVersion = summary?.version;
    this.renderedAt = Date.now();
    const bestiary = this.gameClient.lastBestiary;
    if (summary) this.summaryEl.textContent = bestiarySummaryText(summary);
    if (!bestiary) {
      this.listEl.innerHTML = '<div class="bestiary-empty">Loading…</div>';
      return;
    }
    const entries = mergeBestiaryEntries(bestiary.entries, summary?.recent ?? []);
    if (entries.length === 0) {
      this.listEl.innerHTML = '<div class="bestiary-empty">Defeat monsters to fill your bestiary.</div>';
      return;
    }
    const shown = sortBestiary(filterBestiary(entries, this.query), this.sort);
    if (shown.length === 0) {
      this.listEl.innerHTML = '<div class="bestiary-empty">No monsters match your search.</div>';
      return;
    }
    syncBestiaryRows(this.listEl, shown, state?.character?.level);
  }
}

/**
 * Rank-ups worth a toast. Unknown monsters count as rank 0 only when the discovered count grew
 * by at least as many, so a first boss kill toasts but a known-but-unseeded monster does not.
 */
export function masteryRankUps(known: ReadonlyMap<string, number>, entries: readonly MasteryEntry[], newlyDiscovered = 0): MasteryEntry[] {
  const unknown = entries.filter(e => !known.has(e.monsterId)).length;
  const unknownAreNew = unknown > 0 && unknown <= newlyDiscovered;
  return entries.filter(e => {
    const before = known.get(e.monsterId) ?? (unknownAreNew ? 0 : undefined);
    return before !== undefined && e.rank > before && isMasteryMoment(e.rank, e.tier);
  });
}

export function masteryToastText(entry: Pick<MasteryEntry, 'name' | 'rank' | 'bonusPct'>): string {
  return `Mastery rank ${entry.rank}: ${entry.name} · +${entry.bonusPct}${PCT} against them`;
}

/** Toasts live mastery rank-ups; ranks gained while away are left to the recap. */
export class MasteryToasts {
  private known = new Map<string, number>();
  private discovered: number | null = null;
  private toast: HTMLElement | null = null;
  private timer?: ReturnType<typeof setTimeout>;
  private unsubscribers: (() => void)[] = [];

  constructor(private gameClient: GameClient, private onOpen: () => void) {
    this.unsubscribers.push(
      gameClient.onBestiary(msg => this.seed(msg.entries)),
      gameClient.subscribe(state => this.update(state.character?.mastery, gameClient.isInitialState)),
    );
    if (gameClient.lastState) this.update(gameClient.lastState.character?.mastery, true);
  }

  destroy(): void {
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    this.remove();
  }

  private seed(entries: readonly MasteryEntry[]): void {
    for (const e of entries) if (!this.known.has(e.monsterId)) this.known.set(e.monsterId, e.rank);
  }

  private update(summary: MasterySummary | undefined, snapshot: boolean): void {
    const recent = summary?.recent ?? [];
    if (snapshot && recent.length > 0 && !this.gameClient.lastBestiary) this.gameClient.requestBestiary();
    const newlyDiscovered = summary && this.discovered !== null ? summary.discovered - this.discovered : 0;
    if (summary) this.discovered = summary.discovered;
    const ups = snapshot ? [] : masteryRankUps(this.known, recent, newlyDiscovered);
    for (const e of recent) this.known.set(e.monsterId, e.rank);
    const best = ups.sort((a, b) => b.rank - a.rank)[0];
    if (best) this.show(best);
  }

  private show(entry: MasteryEntry): void {
    this.remove();
    const toast = document.createElement('button');
    toast.type = 'button';
    toast.className = 'recap-toast mastery-toast';
    toast.setAttribute('role', 'status');
    toast.textContent = `⭐ ${masteryToastText(entry)}`;
    toast.addEventListener('click', () => {
      this.remove();
      this.onOpen();
    });
    document.body.appendChild(toast);
    bringToFront(toast);
    this.toast = toast;
    this.timer = setTimeout(() => this.remove(), MASTERY_TOAST_MS);
  }

  private remove(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.toast) return;
    release(this.toast);
    this.toast.remove();
    this.toast = null;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
