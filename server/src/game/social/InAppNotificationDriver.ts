import type { NotificationChannelDriver, NotificationDeliveryContext } from './NotificationService.js';
import type { NotificationSystem } from './NotificationSystem.js';

/** Persists to the inbox and pushes a live toast over any open WebSocket connections. */
export class InAppNotificationDriver implements NotificationChannelDriver {
  readonly channel = 'in_app' as const;

  constructor(
    private inbox: NotificationSystem,
    private pushLive: (username: string, ctx: NotificationDeliveryContext) => void,
  ) {}

  deliver(ctx: NotificationDeliveryContext): void {
    this.inbox.addEntry(ctx.username, ctx.entry);
    this.pushLive(ctx.username, ctx);
  }
}
