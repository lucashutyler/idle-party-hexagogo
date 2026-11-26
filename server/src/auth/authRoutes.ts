import { Router } from 'express';
import type { Request, Response } from 'express';
import type { Account, AccountStore } from './AccountStore.js';
import type { TokenStore } from './TokenStore.js';
import type { InviteListStore } from './InviteListStore.js';
import { sendMagicLinkEmail } from './EmailService.js';
import { grantedAdminRole } from './AdminRoles.js';
import { SlidingWindowLimiter } from '../RateLimiter.js';

const isProd = process.env.NODE_ENV === 'production';
const isInviteOnly = process.env.INVITE_ONLY === 'true';

const MINUTE_MS = 60 * 1000;
const SIGN_IN_EMAIL_LIMITS = {
  perEmailAndIp: { limit: 3, windowMs: 10 * MINUTE_MS },
  perEmail: { limit: 8, windowMs: 60 * MINUTE_MS },
  perIp: { limit: 100, windowMs: 10 * MINUTE_MS },
};
const LOGIN_CODE_LIMIT_PER_IP = { limit: 100, windowMs: 10 * MINUTE_MS };

export const TOO_MANY_SIGN_IN_EMAILS = 'Too many sign-in emails. Use the last one we sent, or try again in a few minutes.';
export const WRONG_LOGIN_CODE = 'That code doesn\'t match the newest sign-in email.';
const MALFORMED_LOGIN_CODE = 'Enter the 6-digit code from the email.';
const TOO_MANY_CODE_TRIES = 'Too many tries from here. Wait a few minutes, then try again.';

interface AuthRouteOptions {
  accountStore: AccountStore;
  tokenStore: TokenStore;
  inviteListStore: InviteListStore;
}

function limiterFor({ limit, windowMs }: { limit: number; windowMs: number }): SlidingWindowLimiter {
  return new SlidingWindowLimiter(limit, windowMs);
}

function requestIp(req: Request): string {
  return req.ip ?? 'unknown';
}

export function createAuthRoutes({ accountStore, tokenStore, inviteListStore }: AuthRouteOptions): Router {
  const router = Router();

  const emailIpLimiter = limiterFor(SIGN_IN_EMAIL_LIMITS.perEmailAndIp);
  const emailLimiter = limiterFor(SIGN_IN_EMAIL_LIMITS.perEmail);
  const ipLimiter = limiterFor(SIGN_IN_EMAIL_LIMITS.perIp);
  const codeIpLimiter = limiterFor(LOGIN_CODE_LIMIT_PER_IP);
  for (const limiter of [emailIpLimiter, emailLimiter, ipLimiter, codeIpLimiter]) {
    tokenStore.pruneWithCleanup(limiter);
  }

  /** Counts one sign-in email against every limit, or none when any limit is reached. */
  function takeSignInEmail(email: string, ip: string): boolean {
    const checks: [SlidingWindowLimiter, string, string][] = [
      [emailIpLimiter, `${email}|${ip}`, 'email+ip'],
      [emailLimiter, email, 'email'],
      [ipLimiter, ip, 'ip'],
    ];
    const blocked = checks.find(([limiter, key]) => !limiter.allows(key));
    if (blocked) {
      console.warn(`[Auth] Sign-in email refused (${blocked[2]} limit) for ${email} from ${ip}`);
      return false;
    }
    for (const [limiter, key] of checks) limiter.tryTake(key);
    return true;
  }

  function startSession(req: Request, res: Response, email: string, account: Account | null | undefined): void {
    req.session.regenerate((err) => {
      if (err) {
        console.error('[Auth] Session regenerate error:', err);
        res.status(500).json({ error: 'Session error' });
        return;
      }

      req.session.email = email;
      req.session.username = account?.username || undefined;

      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Session save error:', err);
          res.status(500).json({ error: 'Session error' });
          return;
        }

        accountStore.addSessionRecord(email, {
          deviceToken: res.locals.deviceToken ?? 'unknown',
          ip: req.ip ?? (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) ?? 'unknown',
          userAgent: req.headers['user-agent'] ?? 'unknown',
          timestamp: new Date().toISOString(),
        });

        res.json({
          status: 'approved',
          email,
          username: account?.username ?? null,
        });
      });
    });
  }

  /**
   * POST /auth/login — { email }
   * Dev: auto-verifies, returns token for client to call /auth/verify
   * Prod: emails a sign-in code and link; the asking browser polls /auth/login-status
   */
  router.post('/login', async (req, res) => {
    const { email } = req.body;

    if (!email || typeof email !== 'string') {
      res.status(400).json({ error: 'Email is required' });
      return;
    }

    const trimmed = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      res.status(400).json({ error: 'Invalid email address' });
      return;
    }

    // Beta gate: only admins (env super admins or granted roles) and invited emails may sign in.
    // Uses the granted role, not the effective one — a suspended admin should fall through to the
    // deactivated branch below and get the appeal flow, not a generic "invite-only" rejection.
    if (isInviteOnly) {
      if (!grantedAdminRole(trimmed, accountStore) && !inviteListStore.has(trimmed)) {
        res.json({ error: 'This server is invite-only right now. Ask an admin to add your email to the invite list.' });
        return;
      }
    }

    if (isProd && !takeSignInEmail(trimmed, requestIp(req))) {
      res.json({ error: TOO_MANY_SIGN_IN_EMAILS });
      return;
    }

    // Create account if it doesn't exist
    const loginAccount = await accountStore.createAccount(trimmed);

    // Block deactivated accounts from logging in
    if (loginAccount.deactivated) {
      res.json({ deactivated: true, email: trimmed });
      return;
    }

    if (!isProd) {
      // Dev mode: return token directly so client can auto-verify
      res.json({ mode: 'dev', token: tokenStore.create(trimmed) });
      return;
    }

    const { token, loginId, code } = tokenStore.createLogin(trimmed, res.locals.deviceToken ?? '');
    try {
      await sendMagicLinkEmail(trimmed, token, code);
      res.json({ mode: 'prod', loginId, sent: true });
    } catch (err) {
      console.error('[Auth] Failed to send magic link:', err);
      res.status(500).json({ error: 'Failed to send verification email' });
    }
  });

  /**
   * GET /auth/verify?token=...
   * Dev only: verifies the magic link token, creates a session, returns JSON.
   */
  router.get('/verify', async (req, res) => {
    if (isProd) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const { token } = req.query;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const email = tokenStore.verify(token);
    if (!email) {
      res.status(401).json({ error: 'Invalid or expired sign-in link. Please request a new one.' });
      return;
    }

    // Mark account as verified
    await accountStore.setVerified(email);
    const account = accountStore.findByEmail(email);

    // Block deactivated accounts
    if (account?.deactivated) {
      res.status(403).json({ error: 'Account suspended', deactivated: true, email });
      return;
    }

    // Regenerate session to prevent fixation and ensure a fresh cookie is set.
    // This is critical because the verify request comes from a client-side fetch —
    // express-session doesn't reliably set cookies when save() is called explicitly.
    req.session.regenerate((err) => {
      if (err) {
        console.error('[Auth] Session regenerate error:', err);
        res.status(500).json({ error: 'Session error' });
        return;
      }

      req.session.email = email;
      req.session.username = account?.username || undefined;

      req.session.save((err) => {
        if (err) {
          console.error('[Auth] Session save error:', err);
          res.status(500).json({ error: 'Session error' });
          return;
        }

        // Record session fingerprint for duplicate detection
        accountStore.addSessionRecord(email, {
          deviceToken: res.locals.deviceToken ?? 'unknown',
          ip: req.ip ?? (req.headers['x-forwarded-for']?.toString().split(',')[0]?.trim()) ?? 'unknown',
          userAgent: req.headers['user-agent'] ?? 'unknown',
          timestamp: new Date().toISOString(),
        });

        res.json({
          success: true,
          email,
          username: account?.username ?? null,
        });
      });
    });
  });

  /**
   * POST /auth/approve — { token }
   * The emailed link. Approves the pending login only on the browser that asked for it, whose
   * next poll then gets the session; anywhere else it answers needsCode and approves nothing.
   */
  router.post('/approve', async (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const approval = tokenStore.approveFromLink(token, res.locals.deviceToken);
    if (approval.status === 'invalid') {
      res.status(401).json({ error: 'Invalid or expired sign-in link. Please request a new one.' });
      return;
    }
    if (approval.status === 'needs_code') {
      res.json({ needsCode: true });
      return;
    }

    await accountStore.setVerified(approval.email);
    res.json({ success: true });
  });

  /**
   * POST /auth/login-code — { loginId, code }
   * Signs the asking browser in with the 6-digit code from its sign-in email.
   */
  router.post('/login-code', async (req, res) => {
    const { loginId, code } = req.body;

    if (!loginId || typeof loginId !== 'string' || typeof code !== 'string') {
      res.status(400).json({ error: 'loginId and code are required' });
      return;
    }

    const digits = code.replace(/\s+/g, '');
    if (!/^\d{6}$/.test(digits)) {
      res.status(400).json({ status: 'pending', error: MALFORMED_LOGIN_CODE });
      return;
    }

    const ip = requestIp(req);
    if (!codeIpLimiter.tryTake(ip)) {
      console.warn(`[Auth] Sign-in code refused (ip limit) from ${ip}`);
      res.json({ status: 'pending', error: TOO_MANY_CODE_TRIES });
      return;
    }

    const result = tokenStore.submitCode(loginId, digits);
    if (result === 'wrong_code') {
      res.json({ status: 'pending', error: WRONG_LOGIN_CODE });
      return;
    }
    if (result === 'expired') {
      res.json({ status: 'expired' });
      return;
    }

    await accountStore.setVerified(result.email);
    const account = accountStore.findByEmail(result.email);
    if (account?.deactivated) {
      res.status(403).json({ error: 'Account suspended', deactivated: true, email: result.email });
      return;
    }

    startSession(req, res, result.email, account);
  });

  /**
   * GET /auth/login-status?loginId=...
   * Polls the status of a pending login. On approval, creates a session on the polling device.
   */
  router.get('/login-status', async (req, res) => {
    const { loginId } = req.query;

    if (!loginId || typeof loginId !== 'string') {
      res.status(400).json({ error: 'loginId is required' });
      return;
    }

    const status = tokenStore.checkLogin(loginId);

    if (status.status === 'expired') {
      res.json({ status: 'expired' });
      return;
    }

    if (status.status === 'pending') {
      res.json({ status: 'pending' });
      return;
    }

    // Approved: consume the login and create session on this device
    const email = tokenStore.consumeLogin(loginId);
    if (!email) {
      res.json({ status: 'expired' });
      return;
    }

    const account = accountStore.findByEmail(email);

    // Block deactivated accounts
    if (account?.deactivated) {
      res.status(403).json({ error: 'Account suspended', deactivated: true, email });
      return;
    }

    startSession(req, res, email, account);
  });

  /**
   * GET /auth/session — check current session state
   */
  router.get('/session', (req, res) => {
    if (!req.session.email) {
      res.json({ authenticated: false });
      return;
    }

    const account = accountStore.findByEmail(req.session.email);

    // Block deactivated accounts — return email so client can submit appeals
    if (account?.deactivated) {
      res.json({ authenticated: false, deactivated: true, email: req.session.email });
      return;
    }

    res.json({
      authenticated: true,
      email: req.session.email,
      username: account?.username ?? null,
    });
  });

  /**
   * POST /auth/username — { username }
   * Choose the authenticated account's username. A chosen name can't change; re-sending it succeeds.
   */
  router.post('/username', async (req, res) => {
    if (!req.session.email) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }

    const { username } = req.body;
    if (!username || typeof username !== 'string') {
      res.status(400).json({ error: 'Username is required' });
      return;
    }

    const trimmed = username.trim();
    if (!trimmed || trimmed.length > 20) {
      res.status(400).json({ error: 'Username must be 1-20 characters' });
      return;
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(trimmed)) {
      res.status(400).json({ error: 'Letters, numbers, hyphens, underscores only' });
      return;
    }

    // No await between this check and setUsername: two requests could both pass it.
    const oldUsername = accountStore.getOldUsername(req.session.email);
    if (oldUsername && oldUsername !== trimmed) {
      res.status(409).json({ error: 'Your username can\'t be changed' });
      return;
    }

    const result = await accountStore.setUsername(req.session.email, trimmed);

    if (!result.success) {
      res.status(409).json({ error: result.error });
      return;
    }

    req.session.username = trimmed;
    req.session.save((err) => {
      if (err) {
        console.error('[Auth] Session save error:', err);
      }
    });

    res.json({ success: true, username: trimmed, oldUsername });
  });

  /**
   * POST /auth/appeal — { email, text }
   * Submit a reactivation appeal for a suspended account. No session required.
   */
  router.post('/appeal', async (req, res) => {
    const { email, text } = req.body;
    if (!email || typeof email !== 'string' || !text || typeof text !== 'string') {
      res.status(400).json({ error: 'Email and appeal text are required' });
      return;
    }

    const trimmedEmail = email.trim().toLowerCase();
    const account = accountStore.findByEmail(trimmedEmail);
    if (!account || !account.deactivated) {
      res.status(404).json({ error: 'No suspended account found' });
      return;
    }

    await accountStore.setReactivationRequest(trimmedEmail, text.trim().slice(0, 500));
    res.json({ success: true });
  });

  /**
   * POST /auth/logout — destroy session
   */
  router.post('/logout', (req, res) => {
    req.session.destroy((err) => {
      if (err) {
        console.error('[Auth] Logout error:', err);
        res.status(500).json({ error: 'Logout failed' });
        return;
      }
      res.clearCookie('connect.sid');
      res.json({ success: true });
    });
  });

  return router;
}
