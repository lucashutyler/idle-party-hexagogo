import { randomBytes, randomInt, timingSafeEqual } from 'crypto';

interface PendingToken {
  email: string;
  loginId: string;
  expiresAt: number;
}

interface PendingLogin {
  email: string;
  approved: boolean;
  expiresAt: number;
  code: string;
  requesterDevice: string;
  token: string;
  codeAttempts: number;
}

export interface LoginStatus {
  status: 'pending' | 'approved' | 'expired';
  email?: string;
}

export interface CreatedLogin {
  token: string;
  loginId: string;
  code: string;
}

export type LinkApproval =
  | { status: 'approved'; email: string }
  | { status: 'needs_code' }
  | { status: 'invalid' };

export type CodeResult = { email: string } | 'wrong_code' | 'expired';

interface Prunable {
  prune(): void;
}

const TOKEN_TTL_MS = 15 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;
export const MAX_CODE_ATTEMPTS = 5;
const CODE_DIGITS = 6;

function newLoginCode(): string {
  return randomInt(0, 10 ** CODE_DIGITS).toString().padStart(CODE_DIGITS, '0');
}

function codesMatch(given: string, expected: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class TokenStore {
  private tokens = new Map<string, PendingToken>();
  private pendingLogins = new Map<string, PendingLogin>();
  private prunables: Prunable[] = [];
  private cleanupTimer?: ReturnType<typeof setInterval>;

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  /** Prunes `limiter` on every cleanup tick, so idle rate-limit keys don't pile up. */
  pruneWithCleanup(limiter: Prunable): void {
    this.prunables.push(limiter);
  }

  /** Dev mode: create a simple token (no polling needed) */
  create(email: string): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, {
      email: email.toLowerCase(),
      loginId: '',
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return token;
  }

  /** Dev mode: verify and consume a token, return email */
  verify(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry || entry.loginId) return null;

    this.tokens.delete(token);

    if (Date.now() > entry.expiresAt) return null;
    return entry.email;
  }

  /**
   * Prod mode: start a sign-in for `email` from `requesterDevice`. Asking again from the same
   * device while the sign-in is still open returns the same link and code, with a fresh expiry.
   */
  createLogin(email: string, requesterDevice: string): CreatedLogin {
    const normalizedEmail = email.toLowerCase();
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    const open = this.findOpenLogin(normalizedEmail, requesterDevice);
    if (open) {
      const [loginId, login] = open;
      login.expiresAt = expiresAt;
      const token = this.tokens.get(login.token);
      if (token) token.expiresAt = expiresAt;
      return { token: login.token, loginId, code: login.code };
    }

    const token = randomBytes(32).toString('hex');
    const loginId = randomBytes(32).toString('hex');
    const code = newLoginCode();

    this.tokens.set(token, { email: normalizedEmail, loginId, expiresAt });
    this.pendingLogins.set(loginId, {
      email: normalizedEmail,
      approved: false,
      expiresAt,
      code,
      requesterDevice,
      token,
      codeAttempts: 0,
    });

    return { token, loginId, code };
  }

  /**
   * The emailed link approves the sign-in only when opened on the device that asked for it.
   * Anywhere else it approves nothing and stays usable until it expires.
   */
  approveFromLink(token: string, device: string | undefined): LinkApproval {
    const entry = this.tokens.get(token);
    if (!entry || !entry.loginId) return { status: 'invalid' };

    const login = this.pendingLogins.get(entry.loginId);
    if (Date.now() > entry.expiresAt || !login || Date.now() > login.expiresAt) {
      this.tokens.delete(token);
      return { status: 'invalid' };
    }

    if (!device || device !== login.requesterDevice) return { status: 'needs_code' };

    this.tokens.delete(token);
    login.approved = true;
    return { status: 'approved', email: entry.email };
  }

  /** Signs in with the emailed code. A match consumes the sign-in; too many misses end it. */
  submitCode(loginId: string, code: string): CodeResult {
    const login = this.pendingLogins.get(loginId);
    if (!login) return 'expired';
    if (Date.now() > login.expiresAt) {
      this.deleteLogin(loginId);
      return 'expired';
    }

    if (codesMatch(code, login.code)) {
      this.deleteLogin(loginId);
      return { email: login.email };
    }

    login.codeAttempts++;
    if (login.codeAttempts >= MAX_CODE_ATTEMPTS) {
      this.deleteLogin(loginId);
      return 'expired';
    }
    return 'wrong_code';
  }

  /** Check the status of a pending login (non-consuming, used for polling) */
  checkLogin(loginId: string): LoginStatus {
    const entry = this.pendingLogins.get(loginId);
    if (!entry) return { status: 'expired' };
    if (Date.now() > entry.expiresAt) {
      this.pendingLogins.delete(loginId);
      return { status: 'expired' };
    }
    if (entry.approved) return { status: 'approved', email: entry.email };
    return { status: 'pending' };
  }

  /** Consume an approved login (one-time, used when creating the session) */
  consumeLogin(loginId: string): string | null {
    const entry = this.pendingLogins.get(loginId);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt || !entry.approved) return null;

    this.pendingLogins.delete(loginId);
    return entry.email;
  }

  private findOpenLogin(email: string, requesterDevice: string): [string, PendingLogin] | null {
    if (!requesterDevice) return null;
    const now = Date.now();
    for (const [loginId, login] of this.pendingLogins) {
      if (login.email === email && login.requesterDevice === requesterDevice
        && !login.approved && now <= login.expiresAt) {
        return [loginId, login];
      }
    }
    return null;
  }

  private deleteLogin(loginId: string): void {
    const login = this.pendingLogins.get(loginId);
    if (!login) return;
    this.tokens.delete(login.token);
    this.pendingLogins.delete(loginId);
  }

  private cleanup(): void {
    const now = Date.now();
    let removed = 0;
    for (const [token, entry] of this.tokens) {
      if (now > entry.expiresAt) {
        this.tokens.delete(token);
        removed++;
      }
    }
    for (const [loginId, entry] of this.pendingLogins) {
      if (now > entry.expiresAt) {
        this.pendingLogins.delete(loginId);
        removed++;
      }
    }
    for (const prunable of this.prunables) prunable.prune();
    if (removed > 0) {
      console.log(`[TokenStore] Cleaned up ${removed} expired entries`);
    }
  }
}
