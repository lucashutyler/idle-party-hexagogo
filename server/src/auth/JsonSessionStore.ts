import session from 'express-session';
import { readFile, writeFile, rename, readdir, mkdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const REAP_INTERVAL = 10 * 60 * 1000; // 10 minutes

/**
 * File-backed express-session store.
 * One JSON file per session: <dir>/<sid>.json
 *
 * Uses atomic writes (write to .tmp, then rename) to prevent
 * corruption if the process is killed mid-write.
 *
 * Extends express-session's Store class — the standard swappable interface.
 * Can be replaced with a PostgresSessionStore without changing consumers.
 */
export class JsonSessionStore extends session.Store {
  private dir: string;
  private reapTimer?: ReturnType<typeof setInterval>;

  constructor(dir: string) {
    super();
    this.dir = dir;
  }

  // --- express-session Store interface ---

  get(sid: string, callback: (err?: any, session?: session.SessionData | null) => void): void {
    this.readSession(sid)
      .then((data) => callback(null, data))
      .catch((err) => callback(err));
  }

  set(sid: string, sessionData: session.SessionData, callback?: (err?: any) => void): void {
    this.writeSession(sid, sessionData)
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  destroy(sid: string, callback?: (err?: any) => void): void {
    this.deleteSession(sid)
      .then(() => callback?.())
      .catch((err) => callback?.(err));
  }

  touch(sid: string, sessionData: session.SessionData, callback?: () => void): void {
    // Update the session file with the new cookie expiry
    this.writeSession(sid, sessionData)
      .then(() => callback?.())
      .catch(() => callback?.());
  }

  // --- Reap (expired session cleanup) ---

  startReap(): void {
    if (this.reapTimer) return;
    this.reapTimer = setInterval(() => {
      this.reapExpired().catch((err) => {
        console.error('[JsonSessionStore] Reap error:', err);
      });
    }, REAP_INTERVAL);
    // Don't prevent Node from exiting
    this.reapTimer.unref();
  }

  stopReap(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = undefined;
    }
  }

  // --- Internal ---

  private filePath(sid: string): string {
    // Sanitize sid to prevent directory traversal
    const safe = sid.replace(/[^a-zA-Z0-9_-]/g, '_');
    return join(this.dir, `${safe}.json`);
  }

  private async ensureDir(): Promise<void> {
    if (!existsSync(this.dir)) {
      await mkdir(this.dir, { recursive: true });
    }
  }

  private async readSession(sid: string): Promise<session.SessionData | null> {
    const path = this.filePath(sid);
    if (!existsSync(path)) return null;

    try {
      const raw = await readFile(path, 'utf-8');
      if (!raw.trim()) return null;

      const data = JSON.parse(raw) as session.SessionData;

      // Check expiry
      if (data.cookie?.expires) {
        const expires = new Date(data.cookie.expires);
        if (expires.getTime() <= Date.now()) {
          // Expired — delete and return null
          await this.deleteSession(sid);
          return null;
        }
      }

      return data;
    } catch {
      console.error(`[JsonSessionStore] Failed to read session "${sid}"`);
      return null;
    }
  }

  private async writeSession(sid: string, data: session.SessionData): Promise<void> {
    await this.ensureDir();
    const json = JSON.stringify(data, null, 2);
    const target = this.filePath(sid);
    const tmp = `${target}.tmp`;
    await writeFile(tmp, json, 'utf-8');
    await rename(tmp, target);
  }

  private async deleteSession(sid: string): Promise<void> {
    const path = this.filePath(sid);
    if (existsSync(path)) {
      await unlink(path);
    }
  }

  private async reapExpired(): Promise<void> {
    await this.ensureDir();
    const files = await readdir(this.dir);
    const jsonFiles = files.filter(f => f.endsWith('.json') && !f.endsWith('.tmp'));
    let reaped = 0;

    for (const file of jsonFiles) {
      const path = join(this.dir, file);
      try {
        const raw = await readFile(path, 'utf-8');
        if (!raw.trim()) {
          await unlink(path);
          reaped++;
          continue;
        }
        const data = JSON.parse(raw) as session.SessionData;
        if (data.cookie?.expires) {
          const expires = new Date(data.cookie.expires);
          if (expires.getTime() <= Date.now()) {
            await unlink(path);
            reaped++;
          }
        }
      } catch {
        // Corrupt file — remove it
        try { await unlink(path); } catch { /* ignore */ }
        reaped++;
      }
    }

    if (reaped > 0) {
      console.log(`[JsonSessionStore] Reaped ${reaped} expired session(s)`);
    }
  }
}
