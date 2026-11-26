import { describe, it, expect } from 'vitest';
import type { EncounterDefinition, MonsterDefinition, ZoneDefinition } from '@idle-party-rpg/shared';
import { roomLevelBands } from '../src/game/RoomLevels.js';
import { recapContent, recapSession, room } from './recapFixture.js';

function monster(id: string, extra: Partial<MonsterDefinition> = {}): MonsterDefinition {
  return { id, name: id, hp: 10, damage: 2, damageType: 'physical', xp: 1, goldMin: 0, goldMax: 0, ...extra };
}

const MONSTERS: Record<string, MonsterDefinition> = {
  rat: monster('rat', { level: 2 }),
  boar: monster('boar', { level: 5 }),
  drake: monster('drake', { level: 9 }),
  ghost: monster('ghost', { damage: 40 }),
  wall: monster('wall', { level: 30, passive: true }),
  ogre: monster('ogre', { level: 14 }),
};

const ENCOUNTERS: Record<string, EncounterDefinition> = {
  rats: { id: 'rats', name: 'Rats', type: 'random', monsterPool: [{ monsterId: 'rat', min: 1, max: 3 }, { monsterId: 'ogre', min: 0, max: 0 }] },
  boars: { id: 'boars', name: 'Boars', type: 'explicit', placements: [{ monsterId: 'boar', gridPosition: 4 }, { monsterId: 'wall', gridPosition: 1 }] },
  drakes: { id: 'drakes', name: 'Drakes', type: 'random', monsterPool: [{ monsterId: 'drake', min: 1, max: 1 }] },
  ghosts: { id: 'ghosts', name: 'Ghosts', type: 'random', monsterPool: [{ monsterId: 'ghost', min: 1, max: 2 }] },
  ogres: { id: 'ogres', name: 'Ogres', type: 'random', monsterPool: [{ monsterId: 'ogre', min: 1, max: 1 }] },
};

const ZONES: Record<string, ZoneDefinition> = {
  meadow: {
    id: 'meadow', displayName: 'Meadow', levelRange: [1, 1],
    encounterTable: [{ encounterId: 'rats', weight: 3 }, { encounterId: 'boars', weight: 1 }, { encounterId: 'ogres', weight: 0 }],
  },
  haunt: { id: 'haunt', displayName: 'Haunt', levelRange: [1, 1], encounterTable: [{ encounterId: 'ghosts', weight: 1 }] },
  empty: { id: 'empty', displayName: 'Empty', levelRange: [1, 1], encounterTable: [] },
};

function content() {
  return recapContent({
    tiles: [
      room('start', 0, 0),
      room('lair', 1, 0, { encounterTable: [{ encounterId: 'drakes', weight: 1 }, { encounterId: 'rats', weight: 1 }] }),
      room('crypt', 2, 0, { zone: 'haunt', encounterTable: [{ encounterId: 'ghosts', weight: 1 }] }),
      room('hall', 3, 0, { zone: 'haunt' }),
    ],
    monsters: MONSTERS,
    encounters: ENCOUNTERS,
    zones: ZONES,
  });
}

describe('roomLevelBands', () => {
  it('spans the authored levels a zone\'s table can roll, from pools and placements', () => {
    expect(roomLevelBands(content()).zones).toEqual({ meadow: [2, 5] });
  });

  it('gives a room with its own table its own band', () => {
    const bands = roomLevelBands(content());
    expect(bands.rooms.get('lair')).toEqual([2, 9]);
    expect(bands.rooms.has('start')).toBe(false);
  });

  it('ignores estimated levels, walls, empty pool slots and unweighted encounters, leaving such tables out', () => {
    const bands = roomLevelBands(content());
    expect(bands.zones.haunt).toBeUndefined();
    expect(bands.zones.empty).toBeUndefined();
    expect(bands.rooms.has('crypt')).toBe(false);
  });

  it('is rebuilt when content changes', () => {
    const c = content();
    const first = roomLevelBands(c);
    expect(roomLevelBands(c)).toBe(first);
    MONSTERS.boar.level = 7;
    c.contentEpoch++;
    try {
      expect(roomLevelBands(c).zones.meadow).toEqual([2, 7]);
    } finally {
      MONSTERS.boar.level = 5;
    }
  });
});

describe('world data levels', () => {
  it('sends zone bands and own-table room bands without writing them into stored content', () => {
    const c = content();
    const { session } = recapSession(c);
    const data = session.getWorldData();

    expect(data.zoneLevels).toEqual({ meadow: [2, 5] });
    expect(data.tiles.find(t => t.id === 'lair')!.levels).toEqual([2, 9]);
    expect(data.tiles.find(t => t.id === 'start')!.levels).toBeUndefined();
    expect(JSON.parse(JSON.stringify(data)).tiles.find((t: { id: string }) => t.id === 'start')).not.toHaveProperty('levels');
    expect(c.getWorld().tiles.some(t => 'levels' in t || 'zoneName' in t)).toBe(false);
  });
});
