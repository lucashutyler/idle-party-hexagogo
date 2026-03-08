import { randomBytes } from 'crypto';

interface PendingToken {
  email: string;
  loginId: string;
  expiresAt: number;
}

interface PendingLogin {
  email: string;
  approved: boolean;
  expiresAt: number;
}

export interface LoginStatus {
  status: 'pending' | 'approved' | 'expired';
  email?: string;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class TokenStore {
  private tokens = new Map<string, PendingToken>();
  private pendingLogins = new Map<string, PendingLogin>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
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
    if (!entry) return null;

    // Always consume the token (one-time use)
    this.tokens.delete(token);

    if (Date.now() > entry.expiresAt) return null;
    return entry.email;
  }

  /** Prod mode: create a token + loginId pair for the approve/poll flow */
  createLogin(email: string): { token: string; loginId: string } {
    const token = randomBytes(32).toString('hex');
    const loginId = randomBytes(32).toString('hex');
    const normalizedEmail = email.toLowerCase();
    const expiresAt = Date.now() + TOKEN_TTL_MS;

    this.tokens.set(token, { email: normalizedEmail, loginId, expiresAt });
    this.pendingLogins.set(loginId, { email: normalizedEmail, approved: false, expiresAt });

    return { token, loginId };
  }

  /** Approve a login via magic link token (consumes the token, marks login approved) */
  approve(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;

    this.tokens.delete(token);

    if (Date.now() > entry.expiresAt) return null;

    const login = this.pendingLogins.get(entry.loginId);
    if (login) {
      login.approved = true;
    }

    return entry.email;
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
    if (removed > 0) {
      console.log(`[TokenStore] Cleaned up ${removed} expired entries`);
    }
  }
}
