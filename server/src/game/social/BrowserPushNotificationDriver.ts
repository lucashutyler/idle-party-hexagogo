import webpush from 'web-push';
import type { WebPushSubscription } from '@idle-party-rpg/shared';
import type { NotificationChannelDriver, NotificationDeliveryContext } from './NotificationService.js';

let configured = false;
let warnedMissingConfig = false;

function ensureConfigured(): boolean {
  if (configured) return true;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? 'mailto:support@idlepartyrpg.example';

  if (!publicKey || !privateKey) {
    if (!warnedMissingConfig) {
      console.warn('[BrowserPushNotificationDriver] VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY not set — browser push disabled');
      warnedMissingConfig = true;
    }
    return false;
  }

  webpush.setVapidDetails(subject, publicKey, privateKey);
  configured = true;
  return true;
}

/** Returns the public VAPID key clients need to call pushManager.subscribe(), or null if push isn't configured. */
export function getVapidPublicKey(): string | null {
  if (!ensureConfigured()) return null;
  return process.env.VAPID_PUBLIC_KEY ?? null;
}

/** Sends via the Web Push protocol (VAPID). Prunes expired/invalid subscriptions on 404/410. */
export class BrowserPushNotificationDriver implements NotificationChannelDriver {
  readonly channel = 'browser_push' as const;

  constructor(
    private getSubscriptions: (username: string) => WebPushSubscription[],
    private removeSubscription: (username: string, endpoint: string) => void,
  ) {}

  async deliver(ctx: NotificationDeliveryContext): Promise<void> {
    if (!ensureConfigured()) return;

    const subscriptions = this.getSubscriptions(ctx.username);
    const payload = JSON.stringify({
      title: ctx.entry.title,
      body: ctx.entry.body,
      payload: ctx.entry.payload,
    });

    await Promise.all(subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub as unknown as webpush.PushSubscription, payload);
      } catch (err) {
        const statusCode = (err as { statusCode?: number }).statusCode;
        if (statusCode === 404 || statusCode === 410) {
          this.removeSubscription(ctx.username, sub.endpoint);
        } else {
          console.error(`[BrowserPushNotificationDriver] send failed for ${ctx.username}:`, err);
        }
      }
    }));
  }
}
