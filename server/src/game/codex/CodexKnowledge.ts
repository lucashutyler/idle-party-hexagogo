import { CODEX_CAPS, CODEX_DROP_TALLY_MAX, CODEX_RECENT_MAX, isCodexId, isCodexRef } from '@idle-party-rpg/shared';
import type { CodexKind, CodexRef, CodexSaveData } from '@idle-party-rpg/shared';

export type CodexFightPlace =
  | { kind: 'room'; encounterId?: string; shopId?: string }
  | { kind: 'dungeon'; dungeonId: string };

export interface CodexBackfill {
  monsters: Iterable<string>;
  items: Iterable<string>;
  dungeons: Iterable<string>;
}

const RECENT_KINDS: readonly CodexKind[] = ['monster', 'item', 'shop'];
const NO_DROPS: ReadonlyMap<string, number> = new Map();

let serialCounter = 0;

/** What one player has met, fought, held and visited. Pure: no content, no clock. See docs/architecture/codex.md. */
export class CodexKnowledge {
  readonly serial = ++serialCounter;
  private readonly monsters = new Set<string>();
  private readonly encounters = new Set<string>();
  private readonly items = new Set<string>();
  private readonly shops = new Set<string>();
  private readonly dungeons = new Set<string>();
  private readonly drops = new Map<string, Map<string, number>>();
  private dropPairs = 0;
  private recent: CodexRef[] = [];
  private changes = 0;

  /** Never throws: anything unreadable is left out. */
  static fromSave(raw: unknown): CodexKnowledge {
    try {
      const knowledge = new CodexKnowledge();
      knowledge.load(raw);
      return knowledge;
    } catch {
      return new CodexKnowledge();
    }
  }

  /** Bumps on every new fact and every raised tally; in memory only. */
  get revision(): number {
    return this.changes;
  }

  toSave(): CodexSaveData | undefined {
    const data: CodexSaveData = {};
    if (this.monsters.size > 0) data.monsters = [...this.monsters];
    if (this.encounters.size > 0) data.encounters = [...this.encounters];
    if (this.items.size > 0) data.items = [...this.items];
    if (this.shops.size > 0) data.shops = [...this.shops];
    if (this.dungeons.size > 0) data.dungeons = [...this.dungeons];
    if (this.drops.size > 0) {
      data.drops = Object.fromEntries([...this.drops].map(([monsterId, perItem]) => [monsterId, Object.fromEntries(perItem)]));
    }
    if (this.recent.length > 0) data.recent = this.recent.map(ref => ({ kind: ref.kind, id: ref.id }));
    return Object.keys(data).length > 0 ? data : undefined;
  }

  /** Adds without a revision bump or a recent line. */
  mergeBackfill(source: CodexBackfill): void {
    for (const id of source.monsters) this.insert(this.monsters, id, CODEX_CAPS.monsters);
    for (const id of source.items) this.insert(this.items, id, CODEX_CAPS.items);
    for (const id of source.dungeons) this.insert(this.dungeons, id, CODEX_CAPS.dungeons);
  }

  /** Newly met monster ids, in fight order. */
  noteFight(monsterIds: readonly string[], place: CodexFightPlace): string[] {
    const fresh: string[] = [];
    for (const id of monsterIds) {
      if (!this.add(this.monsters, id, CODEX_CAPS.monsters)) continue;
      fresh.push(id);
      this.pushRecent({ kind: 'monster', id });
    }
    if (place.kind === 'dungeon') {
      this.add(this.dungeons, place.dungeonId, CODEX_CAPS.dungeons);
      return fresh;
    }
    if (place.encounterId !== undefined) this.add(this.encounters, place.encounterId, CODEX_CAPS.encounters);
    if (place.shopId !== undefined && this.add(this.shops, place.shopId, CODEX_CAPS.shops)) {
      this.pushRecent({ kind: 'shop', id: place.shopId });
    }
    return fresh;
  }

  noteDrop(monsterId: string, itemId: string): void {
    this.noteItem(itemId);
    if (!isCodexId(monsterId) || !isCodexId(itemId)) return;
    const perItem = this.drops.get(monsterId);
    const seen = perItem?.get(itemId);
    if (perItem && seen !== undefined) {
      if (seen >= CODEX_DROP_TALLY_MAX) return;
      perItem.set(itemId, seen + 1);
      this.changes++;
      return;
    }
    if (!this.setDrop(monsterId, itemId, 1)) return;
    this.changes++;
  }

  noteItem(itemId: string): void {
    if (this.add(this.items, itemId, CODEX_CAPS.items)) this.pushRecent({ kind: 'item', id: itemId });
  }

  hasMonster(id: string): boolean { return this.monsters.has(id); }
  hasEncounter(id: string): boolean { return this.encounters.has(id); }
  hasItem(id: string): boolean { return this.items.has(id); }
  hasShop(id: string): boolean { return this.shops.has(id); }
  hasDungeon(id: string): boolean { return this.dungeons.has(id); }

  monsterIds(): readonly string[] { return [...this.monsters]; }
  encounterIds(): readonly string[] { return [...this.encounters]; }
  itemIds(): readonly string[] { return [...this.items]; }
  shopIds(): readonly string[] { return [...this.shops]; }
  dungeonIds(): readonly string[] { return [...this.dungeons]; }

  dropsOf(monsterId: string): ReadonlyMap<string, number> {
    return this.drops.get(monsterId) ?? NO_DROPS;
  }

  recentRefs(): readonly CodexRef[] {
    return this.recent.map(ref => ({ kind: ref.kind, id: ref.id }));
  }

  private load(raw: unknown): void {
    if (!isRecord(raw)) return;
    this.insertAll(this.monsters, raw.monsters, CODEX_CAPS.monsters);
    this.insertAll(this.encounters, raw.encounters, CODEX_CAPS.encounters);
    this.insertAll(this.items, raw.items, CODEX_CAPS.items);
    this.insertAll(this.shops, raw.shops, CODEX_CAPS.shops);
    this.insertAll(this.dungeons, raw.dungeons, CODEX_CAPS.dungeons);
    if (isRecord(raw.drops)) {
      for (const [monsterId, perItem] of Object.entries(raw.drops)) {
        if (!isCodexId(monsterId) || !isRecord(perItem)) continue;
        for (const [itemId, seen] of Object.entries(perItem)) {
          if (isCodexId(itemId) && isTally(seen)) this.setDrop(monsterId, itemId, Math.min(seen, CODEX_DROP_TALLY_MAX));
        }
      }
    }
    if (Array.isArray(raw.recent)) {
      const keys = new Set<string>();
      for (const ref of raw.recent) {
        if (this.recent.length >= CODEX_RECENT_MAX) break;
        if (!isCodexRef(ref) || !RECENT_KINDS.includes(ref.kind)) continue;
        const key = `${ref.kind}:${ref.id}`;
        if (keys.has(key)) continue;
        keys.add(key);
        this.recent.push({ kind: ref.kind, id: ref.id });
      }
    }
  }

  private insertAll(set: Set<string>, raw: unknown, cap: number): void {
    if (!Array.isArray(raw)) return;
    for (const id of raw) this.insert(set, id, cap);
  }

  /** At a cap the id is skipped. */
  private insert(set: Set<string>, id: unknown, cap: number): boolean {
    if (!isCodexId(id) || set.has(id) || set.size >= cap) return false;
    set.add(id);
    return true;
  }

  private add(set: Set<string>, id: string, cap: number): boolean {
    if (!this.insert(set, id, cap)) return false;
    this.changes++;
    return true;
  }

  private setDrop(monsterId: string, itemId: string, seen: number): boolean {
    let perItem = this.drops.get(monsterId);
    if (!perItem?.has(itemId)) {
      if (this.dropPairs >= CODEX_CAPS.dropPairs) return false;
      this.dropPairs++;
    }
    if (!perItem) {
      perItem = new Map();
      this.drops.set(monsterId, perItem);
    }
    perItem.set(itemId, seen);
    return true;
  }

  private pushRecent(ref: CodexRef): void {
    this.recent = [ref, ...this.recent.filter(r => r.kind !== ref.kind || r.id !== ref.id)].slice(0, CODEX_RECENT_MAX);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTally(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
