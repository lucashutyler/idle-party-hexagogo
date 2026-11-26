import type { NotificationEntry } from '@idle-party-rpg/shared';
import { sendNotificationEmail } from '../../auth/EmailService.js';
import type { NotificationChannelDriver, NotificationDeliveryContext } from './NotificationService.js';

const DM_EMAIL_BODY = 'You have a new direct message. Open the game to read it.';

/** What an email says for `entry`: a direct message's own text never leaves the game. */
function emailBodyFor(entry: NotificationEntry): string {
  return entry.eventKey === 'dm_received' ? DM_EMAIL_BODY : entry.body;
}

/** Sends via the account's verified login email (reuses the SES-backed EmailService). */
export class EmailNotificationDriver implements NotificationChannelDriver {
  readonly channel = 'email' as const;

  constructor(private getEmail: (username: string) => string | null) {}

  async deliver(ctx: NotificationDeliveryContext): Promise<void> {
    const email = this.getEmail(ctx.username);
    if (!email) return;
    try {
      await sendNotificationEmail(email, ctx.entry.title, emailBodyFor(ctx.entry));
    } catch (err) {
      console.error(`[EmailNotificationDriver] send failed for ${ctx.username}:`, err);
    }
  }
}
