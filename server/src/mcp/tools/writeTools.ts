import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ALL_CLASS_NAMES, DEFAULT_MAP_ID } from '@idle-party-rpg/shared';
import type { ClassName, SkillSlot, SkillSlotType, WorldTileDefinition, MapTransitionLink, RoomEntryRequirements } from '@idle-party-rpg/shared';
import type { McpToolDeps } from './McpToolDeps.js';
import { DRAFT_CONTENT_TYPES } from '../../game/DraftEditor.js';
import type { DraftContentType } from '../../game/DraftEditor.js';
import { toolResult, errorMessage } from './mcpResult.js';

const DRAFT_CONTENT_TYPE_ENUM = z.enum(DRAFT_CONTENT_TYPES);

/**
 * A room / transition entry gate. Every party member must satisfy every field
 * set here; unset fields fall back to the tile type's gate.
 */
const ROOM_REQUIREMENTS_SCHEMA = z.object({
  minLevel: z.number().int().min(1).optional()
    .describe('Minimum character level every party member must have.'),
  requiredItemId: z.string().optional()
    .describe('Item every party member must have equipped.'),
  requiredQuestIds: z.array(z.string()).optional()
    .describe('Quests every party member must have completed (turned in).'),
});

const TILE_INPUT_SHAPE = {
  mapId: z.string().optional(),
  col: z.number(),
  row: z.number(),
  type: z.string(),
  zone: z.string(),
  name: z.string(),
  encounterTable: z.array(z.object({ encounterId: z.string(), weight: z.number() })).optional(),
  shopId: z.string().optional(),
  npcId: z.string().optional(),
  dungeonId: z.string().optional(),
  requiredItemId: z.string().optional()
    .describe('Legacy item gate. Prefer entryRequirements.requiredItemId — both are honoured.'),
  entryRequirements: ROOM_REQUIREMENTS_SCHEMA.optional()
    .describe('Gate on entering this room. Overrides the tile type gate field by field.'),
  transitions: z.array(z.object({
    mapId: z.string(),
    tileId: z.string(),
    entryRequirements: ROOM_REQUIREMENTS_SCHEMA.optional()
      .describe('Gate on taking this exit, applied on top of the destination room gate.'),
  })).optional(),
};

export async function upsertContent(deps: McpToolDeps, type: DraftContentType, versionId: string, entry: Record<string, unknown>) {
  try {
    const result = await deps.draftEditor.upsertContent(type, versionId, entry);
    if (!result.success) return { error: result.error };
    return { success: true, type, upserted: [entry.id], totalOfType: result.entries.length };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function upsertContentBulk(deps: McpToolDeps, type: DraftContentType, versionId: string, entries: Record<string, unknown>[]) {
  try {
    const result = await deps.draftEditor.upsertContentBulk(type, versionId, entries);
    if (!result.success) return { error: result.error };
    return { success: true, type, upserted: entries.map(e => e.id), totalOfType: result.entries.length };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function deleteContent(deps: McpToolDeps, type: DraftContentType, versionId: string, id: string) {
  try {
    const result = await deps.draftEditor.deleteContent(type, versionId, id);
    if (!result.success) return { error: result.error };
    return { success: true, type, deleted: id, totalOfType: result.entries.length };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

interface UpsertTileInput {
  mapId?: string;
  col: number;
  row: number;
  type: string;
  zone: string;
  name: string;
  encounterTable?: { encounterId: string; weight: number }[];
  shopId?: string;
  npcId?: string;
  dungeonId?: string;
  requiredItemId?: string;
  entryRequirements?: RoomEntryRequirements;
  transitions?: MapTransitionLink[];
}

interface ClearedRoomFields {
  mapId: string;
  col: number;
  row: number;
  /** Field name → the value it held before this upsert overwrote the room. */
  cleared: Record<string, unknown>;
}

const SERVER_OWNED_TILE_FIELDS = new Set(['id', 'zoneName']);

function tileKey(tile: { mapId: string; col: number; row: number }): string {
  return `${tile.mapId}:${tile.col}:${tile.row}`;
}

/** Fields an existing room had that the upsert's input omitted — the upsert replaces the whole room, so these are now gone. */
function findClearedFields(before: WorldTileDefinition[], inputs: Omit<WorldTileDefinition, 'id'>[]): ClearedRoomFields[] {
  const priorByKey = new Map(before.map(tile => [tileKey(tile), tile]));
  const cleared: ClearedRoomFields[] = [];
  for (const input of inputs) {
    const prior = priorByKey.get(tileKey(input)) as Record<string, unknown> | undefined;
    if (!prior) continue;
    const fields: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(prior)) {
      if (SERVER_OWNED_TILE_FIELDS.has(field) || value === undefined) continue;
      if ((input as Record<string, unknown>)[field] === undefined) fields[field] = value;
    }
    if (Object.keys(fields).length > 0) cleared.push({ mapId: input.mapId, col: input.col, row: input.row, cleared: fields });
  }
  return cleared;
}

export async function upsertTiles(deps: McpToolDeps, versionId: string, tiles: UpsertTileInput[]) {
  try {
    const withMapIds: Omit<WorldTileDefinition, 'id'>[] = tiles.map(tile => ({ ...tile, mapId: tile.mapId ?? DEFAULT_MAP_ID }));
    const before = deps.versionStore().get(versionId) ? (await deps.versionStore().loadSnapshot(versionId)).world.tiles : [];
    const result = await deps.draftEditor.upsertTilesBulk(versionId, withMapIds);
    if (!result.success) return { error: result.error };
    const byKey = new Map(result.world.tiles.map(tile => [tileKey(tile), tile.id]));
    const rooms = withMapIds.map(input => ({ id: byKey.get(tileKey(input)), mapId: input.mapId, col: input.col, row: input.row }));
    const clearedFields = findClearedFields(before, withMapIds);
    if (clearedFields.length === 0) return { success: true, rooms };
    return {
      success: true,
      rooms,
      warning: `Upsert replaces the whole room: ${clearedFields.length} existing room(s) lost fields the input omitted. clearedFields lists the old values — re-upsert with them included if that was unintended.`,
      clearedFields,
    };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

interface DeleteTileInput {
  mapId?: string;
  col: number;
  row: number;
}

export async function deleteTiles(deps: McpToolDeps, versionId: string, tiles: DeleteTileInput[]) {
  try {
    const refs = tiles.map(tile => ({ mapId: tile.mapId ?? DEFAULT_MAP_ID, col: tile.col, row: tile.row }));
    const result = await deps.draftEditor.deleteTilesBulk(versionId, refs);
    if (!result.success) return { error: result.error };
    return { success: true, deleted: refs };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function createMap(deps: McpToolDeps, versionId: string, id: string, name: string, startTile?: { col: number; row: number }) {
  try {
    const result = await deps.draftEditor.upsertMap(versionId, { id, name, startTile: startTile ?? { col: 0, row: 0 } });
    if (!result.success) return { error: result.error };
    return { success: true, map: result.world.maps.find(m => m.id === id) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function deleteMap(deps: McpToolDeps, versionId: string, mapId: string) {
  try {
    const result = await deps.draftEditor.deleteMap(versionId, mapId);
    if (!result.success) return { error: result.error };
    return { success: true, deleted: mapId };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function setStartTile(deps: McpToolDeps, versionId: string, mapId: string | undefined, col: number, row: number) {
  try {
    const result = await deps.draftEditor.setStartTile(versionId, mapId, col, row);
    if (!result.success) return { error: result.error };
    return { success: true, mapId: mapId || result.world.defaultMapId, startTile: { col, row } };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

interface SetSkillSlotsInput {
  type: SkillSlotType;
  unlocksAtLevel: number;
}

export async function setSkillSlots(deps: McpToolDeps, versionId: string, className: string, slots: SetSkillSlotsInput[]) {
  try {
    if (!ALL_CLASS_NAMES.includes(className as ClassName)) {
      return { error: `Invalid class. Valid classes: ${ALL_CLASS_NAMES.join(', ')}` };
    }
    const schedule: SkillSlot[] = slots.map(s => ({ type: s.type, unlocksAtLevel: s.unlocksAtLevel }));
    const result = await deps.draftEditor.setSkillSlotSchedule(versionId, className, schedule);
    if (!result.success) return { error: result.error };
    return { success: true, className, slots: schedule };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerWriteTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'upsert_content',
    {
      description: 'Create or update one entry of a content type in a draft version.',
      inputSchema: {
        type: DRAFT_CONTENT_TYPE_ENUM,
        versionId: z.string(),
        entry: z.record(z.string(), z.unknown()),
      },
    },
    async (args) => {
      const result = await upsertContent(deps, args.type as DraftContentType, args.versionId, args.entry as Record<string, unknown>);
      return toolResult(result);
    },
  );

  server.registerTool(
    'upsert_content_bulk',
    {
      description: 'Create or update several entries of a content type in a draft version, in order.',
      inputSchema: {
        type: DRAFT_CONTENT_TYPE_ENUM,
        versionId: z.string(),
        entries: z.array(z.record(z.string(), z.unknown())),
      },
    },
    async (args) => {
      const result = await upsertContentBulk(deps, args.type as DraftContentType, args.versionId, args.entries as Record<string, unknown>[]);
      return toolResult(result);
    },
  );

  server.registerTool(
    'delete_content',
    {
      description: 'Delete one entry of a content type from a draft version by id.',
      inputSchema: {
        type: DRAFT_CONTENT_TYPE_ENUM,
        versionId: z.string(),
        id: z.string(),
      },
    },
    async (args) => {
      const result = await deleteContent(deps, args.type as DraftContentType, args.versionId, args.id);
      return toolResult(result);
    },
  );

  server.registerTool(
    'upsert_tiles',
    {
      description: 'Create or update one or more world rooms (tiles) in a draft version, in order. mapId defaults to the overworld map when omitted. Updating an existing room REPLACES it — any optional field you omit (shopId, npcId, transitions, entryRequirements, ...) is cleared; the result reports those as clearedFields with their old values. Rooms and individual transitions can carry entryRequirements — every party member must satisfy every requirement to enter.',
      inputSchema: {
        versionId: z.string(),
        tiles: z.array(z.object(TILE_INPUT_SHAPE)),
      },
    },
    async (args) => {
      const result = await upsertTiles(deps, args.versionId, args.tiles as UpsertTileInput[]);
      return toolResult(result);
    },
  );

  server.registerTool(
    'delete_tiles',
    {
      description: 'Delete one or more world rooms (tiles) from a draft version by map/col/row, in order. mapId defaults to the overworld map when omitted.',
      inputSchema: {
        versionId: z.string(),
        tiles: z.array(z.object({
          mapId: z.string().optional(),
          col: z.number(),
          row: z.number(),
        })),
      },
    },
    async (args) => {
      const result = await deleteTiles(deps, args.versionId, args.tiles as DeleteTileInput[]);
      return toolResult(result);
    },
  );

  server.registerTool(
    'create_map',
    {
      description: 'Create a new world map in a draft version.',
      inputSchema: {
        versionId: z.string(),
        id: z.string(),
        name: z.string(),
        startTile: z.object({ col: z.number(), row: z.number() }).optional(),
      },
    },
    async (args) => {
      const result = await createMap(deps, args.versionId, args.id, args.name, args.startTile);
      return toolResult(result);
    },
  );

  server.registerTool(
    'delete_map',
    {
      description: 'Delete a world map from a draft version. Fails if it is the default map or still has rooms/inbound transitions.',
      inputSchema: {
        versionId: z.string(),
        mapId: z.string(),
      },
    },
    async (args) => {
      const result = await deleteMap(deps, args.versionId, args.mapId);
      return toolResult(result);
    },
  );

  server.registerTool(
    'set_start_tile',
    {
      description: 'Set the start room (col/row) for a map in a draft version. mapId defaults to the draft\'s default map when omitted.',
      inputSchema: {
        versionId: z.string(),
        mapId: z.string().optional(),
        col: z.number(),
        row: z.number(),
      },
    },
    async (args) => {
      const result = await setStartTile(deps, args.versionId, args.mapId, args.col, args.row);
      return toolResult(result);
    },
  );

  server.registerTool(
    'set_skill_slots',
    {
      description: 'Set the full skill-slot unlock schedule for a class in a draft version.',
      inputSchema: {
        versionId: z.string(),
        className: z.string(),
        slots: z.array(z.object({
          type: z.enum(['passive', 'active']),
          unlocksAtLevel: z.number().int().min(1).max(100),
        })).min(1),
      },
    },
    async (args) => {
      const result = await setSkillSlots(deps, args.versionId, args.className, args.slots as SetSkillSlotsInput[]);
      return toolResult(result);
    },
  );
}
