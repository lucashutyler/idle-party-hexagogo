import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { findContentProblems } from '../../game/ContentValidation.js';
import type { McpToolDeps } from './McpToolDeps.js';
import { toolResult, errorMessage } from './mcpResult.js';

export async function validateDraft(deps: McpToolDeps, versionId: string): Promise<{ error?: string; problems?: string[] }> {
  try {
    const version = deps.versionStore().get(versionId);
    if (!version) return { error: 'Version not found.' };
    if (version.status !== 'draft') return { error: 'Only drafts can be validated (this is a published/active version).' };

    const snapshot = await deps.versionStore().loadSnapshot(versionId);
    const problems = findContentProblems(snapshot);
    return { problems };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

export function registerValidateTools(server: McpServer, deps: McpToolDeps): void {
  server.registerTool(
    'validate_draft',
    {
      description: 'Run referential-integrity checks against a draft content version (broken references between monsters/items/quests/zones/tiles/etc). Returns a list of human-readable problems, empty if the draft is clean.',
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
