import type { ContentStore } from '../../game/ContentStore.js';
import type { VersionStore } from '../../game/VersionStore.js';
import type { DraftEditor } from '../../game/DraftEditor.js';

/**
 * Shared dependency bag every MCP tool-registration function receives. Built fresh
 * per-request in `McpEndpoint.ts` (stateless transport — see the simpleStatelessStreamableHttp
 * example in the SDK) so each call gets a `DraftEditor` bound to that request's live stores.
 */
export interface McpToolDeps {
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
  draftEditor: DraftEditor;
  /** The authenticated caller's token label (from MCP_TOKENS), used e.g. as DesignNote.author. */
  tokenLabel: string;
}
