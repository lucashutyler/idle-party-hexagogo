import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { AccountStore } from '../auth/AccountStore.js';
import type { ApiTokenStore } from '../auth/ApiTokenStore.js';
import { isApiTokenExpired } from '../auth/ApiTokenStore.js';
import type { AdminRole } from '../auth/AdminRoles.js';
import { resolveAdminRole } from '../auth/AdminRoles.js';

export interface AdminPrincipal {
  /** Lowercase account email of whoever is making the request. */
  email: string;
  role: AdminRole;
  /** How they proved it. API tokens are barred from routes that change privileges. */
  via: 'session' | 'token';
  /** Display name for logs and content attribution: username when known, else email. */
  label: string;
  /** Id of the API token used, when `via === 'token'`. */
  tokenId?: string;
}

declare global {
  namespace Express {
    interface Request {
      adminPrincipal?: AdminPrincipal;
    }
  }
}

export interface AdminAuthOptions {
  accountStore: AccountStore;
  apiTokenStore: ApiTokenStore;
}

export interface AdminAuth {
  /** Gate for every admin surface: a valid session or API token belonging to an admin. */
  requireAdmin: RequestHandler;
  /** Additionally requires the super admin role — granting roles, and nothing else so far. */
  requireSuperAdmin: RequestHandler;
  /**
   * Additionally requires a browser session. Applied to token and role management so a leaked
   * API token can't mint itself a fresh one or promote its owner.
   */
  requireSession: RequestHandler;
  /** Resolves a principal without responding. Exported for the MCP endpoint's own error shape. */
  resolvePrincipal: (req: Request) => PrincipalResult;
}

export type PrincipalResult =
  | { ok: true; principal: AdminPrincipal }
  | { ok: false; status: 401 | 403; error: string };

/** Pulls the raw secret out of an `Authorization: Bearer <token>` header, if present. */
export function readBearerToken(req: Request): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(req.header('authorization') ?? '');
  const presented = match?.[1]?.trim();
  return presented ? presented : null;
}

export function createAdminAuth({ accountStore, apiTokenStore }: AdminAuthOptions): AdminAuth {
  const labelFor = (email: string): string => accountStore.findByEmail(email)?.username ?? email;

  const resolvePrincipal = (req: Request): PrincipalResult => {
    const bearer = readBearerToken(req);
    if (bearer) {
      const record = apiTokenStore.findByToken(bearer);
      if (!record) return { ok: false, status: 401, error: 'Invalid API token.' };
      if (isApiTokenExpired(record)) return { ok: false, status: 401, error: 'API token has expired.' };
      // Roles are checked at time of use, so a revoked admin's token stops working on its own.
      const role = resolveAdminRole(record.email, accountStore);
      if (!role) return { ok: false, status: 403, error: 'API token owner is not an admin.' };
      apiTokenStore.markUsed(record.id);
      return { ok: true, principal: { email: record.email, role, via: 'token', label: labelFor(record.email), tokenId: record.id } };
    }

    const email = req.session?.email;
    if (!email) return { ok: false, status: 401, error: 'Not authenticated' };
    const role = resolveAdminRole(email, accountStore);
    if (!role) return { ok: false, status: 403, error: 'Not authorized' };
    return { ok: true, principal: { email: email.toLowerCase(), role, via: 'session', label: labelFor(email) } };
  };

  const requireAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    const result = resolvePrincipal(req);
    if (!result.ok) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    req.adminPrincipal = result.principal;
    next();
  };

  // The two below run after requireAdmin on the same router, so the principal is already set.
  const requireSuperAdmin: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (req.adminPrincipal?.role !== 'superadmin') {
      res.status(403).json({ error: 'Super admin required' });
      return;
    }
    next();
  };

  const requireSession: RequestHandler = (req: Request, res: Response, next: NextFunction) => {
    if (req.adminPrincipal?.via !== 'session') {
      res.status(403).json({ error: 'This action requires a signed-in browser session, not an API token.' });
      return;
    }
    next();
  };

  return { requireAdmin, requireSuperAdmin, requireSession, resolvePrincipal };
}
