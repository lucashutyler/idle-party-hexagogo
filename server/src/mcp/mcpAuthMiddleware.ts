import type { Request, Response, NextFunction } from 'express';

declare global {
  namespace Express {
    interface Request {
      mcpTokenLabel?: string;
    }
  }
}

/**
 * Parses MCP_TOKENS: comma-separated list, each entry optionally "label:token".
 * Plain "token" entries (no colon) get the label "mcp". Mirrors parseEmailListEnv's style.
 */
export function parseMcpTokens(raw: string | undefined): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const entry of (raw ?? '').split(',')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex === -1) {
      tokens.set(trimmed, 'mcp');
    } else {
      const label = trimmed.slice(0, colonIndex).trim();
      const token = trimmed.slice(colonIndex + 1).trim();
      if (!token) continue;
      tokens.set(token, label || 'mcp');
    }
  }
  return tokens;
}

/**
 * Bearer-token auth for the MCP endpoint. If MCP_TOKENS is unset/empty, the whole
 * endpoint is hidden (404) — MCP access is opt-in per deployment. Otherwise a
 * non-matching token is a 401.
 */
export function mcpAuthMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tokens = parseMcpTokens(process.env.MCP_TOKENS);
  if (tokens.size === 0) {
    res.status(404).end();
    return;
  }

  const authHeader = req.header('authorization') ?? '';
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const presented = match?.[1]?.trim();
  if (!presented) {
    res.status(401).json({ error: 'Missing bearer token.' });
    return;
  }

  const label = tokens.get(presented);
  if (!label) {
    res.status(401).json({ error: 'Invalid token.' });
    return;
  }

  req.mcpTokenLabel = label;
  next();
}
