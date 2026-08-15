import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { MANAGED_ASSET_KINDS } from '@idle-party-rpg/shared';
import type { ManagedAssetKind } from '@idle-party-rpg/shared';
import { computeAssetCoverage } from '../../game/AssetCoverage.js';
import { describeAssetKinds } from '../../admin/assetRoutes.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

/**
 * Imagery tools — the MCP half of the `/api/admin/assets` surface.
 *
 * Unlike the content tools, these write to **live** art rather than to a draft
 * version. Artwork sits outside `ContentSnapshot` by design (binary blobs would
 * balloon every version snapshot, and publish/rollback has never moved a PNG),
 * so there is no draft to stage an upload into. `get_asset_coverage` is the
 * companion that makes this safe to drive: it says exactly which content is
 * still missing art before anything gets uploaded.
 */

const ASSET_KIND_ENUM = z.enum(MANAGED_ASSET_KINDS);
const ASSET_ID_SCHEMA = z.string();

/** Base64 payload, tolerating the whitespace an encoder may have wrapped it with. */
const BASE64_PATTERN = /^[A-Za-z0-9+/\s]*={0,2}$/;

export async function listAssetKinds() {
  try {
    return describeAssetKinds();
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function getAssetCoverage(
  deps: McpToolDeps,
  args: { kind?: ManagedAssetKind; includeEntries?: boolean; missingOnly?: boolean; limit?: number }
) {
  try {
    return await computeAssetCoverage(deps.contentStore(), deps.assetStore, {
      kind: args.kind,
      includeEntries: args.includeEntries ?? false,
      missingOnly: args.missingOnly ?? false,
      entryLimit: args.limit,
    });
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function listAssets(deps: McpToolDeps, args: { kind: ManagedAssetKind }) {
  try {
    const assets = await deps.assetStore.list(args.kind);
    return { kind: args.kind, count: assets.length, assets };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function upsertAsset(deps: McpToolDeps, args: { kind: ManagedAssetKind; id: string; pngBase64: string }) {
  try {
    // Node's base64 decoder is lenient — it drops invalid characters instead of
    // throwing, so a caller that passes a data URI or raw binary gets silently
    // mangled bytes rather than a useful error. Reject the obvious cases first;
    // the PNG signature check in the store catches everything else.
    if (!BASE64_PATTERN.test(args.pngBase64)) {
      return { error: 'pngBase64 is not valid base64 — pass the raw encoded bytes, without a data: URI prefix.' };
    }
    const png = Buffer.from(args.pngBase64, 'base64');
    if (png.length === 0) return { error: 'pngBase64 decoded to zero bytes — check the encoding.' };
    const asset = await deps.assetStore.write(args.kind, args.id, png);
    return { success: true, asset, uploadedBy: deps.tokenLabel };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export async function deleteAsset(deps: McpToolDeps, args: { kind: ManagedAssetKind; id: string }) {
  try {
    const removed = await deps.assetStore.remove(args.kind, args.id);
    return { success: true, removed };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerAssetTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'list_asset_kinds',
    {
      description: 'List every kind of imagery these tools manage (monsters, items, rooms, room backdrops, map parchment, class portraits, the splash logo, icon sets, …) with its URL template, id format, shape requirement, and fallback chain. Also returns a `deferred` list of kinds that exist in the game but are not exposed here yet, with the reason for each.',
      inputSchema: {},
    },
    async () => {
      const result = await listAssetKinds();
      return toolResult(result);
    }
  );

  server.registerTool(
    'get_asset_coverage',
    {
      description: 'Report which content is missing artwork, broken down by asset kind. Counts required ids, how many have art of their own, how many still render real art through a fallback (rooms fall back to room-type art, combat backdrops to zone art), plus orphaned files left by deleted content. Use this to find art gaps before authoring.',
      inputSchema: {
        kind: ASSET_KIND_ENUM.optional().describe('Restrict the report to a single asset kind.'),
        includeEntries: z.boolean().optional().describe('Include the per-id detail list, not just per-kind counts.'),
        missingOnly: z.boolean().optional().describe('With includeEntries, list only ids that have no artwork of their own.'),
        limit: z.number().optional().describe('Cap on entries returned per kind (default 500).'),
      },
    },
    async (args) => {
      const result = await getAssetCoverage(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'list_assets',
    {
      description: 'List the artwork currently stored for one asset kind, with each file\'s public URL, byte size, and pixel dimensions.',
      inputSchema: {
        kind: ASSET_KIND_ENUM.describe('Which asset kind to list.'),
      },
    },
    async (args) => {
      const result = await listAssets(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'upsert_asset',
    {
      description: 'Upload or replace one PNG. Writes to live artwork immediately — artwork is not part of draft versions, so this does not need and does not accept a versionId. Most kinds require a square image; call list_asset_kinds for the per-kind shape rule and id format.',
      inputSchema: {
        kind: ASSET_KIND_ENUM.describe('Which asset kind the image belongs to.'),
        id: ASSET_ID_SCHEMA.describe('Entity id the artwork is keyed by — see list_asset_kinds for the format of each kind.'),
        pngBase64: z.string().describe('The PNG file, base64-encoded. Max 512 KB decoded.'),
      },
    },
    async (args) => {
      const result = await upsertAsset(deps, args);
      return toolResult(result);
    }
  );

  server.registerTool(
    'delete_asset',
    {
      description: 'Delete stored artwork for one id. Succeeds whether or not the file existed; `removed` reports which. Deleting art the game still expects makes it fall back to a placeholder.',
      inputSchema: {
        kind: ASSET_KIND_ENUM.describe('Which asset kind to delete from.'),
        id: ASSET_ID_SCHEMA.describe('Entity id whose artwork should be removed.'),
      },
    },
    async (args) => {
      const result = await deleteAsset(deps, args);
      return toolResult(result);
    }
  );
}
