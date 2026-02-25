import { randomBytes } from 'crypto';

interface PendingToken {
  email: string;
  expiresAt: number;
}

const TOKEN_TTL_MS = 15 * 60 * 1000; // 15 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

export class TokenStore {
  private tokens = new Map<string, PendingToken>();
  private cleanupTimer?: ReturnType<typeof setInterval>;

  start(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL_MS);
  }

  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
  }

  create(email: string): string {
    const token = randomBytes(32).toString('hex');
    this.tokens.set(token, {
      email: email.toLowerCase(),
      expiresAt: Date.now() + TOKEN_TTL_MS,
    });
    return token;
  }

  verify(token: string): string | null {
    const entry = this.tokens.get(token);
    if (!entry) return null;

    // Always consume the token (one-time use)
    this.tokens.delete(token);

    if (Date.now() > entry.expiresAt) return null;
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
    if (removed > 0) {
      console.log(`[TokenStore] Cleaned up ${removed} expired tokens`);
    }
  }
}
