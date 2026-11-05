/** How stale a roster may be. Far less than the gap between one player's pushes, which is when they would see it anyway. */
export const ROSTER_REFRESH_MS = 100;
/** A socket further behind than the log reaches gets a whole copy, so the log stays in proportion to the roster. */
const MIN_LOGGED_CHANGES = 256;

/** Key → that entry's JSON. */
export type RosterEntries = Map<string, string>;

export interface RosterSnapshot {
  otherPlayersByZone: Map<string, RosterEntries>;
  allPlayers: RosterEntries;
  onlinePlayers: RosterEntries;
}

/** One roster, serialised once, with a log of what changed so a socket holding an older version can catch up. */
export class VersionedRoster {
  version = 0;
  private entries: RosterEntries = new Map();
  private log: { version: number; key: string }[] = [];
  private forgottenThrough = 0;
  private wholeJson: string | null = '[]';

  update(next: RosterEntries): void {
    const version = this.version + 1;
    const loggedBefore = this.log.length;
    for (const [key, json] of next) {
      if (this.entries.get(key) !== json) this.log.push({ version, key });
    }
    for (const key of this.entries.keys()) {
      if (!next.has(key)) this.log.push({ version, key });
    }
    if (this.log.length === loggedBefore) return;

    this.version = version;
    this.entries = next;
    this.wholeJson = null;
    const excess = this.log.length - Math.max(MIN_LOGGED_CHANGES, next.size * 2);
    if (excess > 0) {
      this.forgottenThrough = this.log[excess - 1].version;
      this.log.splice(0, excess);
    }
  }

  whole(): string {
    this.wholeJson ??= `[${[...this.entries.values()].join(',')}]`;
    return this.wholeJson;
  }

  /** JSON of what changed since `version`, or null when a whole copy is what to send. */
  changesSince(version: number): string | null {
    if (version < this.forgottenThrough) return null;
    const keys = new Set<string>();
    for (let i = this.log.length - 1; i >= 0 && this.log[i].version > version; i--) keys.add(this.log[i].key);
    if (keys.size * 2 > this.entries.size) return null;

    const upserts: string[] = [];
    const removes: string[] = [];
    for (const key of keys) {
      const json = this.entries.get(key);
      if (json !== undefined) upserts.push(json);
      else removes.push(JSON.stringify(key));
    }
    const parts: string[] = [];
    if (upserts.length > 0) parts.push(`"upserts":[${upserts.join(',')}]`);
    if (removes.length > 0) parts.push(`"removes":[${removes.join(',')}]`);
    return `{${parts.join(',')}}`;
  }
}

interface HeldRosters {
  zone: string;
  otherPlayers: number;
  allPlayers: number;
  onlinePlayers: number;
}

function encodeRoster(name: string, roster: VersionedRoster, heldVersion: number | undefined): string | null {
  if (heldVersion === roster.version) return null;
  const changes = heldVersion === undefined ? null : roster.changesSince(heldVersion);
  return `"${name}":${changes ?? `{"whole":${roster.whole()}}`}`;
}

/**
 * Builds the player rosters once, however many sockets they go to, and works out what each socket is missing.
 * See docs/architecture/client.md → WebSocket data use.
 */
export class SharedRosters {
  private otherPlayersByZone = new Map<string, VersionedRoster>();
  private allPlayers = new VersionedRoster();
  private onlinePlayers = new VersionedRoster();
  private refreshedAt = Number.NEGATIVE_INFINITY;
  private held = new WeakMap<object, HeldRosters>();

  constructor(
    private readonly snapshot: () => RosterSnapshot,
    private readonly now: () => number = Date.now,
  ) {}

  /** The next push builds fresh rosters instead of waiting out `ROSTER_REFRESH_MS`. */
  invalidate(): void {
    this.refreshedAt = Number.NEGATIVE_INFINITY;
  }

  /**
   * The `rosters` field of one socket's state push, and records what the socket then holds.
   * Must only be called for a message that is really sent.
   */
  encodeFor(socket: object, zone: string): string {
    this.refresh();
    const otherPlayers = this.otherPlayersIn(zone);
    const held = this.held.get(socket);
    const parts = [
      encodeRoster('otherPlayers', otherPlayers, held?.zone === zone ? held.otherPlayers : undefined),
      encodeRoster('allPlayers', this.allPlayers, held?.allPlayers),
      encodeRoster('onlinePlayers', this.onlinePlayers, held?.onlinePlayers),
    ].filter(part => part !== null);
    this.held.set(socket, {
      zone,
      otherPlayers: otherPlayers.version,
      allPlayers: this.allPlayers.version,
      onlinePlayers: this.onlinePlayers.version,
    });
    return `{${parts.join(',')}}`;
  }

  private refresh(): void {
    const now = this.now();
    if (now - this.refreshedAt < ROSTER_REFRESH_MS) return;
    this.refreshedAt = now;

    const { otherPlayersByZone, allPlayers, onlinePlayers } = this.snapshot();
    for (const [zone, roster] of this.otherPlayersByZone) {
      if (!otherPlayersByZone.has(zone)) roster.update(new Map());
    }
    for (const [zone, entries] of otherPlayersByZone) this.otherPlayersIn(zone).update(entries);
    this.allPlayers.update(allPlayers);
    this.onlinePlayers.update(onlinePlayers);
  }

  private otherPlayersIn(zone: string): VersionedRoster {
    let roster = this.otherPlayersByZone.get(zone);
    if (!roster) {
      roster = new VersionedRoster();
      this.otherPlayersByZone.set(zone, roster);
    }
    return roster;
  }
}
