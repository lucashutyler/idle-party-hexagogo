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
  constructor(
    private getPreferences: (username: string) => NotificationPreferences | undefined,
    private drivers: NotificationChannelDriver[],
  ) {}

  notify(username: string, eventKey: string, vars: NotifyVars): void {
    const def = getNotificationEventDefinition(eventKey);
    if (!def) {
      console.warn(`[NotificationService] Unknown eventKey "${eventKey}" — skipping`);
      return;
    }

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
}
