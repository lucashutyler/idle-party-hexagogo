// --- Types ---

/**
 * A markdown design note attached to a content version — the agreed-upon design
 * context (from an AI-assisted content authoring session, or manual admin notes)
 * that explains *why* a draft's content looks the way it does. Notes ride inside
 * the version snapshot so they are versioned and travel with the content they
 * describe. Never sent to players.
 */
export interface DesignNote {
  id: string;
  title: string;
  /** Markdown body — the agreed design context. */
  body: string;
  tags?: string[];
  /** Token label (MCP) or admin email that authored/last edited this note. */
  author: string;
  createdAt: string;
  updatedAt: string;
}
