/** Allows at most `limit` takes per key in any rolling `windowMs`. Refused takes are not counted. */
export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Whether a take for `key` would succeed right now, without counting one. */
  allows(key: string): boolean {
    return this.recent(key).length < this.limit;
  }

  /** Counts a take for `key` and returns true, or returns false when the key is at its limit. */
  tryTake(key: string): boolean {
    const recent = this.recent(key);
    if (recent.length >= this.limit) return false;
    recent.push(this.now());
    this.hits.set(key, recent);
    return true;
  }

  /** How many keys are held, including idle ones `prune` has not dropped yet. */
  get keyCount(): number {
    return this.hits.size;
  }

  /** Drops keys with no takes left inside the window. */
  prune(): void {
    for (const key of [...this.hits.keys()]) {
      if (this.recent(key).length === 0) this.hits.delete(key);
    }
  }

  private recent(key: string): number[] {
    const stamps = this.hits.get(key);
    if (!stamps) return [];
    const cutoff = this.now() - this.windowMs;
    const recent = stamps.filter(stamp => stamp > cutoff);
    if (recent.length !== stamps.length) this.hits.set(key, recent);
    return recent;
  }
}
