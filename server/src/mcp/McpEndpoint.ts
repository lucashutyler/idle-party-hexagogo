import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Router } from 'express';
import { DraftEditor } from '../game/DraftEditor.js';
import type { ContentStore } from '../game/ContentStore.js';
import type { VersionStore } from '../game/VersionStore.js';
import { mcpAuthMiddleware } from './mcpAuthMiddleware.js';
import type { McpToolDeps } from './tools/McpToolDeps.js';
import { registerReadTools } from './tools/readTools.js';
import { registerNotesTools } from './tools/notesTools.js';
import { registerWriteTools } from './tools/writeTools.js';
import { registerValidateTools } from './tools/validateTools.js';

export interface McpEndpointOptions {
  contentStore: () => ContentStore;
  versionStore: () => VersionStore;
}

/** Stateless MCP transport: a fresh McpServer + DraftEditor + StreamableHTTPServerTransport per request. */
export function createMcpRouter(opts: McpEndpointOptions): Router {
  const router = Router();

  router.post('/', mcpAuthMiddleware, async (req, res) => {
    const server = new McpServer({ name: 'idle-party-rpg', version: '1.0.0' });

    try {
      const draftEditor = new DraftEditor(opts.versionStore(), opts.contentStore);
      const deps: McpToolDeps = {
        contentStore: opts.contentStore,
        versionStore: opts.versionStore,
        draftEditor,
        tokenLabel: req.mcpTokenLabel ?? 'mcp',
      };

      registerReadTools(server, deps);
      registerNotesTools(server, deps);
      registerWriteTools(server, deps);
      registerValidateTools(server, deps);

      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);

      res.on('close', () => {
        transport.close();
        server.close();
      });
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: '2.0',
          error: {
            code: -32603,
            message: 'Internal server error',
          },
          id: null,
        });
      }
    }
  });

  router.get('/', mcpAuthMiddleware, (_req, res) => {
    res.status(405).json({ error: 'Method not allowed (stateless MCP endpoint — no server-initiated streams).' });
  });

  router.delete('/', mcpAuthMiddleware, (_req, res) => {
    res.status(405).json({ error: 'Method not allowed (stateless MCP endpoint — no sessions to end).' });
  });

  return router;
}
