import type { CombatLogEntry, CombatLogType } from '@idle-party-rpg/shared';

export const COMBAT_LOG_CAPACITY = 300;

export interface CombatLogLine {
  key: string;
  /** Monotonic per buffer; views append lines whose seq exceeds the last one they rendered. */
  seq: number;
  text: string;
  type: CombatLogType;
}

interface PendingBatch {
  battleId: number;
  releaseAt: number;
  lines: { key: string; text: string }[];
}

type Listener = () => void;

/** Live lines carry no type. */
const LIVE_LINE_TYPE: CombatLogType = 'damage';

/** Journal lines come from state messages; live lines are keyed `c:` by the battle they belong to. */
export function isJournalLine(line: Pick<CombatLogLine, 'key'>): boolean {
  return line.key.startsWith('j:');
}

/**
 * Ring of journal entries (from state messages) merged with live combat lines
 * (from combat messages). See docs/architecture/client.md.
 */
export class CombatLogBuffer {
  private lines: CombatLogLine[] = [];
  private keys = new Set<string>();
  private pending: PendingBatch[] = [];
  private listeners = new Set<Listener>();
  private nextSeq = 1;
  private liveMessageSeq = 0;
  private lastJournalId = -1;
  private holdLive = false;
  private gen = 0;
  private readonly capacity: number;

  constructor(capacity = COMBAT_LOG_CAPACITY) {
    this.capacity = capacity;
  }

  get entries(): readonly CombatLogLine[] {
    return this.lines;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  /** Bumped whenever lines leave from anywhere but the front — views must re-render fully. */
  get generation(): number {
    return this.gen;
  }

  get pendingCount(): number {
    return this.pending.reduce((n, b) => n + b.lines.length, 0);
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  ingestJournal(entries: readonly CombatLogEntry[]): void {
    if (entries.length === 0) return;
    const newest = entries[entries.length - 1].id;
    let changed = false;
    if (newest < this.lastJournalId) {
      this.removeWhere(line => line.key.startsWith('j:'));
      this.lastJournalId = -1;
      changed = true;
    }
    for (const entry of entries) {
      if (entry.id <= this.lastJournalId) continue;
      this.lastJournalId = entry.id;
      const key = `j:${entry.id}`;
      if (this.keys.has(key)) continue;
      this.append(key, entry.text, entry.type);
      changed = true;
    }
    if (changed) this.commit();
  }

  /** Queue a combat message's lines; they surface once playback reaches `releaseAt` (or at once when not held). */
  pushLive(battleId: number, texts: readonly string[], releaseAt?: number): void {
    if (texts.length === 0) return;
    const seq = ++this.liveMessageSeq;
    const lines = texts.map((text, i) => ({ key: `c:${battleId}:${seq}:${i}`, text }));
    if (!this.holdLive || releaseAt === undefined) {
      this.flushPending(() => true);
      for (const line of lines) this.append(line.key, line.text, LIVE_LINE_TYPE);
      this.commit();
      return;
    }
    this.pending.push({ battleId, releaseAt, lines });
  }

  /** Resync: the server's recent live lines for `battleId` replace whatever this buffer holds for it. */
  replaceLive(battleId: number, texts: readonly string[]): void {
    const prefix = `c:${battleId}:`;
    this.pending = this.pending.filter(b => b.battleId !== battleId);
    this.flushPending(() => true);
    this.removeWhere(line => line.key.startsWith(prefix));
    const seq = ++this.liveMessageSeq;
    texts.forEach((text, i) => this.append(`c:${battleId}:${seq}:${i}`, text, LIVE_LINE_TYPE));
    this.commit();
  }

  /** Release held lines in arrival order: other battles' lines at once, this battle's once `renderTime` reaches them. */
  release(battleId: number | null, renderTime: number): void {
    if (this.pending.length === 0) return;
    if (this.flushPending(b => b.battleId !== battleId || b.releaseAt <= renderTime)) this.commit();
  }

  releaseAll(): void {
    if (this.flushPending(() => true)) this.commit();
  }

  setHoldLive(hold: boolean): void {
    this.holdLive = hold;
    if (!hold) this.releaseAll();
  }

  private flushPending(due: (batch: PendingBatch) => boolean): boolean {
    let released = false;
    while (this.pending.length > 0 && due(this.pending[0])) {
      const batch = this.pending.shift()!;
      for (const line of batch.lines) this.append(line.key, line.text, LIVE_LINE_TYPE);
      released = true;
    }
    return released;
  }

  private append(key: string, text: string, type: CombatLogType): void {
    if (this.keys.has(key)) return;
    this.keys.add(key);
    this.lines.push({ key, seq: this.nextSeq++, text, type });
  }

  private removeWhere(predicate: (line: CombatLogLine) => boolean): void {
    const kept = this.lines.filter(line => !predicate(line));
    if (kept.length === this.lines.length) return;
    this.lines = kept;
    this.keys = new Set(kept.map(line => line.key));
    this.gen++;
  }

  private commit(): void {
    const overflow = this.lines.length - this.capacity;
    if (overflow > 0) {
      for (const line of this.lines.splice(0, overflow)) this.keys.delete(line.key);
    }
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (err) {
        console.error('[CombatLogBuffer] listener error:', err);
      }
    }
  }
}
