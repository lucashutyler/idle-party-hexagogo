import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoginStatusResult } from '../src/network/AuthClient';

const pollLoginStatus = vi.hoisted(() => vi.fn<(loginId: string) => Promise<LoginStatusResult>>());
const submitLoginCode = vi.hoisted(() => vi.fn<(loginId: string, code: string) => Promise<LoginStatusResult>>());
vi.mock('../src/network/AuthClient', () => ({ pollLoginStatus, submitLoginCode }));

import { EmailSignIn, LOGIN_POLL_INTERVAL_MS } from '../src/network/EmailSignIn';

const APPROVED: LoginStatusResult = { status: 'approved', email: 'me@example.test', username: 'me' };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function mount() {
  const outcomes = { approved: vi.fn(), expired: vi.fn(), suspended: vi.fn() };
  const signIn = new EmailSignIn(outcomes);
  return { outcomes, signIn };
}

const tick = () => vi.advanceTimersByTimeAsync(LOGIN_POLL_INTERVAL_MS);

describe('EmailSignIn', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pollLoginStatus.mockReset();
    submitLoginCode.mockReset();
    pollLoginStatus.mockResolvedValue({ status: 'pending' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('polling', () => {
    it('enters once the link is opened in this browser, then stops polling', async () => {
      const { outcomes, signIn } = mount();
      signIn.start('L1');
      await tick();
      expect(pollLoginStatus).toHaveBeenCalledWith('L1');

      pollLoginStatus.mockResolvedValue(APPROVED);
      await tick();
      await tick();

      expect(outcomes.approved).toHaveBeenCalledOnce();
      expect(outcomes.approved).toHaveBeenCalledWith(APPROVED);
      expect(pollLoginStatus).toHaveBeenCalledTimes(2);
    });

    it('reports an expired sign-in', async () => {
      const { outcomes, signIn } = mount();
      pollLoginStatus.mockResolvedValue({ status: 'expired' });
      signIn.start('L1');

      await tick();

      expect(outcomes.expired).toHaveBeenCalledOnce();
    });

    it('sends a suspended account to the suspension screen', async () => {
      const { outcomes, signIn } = mount();
      pollLoginStatus.mockResolvedValue({ error: 'Account suspended', deactivated: true, email: 'me@example.test' } as LoginStatusResult);
      signIn.start('L1');

      await tick();

      expect(outcomes.suspended).toHaveBeenCalledWith('me@example.test');
      expect(outcomes.approved).not.toHaveBeenCalled();
    });

    it('keeps polling through a network error', async () => {
      const { outcomes, signIn } = mount();
      pollLoginStatus.mockRejectedValueOnce(new Error('offline')).mockResolvedValue(APPROVED);
      signIn.start('L1');

      await tick();
      await tick();

      expect(outcomes.approved).toHaveBeenCalledOnce();
    });

    it('drops a poll answer for a sign-in it has left', async () => {
      const { outcomes, signIn } = mount();
      const answer = deferred<LoginStatusResult>();
      pollLoginStatus.mockReturnValueOnce(answer.promise);
      signIn.start('L1');
      await tick();

      signIn.stop();
      answer.resolve({ status: 'expired' });
      await vi.advanceTimersByTimeAsync(0);

      expect(outcomes.expired).not.toHaveBeenCalled();
    });
  });

  describe('submitCode', () => {
    it('enters with the right code', async () => {
      const { outcomes, signIn } = mount();
      submitLoginCode.mockResolvedValue(APPROVED);
      signIn.start('L1');

      expect(await signIn.submitCode('123456')).toBeNull();

      expect(submitLoginCode).toHaveBeenCalledWith('L1', '123456');
      expect(outcomes.approved).toHaveBeenCalledWith(APPROVED);
      await tick();
      expect(pollLoginStatus).not.toHaveBeenCalled();
    });

    it('returns the refusal for a wrong code and keeps waiting', async () => {
      const { outcomes, signIn } = mount();
      submitLoginCode.mockResolvedValue({ status: 'pending', error: 'That code doesn\'t match the newest sign-in email.' });
      signIn.start('L1');

      expect(await signIn.submitCode('000000')).toBe('That code doesn\'t match the newest sign-in email.');

      await tick();
      expect(pollLoginStatus).toHaveBeenCalledOnce();
      expect(outcomes.expired).not.toHaveBeenCalled();
    });

    it('reports a sign-in ended by too many wrong codes', async () => {
      const { outcomes, signIn } = mount();
      submitLoginCode.mockResolvedValue({ status: 'expired' });
      signIn.start('L1');

      expect(await signIn.submitCode('000000')).toBeNull();

      expect(outcomes.expired).toHaveBeenCalledOnce();
    });

    it('says so when the server cannot be reached', async () => {
      const { signIn } = mount();
      submitLoginCode.mockRejectedValue(new Error('offline'));
      signIn.start('L1');

      expect(await signIn.submitCode('123456')).toBe('Could not connect to server');
    });

    it('lets the code decide when a poll lands while it is being checked', async () => {
      const { outcomes, signIn } = mount();
      const answer = deferred<LoginStatusResult>();
      submitLoginCode.mockReturnValue(answer.promise);
      pollLoginStatus.mockResolvedValue({ status: 'expired' });
      signIn.start('L1');

      const refusal = signIn.submitCode('123456');
      await tick();
      answer.resolve(APPROVED);

      expect(await refusal).toBeNull();
      expect(outcomes.expired).not.toHaveBeenCalled();
      expect(outcomes.approved).toHaveBeenCalledWith(APPROVED);
    });

    it('ends the sign-in on the next poll when the code request itself failed', async () => {
      const { outcomes, signIn } = mount();
      const answer = deferred<LoginStatusResult>();
      submitLoginCode.mockReturnValue(answer.promise);
      pollLoginStatus.mockResolvedValue({ status: 'expired' });
      signIn.start('L1');

      const refusal = signIn.submitCode('123456');
      answer.reject(new Error('offline'));
      expect(await refusal).toBe('Could not connect to server');

      await tick();
      expect(outcomes.expired).toHaveBeenCalledOnce();
    });

    it('drops a code answer for a sign-in it has left', async () => {
      const { outcomes, signIn } = mount();
      const answer = deferred<LoginStatusResult>();
      submitLoginCode.mockReturnValue(answer.promise);
      signIn.start('L1');

      const refusal = signIn.submitCode('123456');
      signIn.start('L2');
      answer.resolve(APPROVED);

      expect(await refusal).toBeNull();
      expect(outcomes.approved).not.toHaveBeenCalled();
    });

    it('does nothing without a sign-in in progress', async () => {
      const { signIn } = mount();

      expect(await signIn.submitCode('123456')).toBeNull();
      expect(submitLoginCode).not.toHaveBeenCalled();
    });
  });
});
