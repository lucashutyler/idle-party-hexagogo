import { randomUUID } from 'crypto';
import { getNotificationEventDefinition } from '@idle-party-rpg/shared';
import type { NotificationChannel, NotificationEntry, NotificationPreferences } from '@idle-party-rpg/shared';

export interface NotificationDeliveryContext {
  username: string;
  entry: NotificationEntry;
}

/** Add a new delivery avenue (SMS, Discord, ...) by implementing this — no dispatcher changes needed. */
export interface NotificationChannelDriver {
  readonly channel: NotificationChannel;
  deliver(ctx: NotificationDeliveryContext): void | Promise<void>;
}

export interface NotifyVars {
  title: string;
  body: string;
  payload?: Record<string, unknown>;
}

/** Skips delivery when this recipient got the same event with the same `dedupeKey` within the last `withinMs`. */
export interface NotifyDedupe {
  dedupeKey: string;
  withinMs: number;
}

/** How long a repeat of these from the same sender stays quiet. The request or invite itself still goes through. */
export const FRIEND_REQUEST_NOTICE_WINDOW_MS = 10 * 60_000;
export const PARTY_INVITE_NOTICE_WINDOW_MS = 2 * 60_000;
export const GUILD_INVITE_NOTICE_WINDOW_MS = 10 * 60_000;

const DEDUPE_PRUNE_EVERY_MS = 60_000;

function resolveEnabledChannels(
  eventKey: string,
  defaultChannels: NotificationChannel[],
  prefs: NotificationPreferences | undefined,
): NotificationChannel[] {
  const configured = prefs?.events[eventKey] ?? defaultChannels;
  return configured.filter(ch => !prefs?.channelDisabled?.[ch]);
}

/**
 * Central dispatcher — resolves a game event to its enabled channels for the
 * recipient, persists the inbox entry, and fans out to each channel's driver.
 * This is the only place that needs to know about the registry + preferences;
 * drivers stay ignorant of each other and of the calling game system.
 */
export class NotificationService {
  /** When each deduped key stops suppressing. In memory only. */
  private dedupeUntil = new Map<string, number>();
  private lastDedupePruneAt: number;

  constructor(
    private getPreferences: (username: string) => NotificationPreferences | undefined,
    private drivers: NotificationChannelDriver[],
    private now: () => number = () => Date.now(),
  ) {
    this.lastDedupePruneAt = now();
  }

  notify(username: string, eventKey: string, vars: NotifyVars, dedupe?: NotifyDedupe): void {
    const def = getNotificationEventDefinition(eventKey);
    if (!def) {
      console.warn(`[NotificationService] Unknown eventKey "${eventKey}" — skipping`);
      return;
    }
    if (dedupe && this.isDuplicate(username, eventKey, dedupe)) return;

    const prefs = this.getPreferences(username);
    const channels = resolveEnabledChannels(eventKey, def.defaultChannels, prefs);
    if (channels.length === 0) return;

    const entry: NotificationEntry = {
      id: randomUUID(),
      category: def.category,
      eventKey,
      title: vars.title,
      body: vars.body,
      payload: vars.payload,
      createdAt: Date.now(),
      readAt: null,
    };

    for (const channel of channels) {
      const driver = this.drivers.find(d => d.channel === channel);
      if (!driver) continue;
      try {
        void driver.deliver({ username, entry });
      } catch (err) {
        console.error(`[NotificationService] driver "${channel}" failed for ${username}:`, err);
      }
    }
  }

  get dedupeKeyCount(): number {
    return this.dedupeUntil.size;
  }

  /** Records a call that isn't a duplicate, so the window runs from the last delivered one. */
  private isDuplicate(username: string, eventKey: string, { dedupeKey, withinMs }: NotifyDedupe): boolean {
    const now = this.now();
    this.pruneDedupe(now);
    const key = JSON.stringify([username, eventKey, dedupeKey]);
    const until = this.dedupeUntil.get(key);
    if (until !== undefined && now < until) return true;
    this.dedupeUntil.set(key, now + withinMs);
    return false;
  }

  private pruneDedupe(now: number): void {
    if (now - this.lastDedupePruneAt < DEDUPE_PRUNE_EVERY_MS) return;
    this.lastDedupePruneAt = now;
    for (const [key, until] of this.dedupeUntil) {
      if (until <= now) this.dedupeUntil.delete(key);
    }
  }
}
