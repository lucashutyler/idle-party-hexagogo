import { sendNotificationEmail } from '../../auth/EmailService.js';
import type { NotificationChannelDriver, NotificationDeliveryContext } from './NotificationService.js';

/** Sends via the account's verified login email (reuses the SES-backed EmailService). */
export class EmailNotificationDriver implements NotificationChannelDriver {
  readonly channel = 'email' as const;

  constructor(private getEmail: (username: string) => string | null) {}

  async deliver(ctx: NotificationDeliveryContext): Promise<void> {
    const email = this.getEmail(ctx.username);
    if (!email) return;
    try {
      await sendNotificationEmail(email, ctx.entry.title, ctx.entry.body);
    } catch (err) {
      console.error(`[EmailNotificationDriver] send failed for ${ctx.username}:`, err);
    }
  }
}
