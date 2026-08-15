import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Request, Response, NextFunction } from 'express';
import { createAdminAuth, readBearerToken } from '../src/admin/adminMiddleware.js';
import { createMcpAuthMiddleware } from '../src/mcp/mcpAuthMiddleware.js';
import { resolveAdminRole, grantedAdminRole, isEnvSuperAdmin } from '../src/auth/AdminRoles.js';
import { hashApiToken, isApiTokenExpired } from '../src/auth/ApiTokenStore.js';
import type { ApiTokenRecord } from '../src/auth/ApiTokenStore.js';
import type { Account, AccountStore } from '../src/auth/AccountStore.js';
import type { ApiTokenStore } from '../src/auth/ApiTokenStore.js';

/** In-memory stand-ins — the real stores resolve data/ from cwd, which these tests don't need. */
function makeAccountStore(accounts: Account[]): AccountStore {
  const byEmail = new Map(accounts.map(a => [a.email.toLowerCase(), a]));
  return {
    findByEmail: (email: string) => byEmail.get(email.toLowerCase()) ?? null,
  } as unknown as AccountStore;
}

function makeAccount(email: string, extra: Partial<Account> = {}): Account {
  return {
    email: email.toLowerCase(),
    username: email.split('@')[0],
    verified: true,
    createdAt: '2026-01-01T00:00:00.000Z',
    lastActiveAt: null,
    ...extra,
  };
}

function makeTokenRecord(email: string, token: string, extra: Partial<ApiTokenRecord> = {}): ApiTokenRecord {
  return {
    id: `token-${email}`,
    email: email.toLowerCase(),
    label: 'test token',
    tokenHash: hashApiToken(token),
    prefix: token.slice(0, 12),
    createdAt: '2026-01-01T00:00:00.000Z',
    expiresAt: null,
    lastUsedAt: null,
    ...extra,
  };
}

function makeTokenStore(records: ApiTokenRecord[]): { store: ApiTokenStore; markUsed: ReturnType<typeof vi.fn> } {
  const markUsed = vi.fn();
  const store = {
    findByToken: (token: string) => records.find(r => r.tokenHash === hashApiToken(token.trim())) ?? null,
    markUsed,
  } as unknown as ApiTokenStore;
  return { store, markUsed };
}

/** Minimal Express req/res/next stand-ins. */
function makeReqRes(opts: { authorization?: string; sessionEmail?: string } = {}) {
  const req = {
    header: (name: string) => (name.toLowerCase() === 'authorization' ? opts.authorization : undefined),
    session: opts.sessionEmail ? { email: opts.sessionEmail } : undefined,
  } as unknown as Request;
  const res = {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    end: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const next = vi.fn() as unknown as NextFunction;
  return { req, res, next };
}

const ORIGINAL_ADMIN_EMAILS = process.env.ADMIN_EMAILS;

afterEach(() => {
  if (ORIGINAL_ADMIN_EMAILS === undefined) delete process.env.ADMIN_EMAILS;
  else process.env.ADMIN_EMAILS = ORIGINAL_ADMIN_EMAILS;
});

describe('resolveAdminRole', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'Owner@Example.com, second@example.com';
  });

  it('makes every ADMIN_EMAILS entry a super admin, case-insensitively', () => {
    const store = makeAccountStore([]);
    expect(resolveAdminRole('owner@example.com', store)).toBe('superadmin');
    expect(resolveAdminRole('OWNER@EXAMPLE.COM', store)).toBe('superadmin');
    expect(resolveAdminRole('second@example.com', store)).toBe('superadmin');
  });

  it('treats an ADMIN_EMAILS entry as super admin even with no account record', () => {
    expect(resolveAdminRole('owner@example.com', makeAccountStore([]))).toBe('superadmin');
    expect(isEnvSuperAdmin('owner@example.com')).toBe(true);
  });

  it('returns the granted role for a non-env account', () => {
    const store = makeAccountStore([makeAccount('mod@example.com', { role: 'admin' })]);
    expect(resolveAdminRole('mod@example.com', store)).toBe('admin');
  });

  it('returns null for an account with no role', () => {
    const store = makeAccountStore([makeAccount('player@example.com')]);
    expect(resolveAdminRole('player@example.com', store)).toBeNull();
  });

  it('returns null for an unknown email, undefined, and empty input', () => {
    const store = makeAccountStore([]);
    expect(resolveAdminRole('nobody@example.com', store)).toBeNull();
    expect(resolveAdminRole(undefined, store)).toBeNull();
    expect(resolveAdminRole('', store)).toBeNull();
  });

  it('suspends a granted role while the account is deactivated', () => {
    const store = makeAccountStore([makeAccount('mod@example.com', { role: 'admin', deactivated: true })]);
    expect(resolveAdminRole('mod@example.com', store)).toBeNull();
    // The grant itself survives, so reactivating restores it and the dashboard still shows it.
    expect(grantedAdminRole('mod@example.com', store)).toBe('admin');
  });

  it('keeps an ADMIN_EMAILS super admin even if their account is deactivated', () => {
    const store = makeAccountStore([makeAccount('owner@example.com', { deactivated: true })]);
    expect(resolveAdminRole('owner@example.com', store)).toBe('superadmin');
  });

  it('reads ADMIN_EMAILS per call, so env edits take effect without a restart', () => {
    const store = makeAccountStore([]);
    expect(resolveAdminRole('late@example.com', store)).toBeNull();
    process.env.ADMIN_EMAILS = 'late@example.com';
    expect(resolveAdminRole('late@example.com', store)).toBe('superadmin');
  });
});

describe('readBearerToken', () => {
  it('extracts the token and is case-insensitive on the scheme', () => {
    expect(readBearerToken(makeReqRes({ authorization: 'Bearer abc123' }).req)).toBe('abc123');
    expect(readBearerToken(makeReqRes({ authorization: 'bearer abc123' }).req)).toBe('abc123');
    expect(readBearerToken(makeReqRes({ authorization: 'Bearer   abc123  ' }).req)).toBe('abc123');
  });

  it('returns null when absent or not a bearer scheme', () => {
    expect(readBearerToken(makeReqRes().req)).toBeNull();
    expect(readBearerToken(makeReqRes({ authorization: 'Basic abc123' }).req)).toBeNull();
    expect(readBearerToken(makeReqRes({ authorization: 'Bearer   ' }).req)).toBeNull();
  });
});

describe('isApiTokenExpired', () => {
  const base = makeTokenRecord('a@example.com', 'ipr_token');

  it('never expires when expiresAt is null', () => {
    expect(isApiTokenExpired({ ...base, expiresAt: null })).toBe(false);
  });

  it('is expired at or after the expiry instant', () => {
    const record = { ...base, expiresAt: '2026-06-01T00:00:00.000Z' };
    expect(isApiTokenExpired(record, Date.parse('2026-05-31T23:59:59.000Z'))).toBe(false);
    expect(isApiTokenExpired(record, Date.parse('2026-06-01T00:00:00.000Z'))).toBe(true);
    expect(isApiTokenExpired(record, Date.parse('2026-06-02T00:00:00.000Z'))).toBe(true);
  });

  it('treats an unparseable expiry as expired rather than eternal', () => {
    expect(isApiTokenExpired({ ...base, expiresAt: 'not-a-date' })).toBe(true);
  });
});

describe('createAdminAuth.requireAdmin', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = 'owner@example.com';
  });

  it('401s an unauthenticated request with no session and no token', () => {
    const auth = createAdminAuth({ accountStore: makeAccountStore([]), apiTokenStore: makeTokenStore([]).store });
    const { req, res, next } = makeReqRes();
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s a signed-in non-admin', () => {
    const accountStore = makeAccountStore([makeAccount('player@example.com')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: makeTokenStore([]).store });
    const { req, res, next } = makeReqRes({ sessionEmail: 'player@example.com' });
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('admits a session super admin and records how they authenticated', () => {
    const accountStore = makeAccountStore([makeAccount('owner@example.com')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: makeTokenStore([]).store });
    const { req, res, next } = makeReqRes({ sessionEmail: 'Owner@Example.com' });
    auth.requireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.adminPrincipal).toMatchObject({ email: 'owner@example.com', role: 'superadmin', via: 'session', label: 'owner' });
  });

  it('admits a valid API token and marks it used', () => {
    const accountStore = makeAccountStore([makeAccount('mod@example.com', { role: 'admin', username: 'Moddy' })]);
    const { store, markUsed } = makeTokenStore([makeTokenRecord('mod@example.com', 'ipr_good')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_good' });
    auth.requireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.adminPrincipal).toMatchObject({ email: 'mod@example.com', role: 'admin', via: 'token', label: 'Moddy' });
    expect(markUsed).toHaveBeenCalledWith('token-mod@example.com');
  });

  it('401s an unrecognised token', () => {
    const auth = createAdminAuth({ accountStore: makeAccountStore([]), apiTokenStore: makeTokenStore([]).store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_nope' });
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s an expired token', () => {
    const accountStore = makeAccountStore([makeAccount('mod@example.com', { role: 'admin' })]);
    const { store } = makeTokenStore([makeTokenRecord('mod@example.com', 'ipr_old', { expiresAt: '2020-01-01T00:00:00.000Z' })]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_old' });
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s a token whose owner is no longer an admin, without the token being deleted', () => {
    const accountStore = makeAccountStore([makeAccount('exmod@example.com')]);
    const { store } = makeTokenStore([makeTokenRecord('exmod@example.com', 'ipr_stale')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_stale' });
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('403s a token whose owner has been suspended', () => {
    const accountStore = makeAccountStore([makeAccount('mod@example.com', { role: 'admin', deactivated: true })]);
    const { store } = makeTokenStore([makeTokenRecord('mod@example.com', 'ipr_banned')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_banned' });
    auth.requireAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('prefers the bearer token over a session cookie when both are present', () => {
    const accountStore = makeAccountStore([
      makeAccount('owner@example.com'),
      makeAccount('mod@example.com', { role: 'admin' }),
    ]);
    const { store } = makeTokenStore([makeTokenRecord('mod@example.com', 'ipr_good')]);
    const auth = createAdminAuth({ accountStore, apiTokenStore: store });
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_good', sessionEmail: 'owner@example.com' });
    auth.requireAdmin(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(req.adminPrincipal).toMatchObject({ email: 'mod@example.com', via: 'token' });
  });
});

describe('createAdminAuth.requireSuperAdmin / requireSession', () => {
  const auth = () => createAdminAuth({ accountStore: makeAccountStore([]), apiTokenStore: makeTokenStore([]).store });

  it('lets a super admin through and blocks a plain admin', () => {
    const a = auth();
    const superReq = makeReqRes();
    superReq.req.adminPrincipal = { email: 'o@e.com', role: 'superadmin', via: 'session', label: 'o' };
    a.requireSuperAdmin(superReq.req, superReq.res, superReq.next);
    expect(superReq.next).toHaveBeenCalledTimes(1);

    const adminReq = makeReqRes();
    adminReq.req.adminPrincipal = { email: 'm@e.com', role: 'admin', via: 'session', label: 'm' };
    a.requireSuperAdmin(adminReq.req, adminReq.res, adminReq.next);
    expect(adminReq.res.status).toHaveBeenCalledWith(403);
    expect(adminReq.next).not.toHaveBeenCalled();
  });

  it('blocks super-admin routes when no principal was resolved', () => {
    const { req, res, next } = makeReqRes();
    auth().requireSuperAdmin(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('allows a session principal but rejects a token principal', () => {
    const a = auth();
    const sessionReq = makeReqRes();
    sessionReq.req.adminPrincipal = { email: 'o@e.com', role: 'superadmin', via: 'session', label: 'o' };
    a.requireSession(sessionReq.req, sessionReq.res, sessionReq.next);
    expect(sessionReq.next).toHaveBeenCalledTimes(1);

    const tokenReq = makeReqRes();
    tokenReq.req.adminPrincipal = { email: 'o@e.com', role: 'superadmin', via: 'token', label: 'o' };
    a.requireSession(tokenReq.req, tokenReq.res, tokenReq.next);
    expect(tokenReq.res.status).toHaveBeenCalledWith(403);
    expect(tokenReq.next).not.toHaveBeenCalled();
  });
});

describe('createMcpAuthMiddleware', () => {
  beforeEach(() => {
    process.env.ADMIN_EMAILS = '';
  });

  const build = (accounts: Account[], records: ApiTokenRecord[]) =>
    createMcpAuthMiddleware(createAdminAuth({
      accountStore: makeAccountStore(accounts),
      apiTokenStore: makeTokenStore(records).store,
    }));

  it('401s when no bearer token is presented, even with an admin session cookie', () => {
    const middleware = build([makeAccount('mod@example.com', { role: 'admin' })], []);
    const { req, res, next } = makeReqRes({ sessionEmail: 'mod@example.com' });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('401s an unrecognised token', () => {
    const middleware = build([], []);
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_nope' });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('403s a token whose owner lost admin', () => {
    const middleware = build([makeAccount('exmod@example.com')], [makeTokenRecord('exmod@example.com', 'ipr_stale')]);
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_stale' });
    middleware(req, res, next);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches the owner username as the caller label on success', () => {
    const middleware = build(
      [makeAccount('mod@example.com', { role: 'admin', username: 'Moddy' })],
      [makeTokenRecord('mod@example.com', 'ipr_good')],
    );
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_good' });
    middleware(req, res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
    expect(req.mcpCallerLabel).toBe('Moddy');
  });

  it('falls back to the owner email when they have no username yet', () => {
    const middleware = build(
      [makeAccount('mod@example.com', { role: 'admin', username: null })],
      [makeTokenRecord('mod@example.com', 'ipr_good')],
    );
    const { req, res, next } = makeReqRes({ authorization: 'Bearer ipr_good' });
    middleware(req, res, next);
    expect(req.mcpCallerLabel).toBe('mod@example.com');
  });
});
