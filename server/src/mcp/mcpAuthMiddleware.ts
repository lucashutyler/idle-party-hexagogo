import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AdminAuth } from '../admin/adminMiddleware.js';
import { readBearerToken } from '../admin/adminMiddleware.js';

declare global {
  namespace Express {
    interface Request {
      mcpCallerLabel?: string;
    }
  }
}

/**
 * Bearer-token auth for the MCP endpoint, sharing the admin API's token machinery: the presented
 * token is resolved to its owner and the owner's admin role is checked on every request. A token
 * whose owner has lost admin access is inert without ever being deleted.
 *
 * Unlike the admin API, MCP accepts *only* a bearer token — a browser session is never enough,
 * since anyone signed in as an admin would otherwise reach the content-authoring tools from a
 * cross-site request.
 */
export function createMcpAuthMiddleware(adminAuth: AdminAuth): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!readBearerToken(req)) {
      res.status(401).json({ error: 'Missing bearer token. Generate an API token in the World Manager.' });
      return;
    }

    const result = adminAuth.resolvePrincipal(req);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }

    req.mcpCallerLabel = result.principal.label;
    next();
  };
}
