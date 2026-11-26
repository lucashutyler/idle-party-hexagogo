import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ApproveResult } from '../src/network/AuthClient';

const approveLogin = vi.hoisted(() => vi.fn<(token: string) => Promise<ApproveResult>>());
vi.mock('../src/network/AuthClient', () => ({ approveLogin }));

import { ApproveScreen } from '../src/screens/ApproveScreen';

async function openLink(result: ApproveResult | Error) {
  document.body.innerHTML = '<div id="screen-approve"></div>';
  window.history.replaceState(null, '', '/approve?token=abc123');
  if (result instanceof Error) approveLogin.mockRejectedValue(result);
  else approveLogin.mockResolvedValue(result);

  const screen = new ApproveScreen('screen-approve');
  screen.onActivate();
  await vi.waitFor(() => expect(document.querySelector('.verify-message')!.textContent).not.toBe('Approving sign-in...'));

  const q = (selector: string) => document.querySelector<HTMLElement>(selector)!;
  return {
    message: q('.verify-message').textContent,
    hint: q('.approve-close-hint'),
    error: q('.login-error'),
    back: q('.verify-back-link'),
  };
}

describe('ApproveScreen', () => {
  beforeEach(() => {
    approveLogin.mockReset();
  });

  it('sends the link token once and clears it from the address bar', async () => {
    await openLink({ success: true });

    expect(approveLogin).toHaveBeenCalledOnce();
    expect(approveLogin).toHaveBeenCalledWith('abc123');
    expect(window.location.search).toBe('');
  });

  it('confirms an approved sign-in and points back to the asking tab', async () => {
    const view = await openLink({ success: true });

    expect(view.message).toBe('Sign in approved!');
    expect(view.hint.style.display).toBe('block');
    expect(view.hint.textContent).toBe('Go back to the tab where you asked to sign in. You can close this one.');
    expect(view.back.style.display).toBe('none');
  });

  it('asks for the code when the link was opened somewhere else', async () => {
    const view = await openLink({ needsCode: true });

    expect(view.message).toBe('Almost there.');
    expect(view.hint.style.display).toBe('block');
    expect(view.hint.textContent).toBe(
      'Type the 6-digit code from this email on the screen where you asked to sign in. If you didn\'t ask, ignore the email.',
    );
    expect(view.error.style.display).toBe('none');
  });

  it('shows the server error for a dead link with a way back', async () => {
    const view = await openLink({ error: 'Invalid or expired sign-in link. Please request a new one.' });

    expect(view.message).toBe('Sign-in failed');
    expect(view.error.textContent).toBe('Invalid or expired sign-in link. Please request a new one.');
    expect(view.error.style.display).toBe('block');
    expect(view.back.style.display).toBe('inline-block');
  });

  it('says so when the server cannot be reached', async () => {
    const view = await openLink(new Error('offline'));

    expect(view.message).toBe('Sign-in failed');
    expect(view.error.textContent).toBe('Could not connect to server.');
  });
});
