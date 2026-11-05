import { describe, expect, it } from 'vitest';
import { restoreElidedState } from '@idle-party-rpg/shared';
import type { RosterChanges, ServerStateMessage } from '@idle-party-rpg/shared';
import { ROSTER_REFRESH_MS, SharedRosters, VersionedRoster } from '../src/game/SharedRosters.js';
import type { RosterEntries, RosterSnapshot } from '../src/game/SharedRosters.js';

function entries(...names: string[]): RosterEntries {
  return new Map(names.map(name => [name, JSON.stringify({ username: name })]));
}

describe('VersionedRoster', () => {
  it('starts empty', () => {
    const roster = new VersionedRoster();
    expect(roster.version).toBe(0);
    expect(JSON.parse(roster.whole())).toEqual([]);
  });

  it('holds its version when nothing changed', () => {
    const roster = new VersionedRoster();
    roster.update(entries('a', 'b'));
    const version = roster.version;

    roster.update(entries('a', 'b'));

    expect(roster.version).toBe(version);
    expect(roster.changesSince(version)).toBe('{}');
  });

  it('reports additions, changes and removals since a version', () => {
    const roster = new VersionedRoster();
    roster.update(entries('a', 'b', 'c', 'd', 'e', 'f'));
    const version = roster.version;

    const next = entries('a', 'b', 'c', 'd', 'e', 'new');
    next.set('b', JSON.stringify({ username: 'b', col: 9 }));
    next.delete('f');
    roster.update(next);

    const changes = JSON.parse(roster.changesSince(version)!);
    expect(changes.upserts).toEqual(expect.arrayContaining([{ username: 'b', col: 9 }, { username: 'new' }]));
    expect(changes.upserts).toHaveLength(2);
    expect(changes.removes).toEqual(['f']);
  });

  it('reports an entry once however many times it changed', () => {
    const roster = new VersionedRoster();
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    roster.update(entries(...names));
    const version = roster.version;

    for (let col = 0; col < 3; col++) {
      const next = entries(...names);
      next.set('p0', JSON.stringify({ username: 'p0', col }));
      roster.update(next);
    }

    expect(JSON.parse(roster.changesSince(version)!).upserts).toEqual([{ username: 'p0', col: 2 }]);
  });

  it('asks for a whole copy when most of the roster changed', () => {
    const roster = new VersionedRoster();
    roster.update(entries('a', 'b', 'c'));
    const version = roster.version;

    roster.update(entries('x', 'y', 'z'));

    expect(roster.changesSince(version)).toBeNull();
    expect(JSON.parse(roster.whole())).toEqual([{ username: 'x' }, { username: 'y' }, { username: 'z' }]);
  });

  it('asks for a whole copy from a version it has forgotten, and keeps its log bounded', () => {
    const roster = new VersionedRoster();
    const names = Array.from({ length: 10 }, (_, i) => `p${i}`);
    roster.update(entries(...names));
    const oldVersion = roster.version;

    let recentVersion = 0;
    for (let col = 0; col < 1000; col++) {
      if (col === 999) recentVersion = roster.version;
      const next = entries(...names);
      next.set('p0', JSON.stringify({ username: 'p0', col }));
      roster.update(next);
    }

    expect(roster.changesSince(oldVersion)).toBeNull();
    expect(JSON.parse(roster.changesSince(recentVersion)!).upserts).toEqual([{ username: 'p0', col: 999 }]);
    expect((roster as unknown as { log: unknown[] }).log.length).toBeLessThanOrEqual(256);
  });
});

function worldOf(overrides: Partial<RosterSnapshot> = {}): RosterSnapshot {
  return { otherPlayersByZone: new Map(), allPlayers: new Map(), onlinePlayers: new Map(), ...overrides };
}

function parse(json: string): RosterChanges {
  return JSON.parse(json);
}

describe('SharedRosters', () => {
  function harness(initial: RosterSnapshot) {
    const clock = { now: 0, builds: 0, world: initial };
    const rosters = new SharedRosters(() => {
      clock.builds++;
      return clock.world;
    }, () => clock.now);
    return { clock, rosters };
  }

  it('gives a new socket whole copies', () => {
    const { rosters } = harness(worldOf({
      otherPlayersByZone: new Map([['field', entries('alice', 'bob')]]),
      allPlayers: entries('alice', 'bob'),
      onlinePlayers: new Map([['alice', '"alice"']]),
    }));

    expect(parse(rosters.encodeFor({}, 'field'))).toEqual({
      otherPlayers: { whole: [{ username: 'alice' }, { username: 'bob' }] },
      allPlayers: { whole: [{ username: 'alice' }, { username: 'bob' }] },
      onlinePlayers: { whole: ['alice'] },
    });
  });

  it('sends nothing to a socket that is up to date', () => {
    const { clock, rosters } = harness(worldOf({ allPlayers: entries('alice') }));
    const socket = {};
    rosters.encodeFor(socket, 'field');

    clock.now += ROSTER_REFRESH_MS;

    expect(rosters.encodeFor(socket, 'field')).toBe('{}');
  });

  it('sends only what changed, to each socket from where it stands', () => {
    const names = ['a', 'b', 'c', 'd', 'e', 'f'];
    const { clock, rosters } = harness(worldOf({ allPlayers: entries(...names) }));
    const early = {};
    const late = {};
    rosters.encodeFor(early, 'field');
    rosters.encodeFor(late, 'field');

    clock.world = worldOf({ allPlayers: entries(...names, 'g') });
    clock.now += ROSTER_REFRESH_MS;
    expect(parse(rosters.encodeFor(early, 'field')).allPlayers).toEqual({ upserts: [{ username: 'g' }] });

    clock.world = worldOf({ allPlayers: entries(...names, 'g', 'h') });
    clock.now += ROSTER_REFRESH_MS;
    expect(parse(rosters.encodeFor(early, 'field')).allPlayers).toEqual({ upserts: [{ username: 'h' }] });
    expect(parse(rosters.encodeFor(late, 'field')).allPlayers?.upserts).toEqual(
      expect.arrayContaining([{ username: 'g' }, { username: 'h' }]),
    );
  });

  it('sends a whole copy when a socket moves to another zone', () => {
    const { clock, rosters } = harness(worldOf({
      otherPlayersByZone: new Map([['field', entries('alice')], ['cave', entries('bob')]]),
    }));
    const socket = {};
    rosters.encodeFor(socket, 'field');

    clock.now += ROSTER_REFRESH_MS;

    expect(parse(rosters.encodeFor(socket, 'cave')).otherPlayers).toEqual({ whole: [{ username: 'bob' }] });
  });

  it('empties a zone everyone has left', () => {
    const names = ['a', 'b', 'c', 'd'];
    const { clock, rosters } = harness(worldOf({ otherPlayersByZone: new Map([['field', entries(...names)]]) }));
    const socket = {};
    rosters.encodeFor(socket, 'field');

    clock.world = worldOf();
    clock.now += ROSTER_REFRESH_MS;

    expect(parse(rosters.encodeFor(socket, 'field')).otherPlayers).toEqual({ whole: [] });
  });

  it('builds at most once per refresh interval, however many sockets ask', () => {
    const { clock, rosters } = harness(worldOf());
    for (let i = 0; i < 50; i++) rosters.encodeFor({}, 'field');
    expect(clock.builds).toBe(1);

    clock.now += ROSTER_REFRESH_MS - 1;
    rosters.encodeFor({}, 'field');
    expect(clock.builds).toBe(1);

    clock.now += 1;
    rosters.encodeFor({}, 'field');
    expect(clock.builds).toBe(2);
  });

  it('builds again right away after being invalidated', () => {
    const { clock, rosters } = harness(worldOf());
    rosters.encodeFor({}, 'field');

    rosters.invalidate();
    rosters.encodeFor({}, 'field');

    expect(clock.builds).toBe(2);
  });

  it('always rebuilds the exact rosters on the client, whatever the sequence of changes', () => {
    let seed = 98765;
    const random = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const zones = ['field', 'cave', 'coast'];
    const names = Array.from({ length: 40 }, (_, i) => `p${i}`);
    const players = new Map(names.map(name => [name, { username: name, zone: zones[random(3)], col: 0, here: true }]));

    const snapshot = (): RosterSnapshot => {
      const otherPlayersByZone = new Map<string, RosterEntries>();
      const present = [...players.values()].filter(player => player.here);
      for (const player of present) {
        if (!otherPlayersByZone.has(player.zone)) otherPlayersByZone.set(player.zone, new Map());
        otherPlayersByZone.get(player.zone)!.set(player.username, JSON.stringify(player));
      }
      return {
        otherPlayersByZone,
        allPlayers: new Map(present.map(player => [player.username, JSON.stringify({ username: player.username })])),
        onlinePlayers: new Map(present.map(player => [player.username, JSON.stringify(player.username)])),
      };
    };

    const clock = { now: 0 };
    const rosters = new SharedRosters(snapshot, () => clock.now);
    const viewers = ['p0', 'p1', 'p2'].map(username => ({
      username,
      socket: {},
      held: null as ServerStateMessage | null,
    }));

    for (let step = 0; step < 1000; step++) {
      for (let moves = random(4); moves > 0; moves--) {
        const player = players.get(names[random(names.length)])!;
        const action = random(6);
        if (action === 0) player.here = !player.here;
        else if (action === 1) player.zone = zones[random(3)];
        else player.col = random(50);
      }
      clock.now += ROSTER_REFRESH_MS;

      for (const viewer of viewers) {
        // A socket that is behind skips pushes, and catches up on a later one.
        if (random(3) === 0) continue;
        const me = players.get(viewer.username)!;
        const received = {
          username: viewer.username,
          otherPlayers: [],
          social: { allPlayers: [], onlinePlayers: [] },
          rosters: JSON.parse(rosters.encodeFor(viewer.socket, me.zone)),
        } as unknown as ServerStateMessage;
        restoreElidedState(received, viewer.held);
        viewer.held = received;

        const bySortedName = (a: { username: string }, b: { username: string }) => a.username.localeCompare(b.username);
        const present = [...players.values()].filter(player => player.here);
        expect([...received.otherPlayers].sort(bySortedName)).toEqual(
          present.filter(player => player.zone === me.zone && player.username !== viewer.username).sort(bySortedName),
        );
        expect(received.social!.allPlayers.map(player => player.username).sort()).toEqual(present.map(player => player.username).sort());
        expect([...received.social!.onlinePlayers].sort()).toEqual(present.map(player => player.username).sort());
        expect(received.rosters).toBeUndefined();
      }
    }
  });
});
