import { pollLoginStatus, submitLoginCode } from './AuthClient';
import type { LoginStatusResult } from './AuthClient';

export const LOGIN_POLL_INTERVAL_MS = 2000;
const CODE_REFUSED = 'That code didn\'t work. Please try again.';
const OFFLINE = 'Could not connect to server';

export interface EmailSignInOutcomes {
  approved(result: LoginStatusResult): Promise<void> | void;
  expired(): void;
  suspended(email: string | undefined): void;
}

/** The emailed sign-in in progress: polls for its link and posts its code. Results for a sign-in it has left are dropped. */
export class EmailSignIn {
  private loginId: string | null = null;
  private checkingCodeFor: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly outcomes: EmailSignInOutcomes) {}

  start(loginId: string): void {
    this.stop();
    this.loginId = loginId;
    this.timer = setInterval(() => { void this.poll(loginId); }, LOGIN_POLL_INTERVAL_MS);
  }

  stop(): void {
    this.loginId = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Resolves with the message to show when the code is refused, or null once the sign-in has moved on. */
  async submitCode(code: string): Promise<string | null> {
    const loginId = this.loginId;
    if (!loginId) return null;

    this.checkingCodeFor = loginId;
    try {
      const result = await submitLoginCode(loginId, code);
      if (this.loginId !== loginId) return null;
      if (await this.finish(result)) return null;
      return result.error ?? CODE_REFUSED;
    } catch {
      return this.loginId === loginId ? OFFLINE : null;
    } finally {
      if (this.checkingCodeFor === loginId) this.checkingCodeFor = null;
    }
  }

  private async poll(loginId: string): Promise<void> {
    try {
      const result = await pollLoginStatus(loginId);
      if (this.loginId !== loginId) return;
      // A right code ends the sign-in on the server before its own answer arrives.
      if (result.status === 'expired' && this.checkingCodeFor === loginId) return;
      await this.finish(result);
    } catch {
      // A failed poll just waits for the next one.
    }
  }

  /** Acts on a finished sign-in and returns true, or returns false while it is still waiting. */
  private async finish(result: LoginStatusResult): Promise<boolean> {
    if (result.deactivated) {
      this.stop();
      this.outcomes.suspended(result.email);
      return true;
    }
    if (result.status === 'approved') {
      this.stop();
      await this.outcomes.approved(result);
      return true;
    }
    if (result.status === 'expired') {
      this.stop();
      this.outcomes.expired();
      return true;
    }
    return false;
  }
}
