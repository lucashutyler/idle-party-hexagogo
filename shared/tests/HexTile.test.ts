import { describe, it, expect } from 'vitest';
import { HexTile, TileType, TILE_CONFIGS } from '../src/hex/HexTile';
import type { TileTypeDefinition } from '../src/hex/HexTile';
import { createCube } from '../src/hex/HexUtils';
import type { RoomEntryRequirements } from '../src/systems/RoomRequirements';

function makeTileType(overrides: Partial<TileTypeDefinition> = {}): TileTypeDefinition {
  return {
    id: 'forest',
    name: 'Forest',
    icon: '',
    color: '#3d8c40',
    traversable: true,
    ...overrides,
  };
}

function makeTile(options: {
  type?: string;
  requiredItemId?: string;
  tileTypeDef?: TileTypeDefinition;
  entryRequirements?: RoomEntryRequirements;
} = {}): HexTile {
  return new HexTile(
    createCube(0, 0),
    options.type ?? TileType.Forest,
    'friendly_forest',
    'tile_guid_1',
    options.requiredItemId,
    options.tileTypeDef,
    options.entryRequirements,
  );
}

describe('HexTile', () => {
  describe('entryRequirements — ungated', () => {
    it('returns undefined when the tile has no gate and no tile type', () => {
      const tile = makeTile();

      expect(tile.entryRequirements).toBeUndefined();
      expect(tile.requiredItemId).toBeUndefined();
    });

    it('returns undefined when the tile type exists but gates nothing', () => {
      const tile = makeTile({ tileTypeDef: makeTileType() });

      expect(tile.entryRequirements).toBeUndefined();
      expect(tile.requiredItemId).toBeUndefined();
    });
  });

  describe('entryRequirements — tile type default', () => {
    it('applies the tile type gate to a tile with no gate of its own', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { minLevel: 10, requiredItemId: 'lava_boots' },
      });
      const tile = makeTile({ tileTypeDef });

      expect(tile.entryRequirements).toEqual({ minLevel: 10, requiredItemId: 'lava_boots' });
      expect(tile.requiredItemId).toBe('lava_boots');
    });

    it('applies a quest gate from the tile type', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { requiredQuestIds: ['quest_gatekeeper'] },
      });
      const tile = makeTile({ tileTypeDef });

      expect(tile.entryRequirements).toEqual({ requiredQuestIds: ['quest_gatekeeper'] });
      expect(tile.requiredItemId).toBeUndefined();
    });
  });

  describe('entryRequirements — per-tile override merges field by field', () => {
    it('keeps the type gate field the tile does not set', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { requiredItemId: 'lava_boots' },
      });
      const tile = makeTile({ tileTypeDef, entryRequirements: { minLevel: 25 } });

      expect(tile.entryRequirements).toEqual({ minLevel: 25, requiredItemId: 'lava_boots' });
      expect(tile.requiredItemId).toBe('lava_boots');
    });

    it('per-tile requiredItemId wins over the tile type requiredItemId', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { requiredItemId: 'lava_boots', minLevel: 5 },
      });
      const tile = makeTile({ tileTypeDef, entryRequirements: { requiredItemId: 'obsidian_boots' } });

      expect(tile.entryRequirements).toEqual({ minLevel: 5, requiredItemId: 'obsidian_boots' });
      expect(tile.requiredItemId).toBe('obsidian_boots');
    });

    it('per-tile minLevel and requiredQuestIds win over the tile type values', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { minLevel: 5, requiredQuestIds: ['quest_type'] },
      });
      const tile = makeTile({
        tileTypeDef,
        entryRequirements: { minLevel: 30, requiredQuestIds: ['quest_tile'] },
      });

      expect(tile.entryRequirements).toEqual({ minLevel: 30, requiredQuestIds: ['quest_tile'] });
    });

    it('unions all three requirement kinds across type and tile', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { requiredQuestIds: ['quest_gatekeeper'] },
      });
      const tile = makeTile({
        tileTypeDef,
        entryRequirements: { minLevel: 12, requiredItemId: 'lava_boots' },
      });

      expect(tile.entryRequirements).toEqual({
        minLevel: 12,
        requiredItemId: 'lava_boots',
        requiredQuestIds: ['quest_gatekeeper'],
      });
    });
  });

  describe('entryRequirements — legacy requiredItemId', () => {
    it('folds the legacy per-tile constructor arg into the resolved gate', () => {
      const tile = makeTile({ requiredItemId: 'boat' });

      expect(tile.requiredItemId).toBe('boat');
      expect(tile.entryRequirements).toEqual({ requiredItemId: 'boat' });
    });

    it('folds the legacy tile type requiredItemId into the resolved gate', () => {
      const tileTypeDef = makeTileType({ requiredItemId: 'boat' });
      const tile = makeTile({ tileTypeDef });

      expect(tile.requiredItemId).toBe('boat');
      expect(tile.entryRequirements).toEqual({ requiredItemId: 'boat' });
    });

    it('per-tile entryRequirements.requiredItemId wins over the legacy per-tile arg', () => {
      const tile = makeTile({
        requiredItemId: 'boat',
        entryRequirements: { requiredItemId: 'airship' },
      });

      expect(tile.requiredItemId).toBe('airship');
    });

    it('legacy per-tile arg wins over the tile type legacy requiredItemId', () => {
      const tileTypeDef = makeTileType({ requiredItemId: 'boat' });
      const tile = makeTile({ tileTypeDef, requiredItemId: 'airship' });

      expect(tile.requiredItemId).toBe('airship');
      expect(tile.entryRequirements).toEqual({ requiredItemId: 'airship' });
    });

    it('merges the legacy tile type item gate with a per-tile level gate', () => {
      const tileTypeDef = makeTileType({ requiredItemId: 'boat' });
      const tile = makeTile({ tileTypeDef, entryRequirements: { minLevel: 8 } });

      expect(tile.entryRequirements).toEqual({ minLevel: 8, requiredItemId: 'boat' });
      expect(tile.requiredItemId).toBe('boat');
    });
  });

  describe('requiredItemId with non-item gates', () => {
    it('is undefined for a level-only gate', () => {
      const tile = makeTile({ entryRequirements: { minLevel: 20 } });

      expect(tile.entryRequirements).toEqual({ minLevel: 20 });
      expect(tile.requiredItemId).toBeUndefined();
    });

    it('is undefined for a quest-only gate', () => {
      const tile = makeTile({ entryRequirements: { requiredQuestIds: ['quest_gatekeeper'] } });

      expect(tile.entryRequirements).toEqual({ requiredQuestIds: ['quest_gatekeeper'] });
      expect(tile.requiredItemId).toBeUndefined();
    });

    it('is undefined when the tile type gates only on level and quest', () => {
      const tileTypeDef = makeTileType({
        entryRequirements: { minLevel: 20, requiredQuestIds: ['quest_gatekeeper'] },
      });
      const tile = makeTile({ tileTypeDef, entryRequirements: { minLevel: 25 } });

      expect(tile.requiredItemId).toBeUndefined();
    });

    it('ignores an empty requiredQuestIds array', () => {
      const tile = makeTile({ entryRequirements: { requiredQuestIds: [] } });

      expect(tile.entryRequirements).toBeUndefined();
      expect(tile.requiredItemId).toBeUndefined();
    });
  });

  describe('isTraversable and color are unaffected by the gate', () => {
    it('falls back to TILE_CONFIGS when there is no tile type definition', () => {
      const gated = makeTile({
        type: TileType.Mountain,
        entryRequirements: { minLevel: 40, requiredItemId: 'climbing_gear' },
      });

      expect(gated.isTraversable).toBe(TILE_CONFIGS[TileType.Mountain].traversable);
      expect(gated.color).toBe(TILE_CONFIGS[TileType.Mountain].color);
    });

    it('uses the tile type definition regardless of the gate', () => {
      const tileTypeDef = makeTileType({
        traversable: false,
        color: '#123456',
        entryRequirements: { minLevel: 40 },
      });
      const tile = makeTile({ tileTypeDef, entryRequirements: { requiredItemId: 'lava_boots' } });

      expect(tile.isTraversable).toBe(false);
      expect(tile.color).toBe(0x123456);
    });
  });

  describe('identity', () => {
    it('keeps id, key, zone and pixel position independent of the gate', () => {
      const tile = makeTile({ entryRequirements: { minLevel: 3 } });

      expect(tile.id).toBe('tile_guid_1');
      expect(tile.zone).toBe('friendly_forest');
      expect(tile.key).toBe('0,0,0');
      expect(tile.pixelPosition).toEqual(new HexTile(createCube(0, 0), TileType.Forest).pixelPosition);
    });

    it('falls back to the cube key as id when none is supplied', () => {
      const tile = new HexTile(createCube(1, -1), TileType.Plains);

      expect(tile.id).toBe(tile.key);
    });
  });
});
