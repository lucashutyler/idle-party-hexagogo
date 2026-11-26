import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { AccountStore } from '../src/auth/AccountStore.js';
import { MAX_CODE_ATTEMPTS, TokenStore } from '../src/auth/TokenStore.js';
import type { InviteListStore } from '../src/auth/InviteListStore.js';

const sendMagicLinkEmail = vi.hoisted(() => vi.fn<(email: string, token: string, code: string) => Promise<void>>());
vi.mock('../src/auth/EmailService.js', () => ({ sendMagicLinkEmail }));

const EMAIL = 'player@example.test';
const ASKING_DEVICE = 'device-asking';
const OTHER_DEVICE = 'device-other';
const PLAYER_IP = '203.0.113.7';

interface TestSession {
  email?: string;
  username?: string;
  regenerate: (cb: (err?: unknown) => void) => void;
  save: (cb?: (err?: unknown) => void) => void;
}

interface Mailed {
  token: string;
  code: string;
}

interface RequestOptions {
  device?: string;
  ip?: string;
}

describe('production sign-in flow', () => {
  let accounts: AccountStore;
  let session: TestSession;
  let server: Server;
  let base: string;
  let messages: { tooManyEmails: string; wrongCode: string };

  const headers = ({ device = ASKING_DEVICE, ip = PLAYER_IP }: RequestOptions = {}) => ({
    'Content-Type': 'application/json',
    'X-Test-Device': device,
    'X-Forwarded-For': ip,
  });

  const post = async (path: string, body: unknown, opts?: RequestOptions) => {
    const res = await fetch(`${base}/auth${path}`, { method: 'POST', headers: headers(opts), body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  const get = async (path: string, opts?: RequestOptions) => {
    const res = await fetch(`${base}/auth${path}`, { headers: headers(opts) });
    return { status: res.status, body: await res.json() as Record<string, unknown> };
  };

  const login = (email = EMAIL, opts?: RequestOptions) => post('/login', { email }, opts);
  const loginStatus = (loginId: string, opts?: RequestOptions) => get(`/login-status?loginId=${loginId}`, opts);

  const lastMailed = (): Mailed => {
    const call = sendMagicLinkEmail.mock.lastCall!;
    return { token: call[1], code: call[2] };
  };

  const startSignIn = async (opts?: RequestOptions) => {
    const res = await login(EMAIL, opts);
    expect(res.body).toMatchObject({ mode: 'prod', sent: true });
    return { loginId: res.body.loginId as string, ...lastMailed() };
  };

  const wrongCodeFor = (code: string) => (code === '000000' ? '111111' : '000000');

  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.resetModules();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    sendMagicLinkEmail.mockReset();
    sendMagicLinkEmail.mockResolvedValue(undefined);

    const routes = await import('../src/auth/authRoutes.js');
    messages = { tooManyEmails: routes.TOO_MANY_SIGN_IN_EMAILS, wrongCode: routes.WRONG_LOGIN_CODE };

    accounts = new AccountStore();
    vi.spyOn(accounts, 'save').mockResolvedValue();
    session = {
      regenerate: (cb) => cb(),
      save: (cb) => cb?.(),
    };

    const app = express();
    app.set('trust proxy', true);
    app.use(express.json());
    app.use((req, res, next) => {
      res.locals.deviceToken = req.headers['x-test-device'];
      req.session = session as unknown as typeof req.session;
      next();
    });
    app.use('/auth', routes.createAuthRoutes({
      accountStore: accounts,
      tokenStore: new TokenStore(),
      inviteListStore: {} as InviteListStore,
    }));
    server = await new Promise<Server>(resolve => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  describe('POST /auth/login', () => {
    it('mails a 6-digit code and never returns it', async () => {
      const res = await login();

      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(['loginId', 'mode', 'sent']);
      expect(sendMagicLinkEmail).toHaveBeenCalledOnce();
      const { token, code } = lastMailed();
      expect(sendMagicLinkEmail).toHaveBeenCalledWith(EMAIL, token, code);
      expect(code).toMatch(/^\d{6}$/);
      expect(JSON.stringify(res.body)).not.toContain(code);
      expect(JSON.stringify(res.body)).not.toContain(token);
    });

    it('mails the same code and link again for a resend from the same browser', async () => {
      const first = await startSignIn();
      const again = await startSignIn();

      expect(again).toEqual(first);
    });

    it('refuses the 4th email for one address and IP in the window, before making an account', async () => {
      const createAccount = vi.spyOn(accounts, 'createAccount');
      for (let i = 0; i < 3; i++) await startSignIn();
      expect(createAccount).toHaveBeenCalledTimes(3);

      const res = await login();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ error: messages.tooManyEmails });
      expect(sendMagicLinkEmail).toHaveBeenCalledTimes(3);
      expect(createAccount).toHaveBeenCalledTimes(3);
      expect(console.warn).toHaveBeenCalled();
    });

    it('still mails the same address from another IP once one IP is refused', async () => {
      for (let i = 0; i < 3; i++) await login();
      expect((await login()).body.error).toBe(messages.tooManyEmails);

      const res = await login(EMAIL, { ip: '198.51.100.20' });

      expect(res.body).toMatchObject({ mode: 'prod', sent: true });
    });

    it('refuses a 9th email for one address within the hour, from any IP', async () => {
      for (let i = 0; i < 8; i++) {
        expect((await login(EMAIL, { ip: `198.51.100.${i + 1}` })).body.sent).toBe(true);
      }

      const res = await login(EMAIL, { ip: '198.51.100.99' });

      expect(res.body).toEqual({ error: messages.tooManyEmails });
      expect(sendMagicLinkEmail).toHaveBeenCalledTimes(8);
    });

    it('refuses the 101st email from one IP in the window', async () => {
      for (let i = 0; i < 100; i++) {
        expect((await login(`p${i}@example.test`)).body.sent).toBe(true);
      }

      const res = await login('late@example.test');

      expect(res.body).toEqual({ error: messages.tooManyEmails });
      expect(accounts.findByEmail('late@example.test')).toBeNull();
    });
  });

  describe('POST /auth/approve', () => {
    it('asks for the code when the link is opened on another browser, and the poll stays pending', async () => {
      const { loginId, token } = await startSignIn();

      const res = await post('/approve', { token }, { device: OTHER_DEVICE });

      expect(res).toEqual({ status: 200, body: { needsCode: true } });
      expect((await loginStatus(loginId)).body).toEqual({ status: 'pending' });
      expect(session.email).toBeUndefined();
      expect(accounts.findByEmail(EMAIL)?.verified).toBe(false);
    });

    it('approves on the browser that asked, whose next poll signs it in', async () => {
      const { loginId, token } = await startSignIn();

      const res = await post('/approve', { token });

      expect(res).toEqual({ status: 200, body: { success: true } });
      expect(accounts.findByEmail(EMAIL)?.verified).toBe(true);
      expect((await loginStatus(loginId)).body).toEqual({ status: 'approved', email: EMAIL, username: null });
      expect(session.email).toBe(EMAIL);
      expect((await loginStatus(loginId)).body).toEqual({ status: 'expired' });
    });

    it('still works on the asking browser after another browser opened the link', async () => {
      const { token } = await startSignIn();
      await post('/approve', { token }, { device: OTHER_DEVICE });

      expect((await post('/approve', { token })).body).toEqual({ success: true });
    });

    it('refuses an unknown link', async () => {
      expect((await post('/approve', { token: 'nope' })).status).toBe(401);
    });
  });

  describe('POST /auth/login-code', () => {
    it('signs the asking browser in with the mailed code', async () => {
      const { loginId, code } = await startSignIn();

      const res = await post('/login-code', { loginId, code: ` ${code.slice(0, 3)} ${code.slice(3)} ` });

      expect(res).toEqual({ status: 200, body: { status: 'approved', email: EMAIL, username: null } });
      expect(session.email).toBe(EMAIL);
      expect(accounts.findByEmail(EMAIL)?.verified).toBe(true);
      expect(accounts.findByEmail(EMAIL)?.sessionHistory?.[0]?.deviceToken).toBe(ASKING_DEVICE);
      expect((await loginStatus(loginId)).body).toEqual({ status: 'expired' });
    });

    it('ends the sign-in after five wrong codes', async () => {
      const { loginId, code, token } = await startSignIn();
      const wrong = wrongCodeFor(code);

      for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
        expect((await post('/login-code', { loginId, code: wrong })).body)
          .toEqual({ status: 'pending', error: messages.wrongCode });
      }
      expect((await post('/login-code', { loginId, code: wrong })).body).toEqual({ status: 'expired' });

      expect((await post('/login-code', { loginId, code })).body).toEqual({ status: 'expired' });
      expect((await loginStatus(loginId)).body).toEqual({ status: 'expired' });
      expect((await post('/approve', { token })).status).toBe(401);
      expect(session.email).toBeUndefined();
    });

    it('rejects a code that is not 6 digits without counting it as a try', async () => {
      const { loginId, code } = await startSignIn();

      for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
        const res = await post('/login-code', { loginId, code: '12ab56' });
        expect(res.status).toBe(400);
        expect(res.body.status).toBe('pending');
      }

      expect((await post('/login-code', { loginId, code })).body.status).toBe('approved');
    });

    it('turns a suspended account away with the appeal details', async () => {
      const { loginId, code } = await startSignIn();
      accounts.findByEmail(EMAIL)!.deactivated = true;

      const res = await post('/login-code', { loginId, code });

      expect(res).toEqual({ status: 403, body: { error: 'Account suspended', deactivated: true, email: EMAIL } });
      expect(session.email).toBeUndefined();
    });
  });

  it('answers 404 for /auth/verify', async () => {
    await login();
    const { token } = lastMailed();

    const res = await get(`/verify?token=${token}`);

    expect(res.status).toBe(404);
    expect(session.email).toBeUndefined();
  });
});
