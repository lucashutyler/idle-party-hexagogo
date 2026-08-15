import type { ContentStore } from '../../game/ContentStore.js';
import type { VersionStore } from '../../game/VersionStore.js';
import type { DraftEditor } from '../../game/DraftEditor.js';
import type { AssetStore } from '../../game/AssetStore.js';

/**
 * Shared dependency bag every MCP tool-registration function receives. Built fresh
 * per-request in `McpEndpoint.ts` (stateless transport — see the simpleStatelessStreamableHttp
 * example in the SDK) so each call gets a `DraftEditor` bound to that request's live stores.
 */
export interface McpToolDeps {
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
  draftEditor: DraftEditor;
  /** Imagery store. Stateless like the others — artwork lives outside content versions. */
  assetStore: AssetStore;
  /**
   * Who is calling: the API token owner's username (falling back to their email), resolved by
   * mcpAuthMiddleware. Used as DesignNote.author and asset upload attribution — never taken from
   * tool input.
   */
  callerLabel: string;
}
