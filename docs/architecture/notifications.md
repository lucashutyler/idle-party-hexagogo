# Notifications

Pluggable framework for emitting notifications from game events, routing them to whichever delivery channels a player has enabled, and persisting a per-user inbox. Built to add new notification *types* and new delivery *avenues* without refactoring the dispatcher.

## Shared types (`shared/src/systems/NotificationTypes.ts`)

- `NotificationCategory`: `party | guild_combat | dm | friend | trade | world_event | quest | system`. `NOTIFICATION_CATEGORY_META` gives each a display label for the preference UI.
- `NotificationChannel`: `in_app | browser_push | email` today; `ALL_NOTIFICATION_CHANNELS` is the source of truth the preference UI iterates over. Adding SMS/Discord later is one new channel driver (server) + one new union member (shared) — no dispatcher changes.
- `NOTIFICATION_EVENT_REGISTRY`: the catalog of every notification the server can emit — `{ eventKey, category, label, defaultChannels }`. `defaultChannels` is always either `['in_app']` or `[]` — push and email are opt-in only, never on by default. Adding a new notification type is one entry here plus a `notify()` call at the game-event site; no other wiring required.
- `NotificationEntry`: an inbox item (`id, category, eventKey, title, body, payload?, createdAt, readAt`) — this is what's persisted and sent to the client.
- `NotificationPreferences`: `{ events: Record<eventKey, NotificationChannel[]>, channelDisabled: Partial<Record<NotificationChannel, boolean>> }`. Absent `events[eventKey]` → the registry's `defaultChannels` apply. `channelDisabled` is a master kill switch per channel, checked *after* per-event resolution — it can silence a channel outright regardless of what's configured per-event.
- `WebPushSubscription`: mirrors the browser's `PushSubscriptionJSON` shape (`endpoint`, `expirationTime`, `keys.p256dh/auth`).

## Server dispatch (`server/src/game/social/`)

- **`NotificationSystem`** — in-memory per-player inbox, capped at 50 entries (oldest evicted first). Mirrors `MailboxSystem`'s shape exactly: `setInbox` (restore), `getInbox`, `addEntry`, `markRead`, `markAllRead`, `getAllUsernames`.
- **`NotificationService.notify(username, eventKey, { title, body, payload? })`** — the single entry point every game system calls. Looks up the event's registry definition, resolves the recipient's enabled channels (per-event preference → registry default, minus anything master-disabled), builds the `NotificationEntry`, and dispatches it to each enabled channel's driver. Unknown `eventKey`s are logged and dropped — the registry is the only place event keys are declared.
- **`NotificationChannelDriver`** interface — `{ channel, deliver(ctx) }`. `NotificationService` knows nothing about what a driver does with an entry; each driver is independently responsible for its own delivery (and, for `in_app`, for writing to the inbox at all — an event with `in_app` excluded from the resolved channel list never touches the inbox).
  - **`InAppNotificationDriver`** — `NotificationSystem.addEntry()` + a live WS push (`{ type: 'notification', notification }`) over any open connections, via `PlayerManager.sendNotificationToPlayer()`.
  - **`BrowserPushNotificationDriver`** — sends via the `web-push` package using VAPID keys from `VAPID_PUBLIC_KEY`/`VAPID_PRIVATE_KEY`/`VAPID_SUBJECT` env vars. No-ops (with a one-time warning) if those aren't configured — push is optional infrastructure, not a hard dependency. Prunes a subscription automatically on a 404/410 response (expired/revoked). `getVapidPublicKey()` backs the `/api/notifications/vapid-public-key` REST endpoint the client reads before calling `pushManager.subscribe()`.
  - **`EmailNotificationDriver`** — reuses the SES-backed `EmailService` (`sendNotificationEmail`, sharing the same `sendSesEmail` helper `sendMagicLinkEmail` uses — dev mode logs instead of sending). Looks the recipient's account email up via `AccountStore`; no separate "verify your email" step since magic-link auth already verified it.
- **`PlayerManager`** wires all of this together: `readonly notifications: NotificationSystem` + `readonly notify: NotificationService`, constructed with the three drivers above. `getSocialState()` includes `notifications` (the live inbox) and `notificationPreferences` (from the session) in `ClientSocialState`, following the same pattern as `mailbox`.

## Emission call sites

- **Party** (`server/src/index.ts`, `PartySystem` handlers) — `party_invite_received`, `party_kicked`, `party_promoted`, `party_demoted`, `party_ownership_transferred` (on for the recipient's own status changes), `party_member_joined`/`party_member_left` (off by default — ambient churn about *other* members).
- **DM** (`send_chat` handler, `channelType === 'dm'` branch) — `dm_received`, suppressed when the recipient's session reports `chatFocus` pointing at a DM thread with the sender (see below).
- **Friend requests** (`send_friend_request`/`accept_friend_request` handlers) — `friend_request_received` and `friend_request_accepted`. `FriendsSystem.sendRequest()` returns `'created' | 'auto_accepted' | string` (not just `true`) specifically so the caller can tell a fresh request apart from a mutual auto-accept and fire the right notification.
- **Guild** (non-combat guild events — invite, promote, achievement, raid reminders) is *not* wired yet; the guild system itself doesn't exist as a full feature. Slots into the same registry + `notify()` pattern once it does.

## Chat focus (DM suppression)

`PlayerSession.chatFocus: { channelType, channelId } | null` is **ephemeral** — not persisted, reset to `null` on every session restore. The client reports it via `set_chat_focus`, combining window focus + whichever chat surface (only `ChatPopout` today — the embedded SocialScreen chat tab was removed in favor of the pop-out) currently has a DM thread selected. `client/src/network/ChatFocusTracker.ts` is the single source of truth this reports from — both surfaces call `setActiveThread`/`clearActiveThread` on it, and it debounces the actual WS send to only fire on change. Window blur immediately reports "not focused" so a backgrounded tab still gets notified.

## Persistence

`PlayerSaveData` (`server/src/game/GameStateStore.ts`) gained: `notifications` (capped inbox), `notificationPreferences`, `pushSubscriptions`. Restore flow mirrors mailbox exactly — `PlayerSession.consumeInitialNotifications()` ferries the saved inbox into `NotificationSystem` once at login/restore (`PlayerManager.login()` and `restoreFromSaveData()`), and `toSaveData()` snapshots the live inbox back via a `getNotifications` callback wired in `PlayerManager.wireCallbacks()`. `notificationPreferences` and `pushSubscriptions` are plain per-player fields on `PlayerSession` (like `blockedUsers`) since they're never mutated by anyone but the owning player.

## Client

- **`client/src/network/GameClient.ts`** — outbound: `sendMarkNotificationRead`, `sendMarkAllNotificationsRead`, `sendSetNotificationPreferences`, `sendRegisterPushSubscription`, `sendUnregisterPushSubscription`, `sendSetChatFocus`. Inbound: `onNotification` for the live toast push (`{ type: 'notification' }`); the persisted inbox itself rides on the normal `state` message (`state.social.notifications`), same as mailbox/friend requests.
- **`client/src/ui/NotificationCenter.ts`** — global bell + dropdown + toast stack, mounted into `#notification-center-root` (a fixed root outside `#app`, alongside `#chat-popout-root`) so it survives screen switches. Bell shows an unread-count badge; the dropdown lists the inbox newest-first and marks an entry read on click; toasts are driven by `onNotification` and auto-dismiss after 6s.
- **`client/src/ui/NotificationPreferences.ts`** — the category × channel grid, rendered inside a modal opened from a new "Notifications" button on `SettingsScreen` (alongside Player Options / Patch Notes / Sign Out). Only categories with at least one registered event render a row — the type system supports all 8 categories, but a category with zero live events (`guild_combat`, `trade`, `world_event`, `quest`, `system`, and `guild` until non-combat guild events ship) would otherwise show a dead row. Toggling a push checkbox for the first time triggers the browser permission + subscription flow inline; toggling a channel's master switch off unsubscribes from push if that's the channel being disabled.
- **`client/src/network/PushNotifications.ts`** — `registerServiceWorker()` (called once from `main.ts`, no-ops in dev via `import.meta.env.DEV` so a stale SW never shadows a dev build), `subscribeToPush`/`unsubscribeFromPush` (permission → fetch VAPID public key → `pushManager.subscribe()` → register with the server).

## PWA (`client/public/`)

- `manifest.webmanifest` — installable app metadata + icons (`icon-192.png`, `icon-512.png`, `apple-touch-icon.png`; hand-generated placeholder art, swap for real branding whenever it exists).
- `sw.js` — plain hand-written service worker (no build-time processing; Vite copies `public/` to the build root as-is). Deliberately narrow scope: network-first for the HTML shell (always fresh — the hashed asset URLs it references make a stale cache harmless), cache-first only for Vite's hashed `/assets/*` output. Everything else — `/api/*`, `/auth/*`, admin-editable artwork mounts (`/item-artwork`, `/monster-artwork`, ...), WebSocket traffic — is never intercepted, so nothing here can ever serve stale game content or stale admin-uploaded art. Also owns the `push`/`notificationclick` handlers for the browser-push channel.
- Referenced from `client/index.html` via `<link rel="manifest">` + theme-color/apple-mobile-web-app meta tags. `admin.html` intentionally has none of this — the admin dashboard isn't meant to be installable.

## Extending

- **New notification type**: add an entry to `NOTIFICATION_EVENT_REGISTRY` (shared), call `playerManager.notify.notify(username, eventKey, { title, body, payload? })` at the game-event site.
- **New channel**: implement `NotificationChannelDriver`, add it to the driver list in `PlayerManager`'s constructor, add the channel to `NotificationChannel`/`ALL_NOTIFICATION_CHANNELS` (shared). The preference UI picks it up automatically — one more grid column, no other UI changes.
