import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findContentInfo, findContentProblems } from '../../game/ContentValidation.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

export async function validateDraft(
  deps: McpToolDeps,
  versionId: string,
): Promise<{ error?: string; problems?: string[]; info?: string[] }> {
  try {
    const version = deps.versionStore().get(versionId);
    if (!version) return { error: 'Version not found.' };
    if (version.status !== 'draft') return { error: 'Only drafts can be validated (this is a published/active version).' };

    const snapshot = await deps.versionStore().loadSnapshot(versionId);
    return { problems: findContentProblems(snapshot), info: findContentInfo(snapshot) };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerValidateTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'validate_draft',
    {
      description: "Run referential-integrity and range checks against a draft content version (broken references between monsters/items/quests/zones/tiles/etc, unknown monster skills, monster attackInterval/cooldown/castTime ranges, monster level (whole number 1-200)/tier/enrage ranges, dungeon checkpoints (descending fractions in (0,1)), maxWipes and checkpointRewardFraction ranges, checkpoint floors where no encounter on the table can field a non-passive boss/raid monster, invalid skill definitions). Returns `problems` (human-readable, empty if the draft is clean) and `info` (advisory, never blocking: monsters with no level set and therefore no level scaling, tier hints from HP, checkpoint-floor encounters that can come without a boss and so get no checkpoints, dungeon fields that have no effect).",
      inputSchema: {
        versionId: z.string(),
      },
    },
    async (args) => {
      const result = await validateDraft(deps, args.versionId);
      return toolResult(result);
    },
  );
}
