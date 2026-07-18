// --- Notification framework ---
//
// Pluggable by design: a new notification *type* is one entry in
// NOTIFICATION_EVENT_REGISTRY plus a `notify()` call at the game-event site.
// A new delivery *channel* is one NotificationChannelDriver implementation on
// the server — nothing here needs to change for either addition.

export type NotificationCategory =
  | 'party'
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
  { eventKey: 'dm_received', category: 'dm', label: 'New direct message', defaultChannels: ['in_app'] },
  { eventKey: 'friend_request_received', category: 'friend', label: 'New friend request', defaultChannels: ['in_app'] },
  { eventKey: 'friend_request_accepted', category: 'friend', label: 'Friend request accepted', defaultChannels: ['in_app'] },
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
