import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Wraps a tool's plain-object result as the MCP text-content shape every tool in this repo returns. */
export function toolResult(data: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
}

/** Normalizes a caught value to a message string — every tool's logic function catches this way. */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
