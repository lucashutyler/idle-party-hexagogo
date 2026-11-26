import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_CODE_ATTEMPTS, TokenStore } from '../src/auth/TokenStore.js';

const EMAIL = 'player@example.test';
const ASKING_DEVICE = 'device-asking';
const OTHER_DEVICE = 'device-other';
const TTL_MS = 15 * 60 * 1000;

function wrongCodeFor(code: string): string {
  return code === '000000' ? '111111' : '000000';
}

describe('TokenStore sign-in', () => {
  let store: TokenStore;

  beforeEach(() => {
    store = new TokenStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('makes a 6-digit code', () => {
    for (let i = 0; i < 50; i++) {
      const { code } = store.createLogin(`p${i}@example.test`, ASKING_DEVICE);
      expect(code).toMatch(/^\d{6}$/);
    }
  });

  it('reuses the open sign-in, code and link for a resend from the same email and device', () => {
    const first = store.createLogin(EMAIL, ASKING_DEVICE);
    const again = store.createLogin('Player@Example.test', ASKING_DEVICE);

    expect(again).toEqual(first);
  });

  it('starts a separate sign-in for another device or email', () => {
    const first = store.createLogin(EMAIL, ASKING_DEVICE);

    expect(store.createLogin(EMAIL, OTHER_DEVICE).loginId).not.toBe(first.loginId);
    expect(store.createLogin('other@example.test', ASKING_DEVICE).loginId).not.toBe(first.loginId);
  });

  it('starts a fresh sign-in once the open one is approved', () => {
    const first = store.createLogin(EMAIL, ASKING_DEVICE);
    store.approveFromLink(first.token, ASKING_DEVICE);

    expect(store.createLogin(EMAIL, ASKING_DEVICE).loginId).not.toBe(first.loginId);
  });

  describe('approveFromLink', () => {
    it('approves when opened on the device that asked', () => {
      const { token, loginId } = store.createLogin(EMAIL, ASKING_DEVICE);

      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'approved', email: EMAIL });
      expect(store.checkLogin(loginId)).toEqual({ status: 'approved', email: EMAIL });
      expect(store.consumeLogin(loginId)).toBe(EMAIL);
      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'invalid' });
    });

    it('asks for the code on any other device and leaves the sign-in pending', () => {
      const { token, loginId } = store.createLogin(EMAIL, ASKING_DEVICE);

      expect(store.approveFromLink(token, OTHER_DEVICE)).toEqual({ status: 'needs_code' });
      expect(store.approveFromLink(token, undefined)).toEqual({ status: 'needs_code' });
      expect(store.checkLogin(loginId)).toEqual({ status: 'pending' });
      expect(store.consumeLogin(loginId)).toBeNull();

      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'approved', email: EMAIL });
    });

    it('never matches a sign-in started without a device', () => {
      const { token, loginId } = store.createLogin(EMAIL, '');

      expect(store.approveFromLink(token, '')).toEqual({ status: 'needs_code' });
      expect(store.checkLogin(loginId)).toEqual({ status: 'pending' });
    });

    it('refuses an unknown token', () => {
      expect(store.approveFromLink('nope', ASKING_DEVICE)).toEqual({ status: 'invalid' });
    });
  });

  describe('submitCode', () => {
    it('returns the email once for the right code, then the sign-in is gone', () => {
      const { token, loginId, code } = store.createLogin(EMAIL, ASKING_DEVICE);

      expect(store.submitCode(loginId, code)).toEqual({ email: EMAIL });
      expect(store.submitCode(loginId, code)).toBe('expired');
      expect(store.checkLogin(loginId)).toEqual({ status: 'expired' });
      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'invalid' });
    });

    it('counts wrong codes and ends the sign-in and its link on the last allowed miss', () => {
      const { token, loginId, code } = store.createLogin(EMAIL, ASKING_DEVICE);
      const wrong = wrongCodeFor(code);

      for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) {
        expect(store.submitCode(loginId, wrong)).toBe('wrong_code');
      }
      expect(store.checkLogin(loginId)).toEqual({ status: 'pending' });

      expect(store.submitCode(loginId, wrong)).toBe('expired');
      expect(store.submitCode(loginId, code)).toBe('expired');
      expect(store.checkLogin(loginId)).toEqual({ status: 'expired' });
      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'invalid' });
    });

    it('keeps counting wrong codes across a resend', () => {
      const { loginId, code } = store.createLogin(EMAIL, ASKING_DEVICE);
      const wrong = wrongCodeFor(code);
      for (let i = 1; i < MAX_CODE_ATTEMPTS; i++) store.submitCode(loginId, wrong);

      expect(store.createLogin(EMAIL, ASKING_DEVICE).loginId).toBe(loginId);

      expect(store.submitCode(loginId, wrong)).toBe('expired');
      expect(store.createLogin(EMAIL, ASKING_DEVICE).loginId).not.toBe(loginId);
    });

    it('treats a code of the wrong length as wrong', () => {
      const { loginId, code } = store.createLogin(EMAIL, ASKING_DEVICE);

      expect(store.submitCode(loginId, code.slice(1))).toBe('wrong_code');
      expect(store.submitCode(loginId, `${code}0`)).toBe('wrong_code');
      expect(store.submitCode(loginId, code)).toEqual({ email: EMAIL });
    });

    it('does not know an unknown loginId', () => {
      expect(store.submitCode('nope', '123456')).toBe('expired');
    });
  });

  describe('expiry', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    });

    it('expires the code, the link and the poll after 15 minutes', () => {
      const first = store.createLogin(EMAIL, ASKING_DEVICE);
      const second = store.createLogin('other@example.test', ASKING_DEVICE);

      vi.advanceTimersByTime(TTL_MS + 1);

      expect(store.checkLogin(first.loginId)).toEqual({ status: 'expired' });
      expect(store.submitCode(second.loginId, second.code)).toBe('expired');
      expect(store.approveFromLink(first.token, ASKING_DEVICE)).toEqual({ status: 'invalid' });
    });

    it('gives a resend a fresh 15 minutes with the same code', () => {
      const first = store.createLogin(EMAIL, ASKING_DEVICE);
      vi.advanceTimersByTime(TTL_MS - 1000);

      const again = store.createLogin(EMAIL, ASKING_DEVICE);
      vi.advanceTimersByTime(TTL_MS - 1000);

      expect(again.code).toBe(first.code);
      expect(store.approveFromLink(again.token, ASKING_DEVICE)).toEqual({ status: 'approved', email: EMAIL });
    });

    it('starts a new sign-in after the old one expired', () => {
      const first = store.createLogin(EMAIL, ASKING_DEVICE);
      vi.advanceTimersByTime(TTL_MS + 1);

      expect(store.createLogin(EMAIL, ASKING_DEVICE).loginId).not.toBe(first.loginId);
    });

    it('prunes registered limiters on the cleanup tick', () => {
      const limiter = { prune: vi.fn() };
      store.pruneWithCleanup(limiter);
      store.start();

      vi.advanceTimersByTime(5 * 60 * 1000);
      store.stop();

      expect(limiter.prune).toHaveBeenCalledOnce();
    });
  });

  describe('dev tokens', () => {
    it('verify takes a dev token once and ignores sign-in link tokens', () => {
      const devToken = store.create(EMAIL);
      const { token } = store.createLogin(EMAIL, ASKING_DEVICE);

      expect(store.verify(token)).toBeNull();
      expect(store.verify(devToken)).toBe(EMAIL);
      expect(store.verify(devToken)).toBeNull();
      expect(store.approveFromLink(token, ASKING_DEVICE)).toEqual({ status: 'approved', email: EMAIL });
    });
  });
});
