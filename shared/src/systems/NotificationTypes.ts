// --- Notification framework ---
//
// Pluggable by design: a new notification *type* is one entry in
// NOTIFICATION_EVENT_REGISTRY plus a `notify()` call at the game-event site.
// A new delivery *channel* is one NotificationChannelDriver implementation on
// the server — nothing here needs to change for either addition.

export type NotificationCategory =
  | 'party'
  | 'guild'
  | 'guild_combat'
  | 'dm'
  | 'friend'
  | 'trade'
  | 'world_event'
  | 'quest'
  | 'system';

export type NotificationChannel = 'in_app' | 'browser_push' | 'email';

export const ALL_NOTIFICATION_CHANNELS: NotificationChannel[] = ['in_app', 'browser_push', 'email'];

export interface NotificationCategoryMeta {
  category: NotificationCategory;
  label: string;
}

export const NOTIFICATION_CATEGORY_META: NotificationCategoryMeta[] = [
  { category: 'party', label: 'Party' },
  { category: 'guild', label: 'Guild' },
  { category: 'guild_combat', label: 'Guild Combat' },
  { category: 'dm', label: 'Direct Messages' },
  { category: 'friend', label: 'Friends' },
  { category: 'trade', label: 'Trades' },
  { category: 'world_event', label: 'World Events' },
  { category: 'quest', label: 'Quests' },
  { category: 'system', label: 'System' },
];

export interface NotificationEventDefinition {
  eventKey: string;
  category: NotificationCategory;
  label: string;
  /** Channels enabled the first time a player sees this event — only in_app is ever on by default. */
  defaultChannels: NotificationChannel[];
}

/** Every notification the server can currently emit. Add an entry here + a notify() call to add a new type. */
export const NOTIFICATION_EVENT_REGISTRY: NotificationEventDefinition[] = [
  { eventKey: 'party_invite_received', category: 'party', label: 'Party invite received', defaultChannels: ['in_app'] },
  { eventKey: 'party_kicked', category: 'party', label: 'Removed from party', defaultChannels: ['in_app'] },
  { eventKey: 'party_promoted', category: 'party', label: 'Promoted to party leader', defaultChannels: ['in_app'] },
  { eventKey: 'party_demoted', category: 'party', label: 'Demoted from party leader', defaultChannels: ['in_app'] },
  { eventKey: 'party_ownership_transferred', category: 'party', label: 'Became party owner', defaultChannels: ['in_app'] },
  { eventKey: 'party_member_joined', category: 'party', label: 'Member joined your party', defaultChannels: [] },
  { eventKey: 'party_member_left', category: 'party', label: 'Member left your party', defaultChannels: [] },
  { eventKey: 'guild_invite_received', category: 'guild', label: 'Guild invite received', defaultChannels: ['in_app'] },
  { eventKey: 'guild_kicked', category: 'guild', label: 'Removed from guild', defaultChannels: ['in_app'] },
  { eventKey: 'world_room_gated', category: 'world_event', label: 'Moved out of a room your party no longer qualifies for', defaultChannels: ['in_app'] },
  { eventKey: 'dm_received', category: 'dm', label: 'New direct message', defaultChannels: ['in_app'] },
  { eventKey: 'friend_request_received', category: 'friend', label: 'New friend request', defaultChannels: ['in_app'] },
  { eventKey: 'friend_request_accepted', category: 'friend', label: 'Friend request accepted', defaultChannels: ['in_app'] },
  { eventKey: 'auto_retreat', category: 'system', label: 'Auto-retreat pulled your party out of a fight for the first time', defaultChannels: ['in_app'] },
];

export function getNotificationEventDefinition(eventKey: string): NotificationEventDefinition | undefined {
  return NOTIFICATION_EVENT_REGISTRY.find(d => d.eventKey === eventKey);
}

// --- Per-user preferences ---

export interface NotificationPreferences {
  /** Per-event channel overrides. Absent eventKey → the registry's defaultChannels apply. */
  events: Record<string, NotificationChannel[]>;
  /** Master per-channel kill switch — true fully disables that channel regardless of event settings. */
  channelDisabled: Partial<Record<NotificationChannel, boolean>>;
}

export function emptyNotificationPreferences(): NotificationPreferences {
  return { events: {}, channelDisabled: {} };
}

// --- Inbox entries (persisted + sent to client) ---

export interface NotificationEntry {
  id: string;
  category: NotificationCategory;
  eventKey: string;
  title: string;
  body: string;
  payload?: Record<string, unknown>;
  createdAt: number;
  readAt: number | null;
}

// --- Web Push ---

export interface WebPushSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

// --- Client -> Server messages ---

export interface ClientMarkNotificationReadMessage {
  type: 'mark_notification_read';
  id: string;
}

export interface ClientMarkAllNotificationsReadMessage {
  type: 'mark_all_notifications_read';
}

export interface ClientDismissNotificationMessage {
  type: 'dismiss_notification';
  id: string;
}

export interface ClientClearAllNotificationsMessage {
  type: 'clear_all_notifications';
}

export interface ClientSetNotificationPreferencesMessage {
  type: 'set_notification_preferences';
  preferences: NotificationPreferences;
}

export interface ClientRegisterPushSubscriptionMessage {
  type: 'register_push_subscription';
  subscription: WebPushSubscription;
}

export interface ClientUnregisterPushSubscriptionMessage {
  type: 'unregister_push_subscription';
  endpoint: string;
}

/** Reported by the client so the server can suppress DM notifications for a thread the user is actively viewing. */
export interface ClientSetChatFocusMessage {
  type: 'set_chat_focus';
  channelType: string | null;
  channelId: string | null;
}

export type ClientNotificationMessage =
  | ClientMarkNotificationReadMessage
  | ClientMarkAllNotificationsReadMessage
  | ClientDismissNotificationMessage
  | ClientClearAllNotificationsMessage
  | ClientSetNotificationPreferencesMessage
  | ClientRegisterPushSubscriptionMessage
  | ClientUnregisterPushSubscriptionMessage
  | ClientSetChatFocusMessage;

// --- Server -> Client messages ---

/** Live push of a freshly created notification, for instant toast + badge updates. */
export interface ServerNotificationMessage {
  type: 'notification';
  notification: NotificationEntry;
}

// --- Click navigation ---

/** Where clicking a notification should take the player, resolved per eventKey/category. */
export type NotificationNavigationTarget =
  | { kind: 'party' }
  | { kind: 'guild' }
  | { kind: 'friend_requests' }
  | { kind: 'dm_reply'; username: string }
  | { kind: 'options' }
  | { kind: 'none' };

/**
 * Resolves a notification's click destination from its category/eventKey/payload.
 * Any 'party' category notification (invite, kick, promotion, membership churn, ...) routes to the
 * Party tab, and any 'guild' one to the Guild tab — add a case here for other event types only once there's an
 * equally obvious destination; everything else falls through to 'none' (clicking still just marks the notification read).
 */
export function resolveNotificationNavigation(
  entry: Pick<NotificationEntry, 'category' | 'eventKey' | 'payload'>,
): NotificationNavigationTarget {
  if (entry.category === 'party') return { kind: 'party' };
  if (entry.category === 'guild') return { kind: 'guild' };

  switch (entry.eventKey) {
    case 'friend_request_received':
      return { kind: 'friend_requests' };
    case 'dm_received': {
      const from = entry.payload?.fromUsername;
      return typeof from === 'string' ? { kind: 'dm_reply', username: from } : { kind: 'none' };
    }
    case 'auto_retreat':
      return { kind: 'options' };
    default:
      return { kind: 'none' };
  }
}
