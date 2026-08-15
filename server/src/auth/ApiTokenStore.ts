import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { createHash, randomBytes, randomUUID } from 'crypto';

const DATA_DIR = path.resolve('data');
const API_TOKENS_FILE = path.join(DATA_DIR, 'api-tokens.json');

/** Every generated secret starts with this, so a leaked string is recognisable as one of ours. */
export const API_TOKEN_PREFIX = 'ipr_';
/** How much of the secret is kept in the clear, purely so a row is identifiable in the UI. */
const DISPLAY_CHARS = 8;
/** lastUsedAt is tracked in memory and flushed on a timer — a disk write per request would be silly. */
const FLUSH_INTERVAL_MS = 60 * 1000;

export interface ApiTokenRecord {
  id: string;
  /** Owner's account email, lowercase. Authorization is re-derived from this on every use. */
  email: string;
  label: string;
  /** sha256 of the secret. The secret is shown once at creation and never stored. */
  tokenHash: string;
  /** Leading characters of the secret ("ipr_a1b2c3d4"), for identifying a row in the UI. */
  prefix: string;
  createdAt: string;
  /** ISO timestamp, or null for a token that never expires. */
  expiresAt: string | null;
  lastUsedAt: string | null;
}

export function hashApiToken(token: string): string {
  return createHash('sha256').update(token, 'utf-8').digest('hex');
}

/** Unparseable expiry counts as expired — a corrupt record must never grant access. */
export function isApiTokenExpired(record: ApiTokenRecord, now: number = Date.now()): boolean {
  if (!record.expiresAt) return false;
  const expiry = Date.parse(record.expiresAt);
  return Number.isNaN(expiry) || expiry <= now;
}

/**
 * Persists user-generated API tokens to data/api-tokens.json. Tokens authenticate the MCP
 * endpoint and the REST admin API; they carry no permissions of their own — the owner's admin
 * role is looked up fresh on every request (see AdminRoles.ts), so a token belonging to someone
 * who is no longer an admin is inert without needing to be deleted.
 */
export class ApiTokenStore {
  private tokens = new Map<string, ApiTokenRecord>();
  /** tokenHash -> id, so authenticating a request is a single hash + map lookup. */
  private byHash = new Map<string, string>();
  private dirty = false;
  private flushTimer?: ReturnType<typeof setInterval>;
  /**
   * Serializes writes. Unlike the other stores, this one is written both by request handlers and
   * by a background timer, so two `save()` calls really can overlap — and they'd race on the shared
   * `.tmp` path, one `rename` winning and the other rejecting ENOENT (fatal from the timer's
   * unawaited call). Chaining them means at most one write is ever in flight.
   */
  private writeQueue: Promise<void> = Promise.resolve();

  async load(): Promise<void> {
    if (!existsSync(API_TOKENS_FILE)) {
      this.reset([]);
      return;
    }
    try {
      const raw = await readFile(API_TOKENS_FILE, 'utf-8');
      const arr = JSON.parse(raw) as ApiTokenRecord[];
      this.reset(Array.isArray(arr) ? arr : []);
      console.log(`[ApiTokenStore] Loaded ${this.tokens.size} API tokens`);
    } catch (err) {
      console.error('[ApiTokenStore] Failed to load API tokens:', err);
      this.reset([]);
    }
  }

  /** Starts the periodic lastUsedAt flush. Mirrors TokenStore.start()/stop(). */
  startFlush(): void {
    this.flushTimer = setInterval(() => {
      // Nothing awaits this, so an unhandled rejection here would take the process down.
      if (this.dirty) void this.save().catch(err => console.error('[ApiTokenStore] Failed to flush:', err));
    }, FLUSH_INTERVAL_MS);
    this.flushTimer.unref();
  }

  /** Stops the timer and persists anything the last tick didn't catch. Awaited on shutdown. */
  async stopFlush(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (!this.dirty) return;
    try {
      await this.save();
    } catch (err) {
      // Losing a lastUsedAt stamp must never block or crash shutdown.
      console.error('[ApiTokenStore] Failed to flush on shutdown:', err);
    }
  }

  /** Every token owned by an email, newest first. Never includes the secret. */
  listForEmail(email: string): ApiTokenRecord[] {
    const key = email.toLowerCase();
    return Array.from(this.tokens.values())
      .filter(t => t.email === key)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Resolves a presented secret to its record. Expiry and owner role are the caller's job. */
  findByToken(token: string): ApiTokenRecord | null {
    const id = this.byHash.get(hashApiToken(token.trim()));
    return id ? this.tokens.get(id) ?? null : null;
  }

  findById(id: string): ApiTokenRecord | null {
    return this.tokens.get(id) ?? null;
  }

  /** Mints a token. The plaintext secret is returned once here and is unrecoverable afterwards. */
  async create(email: string, label: string, expiresAt: string | null): Promise<{ record: ApiTokenRecord; token: string }> {
    const token = API_TOKEN_PREFIX + randomBytes(32).toString('hex');
    const record: ApiTokenRecord = {
      id: randomUUID(),
      email: email.toLowerCase(),
      label,
      tokenHash: hashApiToken(token),
      prefix: token.slice(0, API_TOKEN_PREFIX.length + DISPLAY_CHARS),
      createdAt: new Date().toISOString(),
      expiresAt,
      lastUsedAt: null,
    };
    this.tokens.set(record.id, record);
    this.byHash.set(record.tokenHash, record.id);
    await this.save();
    console.log(`[ApiTokenStore] Created token "${label}" for "${record.email}"`);
    return { record, token };
  }

  /**
   * Deletes a token. Scoped by owner email so one admin can never revoke another's token
   * by guessing an id. Returns false when there is nothing to revoke.
   */
  async revoke(id: string, email: string): Promise<boolean> {
    const record = this.tokens.get(id);
    if (!record || record.email !== email.toLowerCase()) return false;
    this.tokens.delete(id);
    this.byHash.delete(record.tokenHash);
    await this.save();
    console.log(`[ApiTokenStore] Revoked token "${record.label}" for "${record.email}"`);
    return true;
  }

  /** Removes every token owned by an email. Not wired to anything today; here for account deletion. */
  async revokeAllForEmail(email: string): Promise<number> {
    const owned = this.listForEmail(email);
    for (const record of owned) {
      this.tokens.delete(record.id);
      this.byHash.delete(record.tokenHash);
    }
    if (owned.length > 0) await this.save();
    return owned.length;
  }

  /** Records a use in memory. Persisted by the flush timer, not synchronously. */
  markUsed(id: string): void {
    const record = this.tokens.get(id);
    if (!record) return;
    record.lastUsedAt = new Date().toISOString();
    this.dirty = true;
  }

  private reset(records: ApiTokenRecord[]): void {
    this.tokens = new Map(records.filter(r => r?.id && r?.tokenHash).map(r => [r.id, r]));
    this.byHash = new Map(Array.from(this.tokens.values()).map(r => [r.tokenHash, r.id]));
    this.dirty = false;
  }

  private save(): Promise<void> {
    this.dirty = false;
    // Tail-chain onto whatever is already writing, swallowing a predecessor's failure so one bad
    // write doesn't poison every later save.
    this.writeQueue = this.writeQueue.then(() => this.writeNow(), () => this.writeNow());
    return this.writeQueue;
  }

  private async writeNow(): Promise<void> {
    await mkdir(DATA_DIR, { recursive: true });
    const tmp = API_TOKENS_FILE + '.tmp';
    await writeFile(tmp, JSON.stringify(Array.from(this.tokens.values()), null, 2), 'utf-8');
    await rename(tmp, API_TOKENS_FILE);
  }
}
