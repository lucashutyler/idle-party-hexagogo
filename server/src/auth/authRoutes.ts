import { Router } from 'express';
import type { AccountStore } from './AccountStore.js';
import type { TokenStore } from './TokenStore.js';
import { sendMagicLinkEmail } from './EmailService.js';

const isProd = process.env.NODE_ENV === 'production';

interface AuthRouteOptions {
  accountStore: AccountStore;
  tokenStore: TokenStore;
  onRenamePlayer?: (oldUsername: string, newUsername: string) => void;
}

export function createAuthRoutes({ accountStore, tokenStore, onRenamePlayer }: AuthRouteOptions): Router {
  const router = Router();

  /**
   * POST /auth/login — { email }
   * Dev: auto-verifies, returns token for client to call /auth/verify
   * Prod: sends magic link email
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

    // Create account if it doesn't exist
    await accountStore.createAccount(trimmed);

    // Generate magic link token
    const token = tokenStore.create(trimmed);

    if (!isProd) {
      // Dev mode: return token directly so client can auto-verify
      res.json({ mode: 'dev', token });
      return;
    }

    // Production: create login + send magic link email
    const { token: loginToken, loginId } = tokenStore.createLogin(trimmed);
    try {
      await sendMagicLinkEmail(trimmed, loginToken);
      res.json({ mode: 'prod', loginId, sent: true });
    } catch (err) {
      console.error('[Auth] Failed to send magic link:', err);
      res.status(500).json({ error: 'Failed to send verification email' });
    }
  });

  /**
   * GET /auth/verify?token=...
   * Verifies the magic link token, creates a session, returns JSON.
   */
  router.get('/verify', async (req, res) => {
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
   * Approves a pending login via magic link token. No session is created on this device.
   */
  router.post('/approve', async (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== 'string') {
      res.status(400).json({ error: 'Token is required' });
      return;
    }

    const email = tokenStore.approve(token);
    if (!email) {
      res.status(401).json({ error: 'Invalid or expired sign-in link. Please request a new one.' });
      return;
    }

    await accountStore.setVerified(email);
    res.json({ success: true });
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

        res.json({
          status: 'approved',
          email,
          username: account?.username ?? null,
        });
      });
    });
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
    res.json({
      authenticated: true,
      email: req.session.email,
      username: account?.username ?? null,
    });
  });

  /**
   * POST /auth/username — { username }
   * Set or change username for the authenticated user.
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

    const oldUsername = accountStore.getOldUsername(req.session.email);
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

    // Rename in-memory player session if username changed
    if (oldUsername && oldUsername !== trimmed && onRenamePlayer) {
      onRenamePlayer(oldUsername, trimmed);
    }

    res.json({ success: true, username: trimmed, oldUsername });
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
