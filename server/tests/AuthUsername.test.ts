import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import express from 'express';
import { AccountStore } from '../src/auth/AccountStore.js';
import { createAuthRoutes } from '../src/auth/authRoutes.js';
import type { InviteListStore } from '../src/auth/InviteListStore.js';
import type { TokenStore } from '../src/auth/TokenStore.js';

const EMAIL = 'player@example.test';
const OTHER_EMAIL = 'other@example.test';

interface TestSession {
  email?: string;
  username?: string;
  save: ReturnType<typeof vi.fn>;
}

function sessionFor(email?: string): TestSession {
  return { email, save: vi.fn() };
}

describe('POST /auth/username', () => {
  let accounts: AccountStore;
  let session: TestSession;
  let server: Server;
  let base: string;

  const post = (username: unknown) => fetch(`${base}/auth/username`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username }),
  });

  const heldName = () => accounts.findByEmail(EMAIL)?.username;

  beforeEach(async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    accounts = new AccountStore();
    vi.spyOn(accounts, 'save').mockResolvedValue();
    await accounts.createAccount(EMAIL);
    await accounts.createAccount(OTHER_EMAIL);
    session = sessionFor(EMAIL);

    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      req.session = session as unknown as typeof req.session;
      next();
    });
    app.use('/auth', createAuthRoutes({
      accountStore: accounts,
      tokenStore: {} as TokenStore,
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
  });

  describe('first choice', () => {
    it('sets the name on the account and the session', async () => {
      const res = await post('alice');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, username: 'alice', oldUsername: null });
      expect(heldName()).toBe('alice');
      expect(session.username).toBe('alice');
      expect(session.save).toHaveBeenCalledOnce();
    });

    it('refuses a name another account holds, in any case', async () => {
      await accounts.setUsername(OTHER_EMAIL, 'alice');

      const res = await post('ALICE');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Username is already taken' });
      expect(heldName()).toBeNull();
    });

    it('lets only one of two requests sent together through', async () => {
      const responses = await Promise.all([post('first'), post('second')]);

      expect(responses.map(res => res.status).sort()).toEqual([200, 409]);
      const winner = await responses.find(res => res.status === 200)!.json() as { username: string };
      expect(heldName()).toBe(winner.username);
      expect(session.username).toBe(winner.username);
    });
  });

  describe('once a name is chosen', () => {
    beforeEach(async () => {
      await accounts.setUsername(EMAIL, 'alice');
      session.username = 'alice';
    });

    it('refuses a different name and changes nothing', async () => {
      const res = await post('bob');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Your username can\'t be changed' });
      expect(heldName()).toBe('alice');
      expect(accounts.findByUsername('bob')).toBeNull();
      expect(session.username).toBe('alice');
      expect(session.save).not.toHaveBeenCalled();
    });

    it('refuses a change of case', async () => {
      const res = await post('Alice');

      expect(res.status).toBe(409);
      expect(heldName()).toBe('alice');
    });

    it('keeps the name out of reach of other accounts after a refused change', async () => {
      await post('bob');
      session = sessionFor(OTHER_EMAIL);

      const res = await post('alice');

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'Username is already taken' });
    });

    it('succeeds when the current name is sent again, and fills in a session without one', async () => {
      delete session.username;

      const res = await post('  alice ');

      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true, username: 'alice', oldUsername: 'alice' });
      expect(heldName()).toBe('alice');
      expect(session.username).toBe('alice');
    });

    it('reports an invalid name as invalid rather than as a refused change', async () => {
      const res = await post('not a name!');

      expect(res.status).toBe(400);
      expect(heldName()).toBe('alice');
    });
  });

  it('requires a signed-in session', async () => {
    session = sessionFor();

    const res = await post('alice');

    expect(res.status).toBe(401);
    expect(heldName()).toBeNull();
  });
});
