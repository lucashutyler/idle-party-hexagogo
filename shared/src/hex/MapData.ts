import { HexGrid } from './HexGrid';
import { WORLD_MAP, MapSchema } from './MapSchema';

/**
 * Generate the world map from the schema.
 */
export function generateWorldMap(schema: MapSchema = WORLD_MAP): HexGrid {
  return HexGrid.fromSchema(schema);
}

/**
 * Get the starting position for the party.
 */
export function getStartingPosition(schema: MapSchema = WORLD_MAP): { col: number; row: number } {
  return schema.startPosition;
}
