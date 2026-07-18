# Social system

The Social bottom-nav tab opens a **fly-out submenu** with three sub-views (Party, Guild, Leaderboard). Chat moved out of Social entirely in the May 2026 overhaul — it's now a global pop-out toggled from a dedicated **Chat** nav button (see [`client.md`](client.md) → ChatPopout).

## Sub-tabs

### Party (default)

Every player is always in a party (solo party auto-created, max 5 members). Three-tier role hierarchy: owner > leader > member. Party creator is owner. Owner can promote/demote leaders, transfer ownership, and kick anyone. Leaders can promote members to leader, kick (including other leaders, but not owner), and move the party. Members cannot invite, kick, or move.

Pending invite flow: owner/leader invites → target sees pending invite with accept/decline → same-room validated on both invite and accept. Invites auto-expire when either the inviter or invitee moves to a different room (via `PartySystem.cancelInvitesInvolving`, hooked into the `onMembersMoved` callback in `PartyBattleManager`). Badge indicator on Party tab when invites pending.

3x3 grid positioning for combat formation. Combat is shared — all members fight the same monsters together with grid-based targeting. Movement is party-level (owner/leader moves all members). On victory, each member gets XP/gold/loot independently. Leaving/kicked auto-creates new solo party at current position (captured before the old party entry can be torn down). If owner leaves, first leader becomes owner; if no leaders, first member becomes owner.

Party events (join, kick, promotion, demotion, ownership change) post personalized chat announcements — the subject sees "You were ..." while others see "<name> was ..." — via `PlayerManager.broadcastPartyEvent` (party channel for in-party recipients, server channel for kicked players who are no longer in the party). The same events also fire through the notification framework (invite received, kicked, promoted, demoted, ownership transferred, member joined/left) — see [`notifications.md`](notifications.md).

### Guild

Create guild (level 20+, 2-20 char name), leave guild. Guild invites are sent via the user popup menu. Guild data persisted in `data/guilds.json`. Leader auto-transfers on leave.

### Leaderboard (was "Users")

All registered players sorted by level descending by default (proxy for XP). Sort cycler: Top → Status → A-Z. Each row shows class icon, name, online dot, level badge. Search + filter chips (all / room / zone / friends / guild). Incoming friend requests still appear as a top section. Click any username for the user popup menu. Data sourced from `ClientSocialState.allPlayers` (`PlayerListEntry` includes `username`, `className?`, `level?`).

## Chat (global pop-out)

Documented in [`client.md`](client.md) under "ChatPopout (global overlay)" — covers the desktop floating-window mode, mobile full/sheet layouts, docking behavior, clickable senders + channel tags, and the body data-attributes that drive the layout. Protocol-level chat behavior:

WoW-style unified timeline with all channels in one scrollable view, color-coded by channel type with timestamps (HH:MM). 7 `ChatChannelType` values: `tile` (Room), `zone`, `party`, `guild`, `dm`, `global`, `server` (system announcements). Toggle filter pills to show/hide each channel. Channel selector dropdown for sending (Party/Guild disabled when unavailable; `server` is server-emit-only). Per-user chat history (1000 msgs, saved with player data) — messages persist with the player forever, not with the channel. Blocking (`dm` or `all` levels) filters messages server-side.

A DM also fires a `dm_received` notification, suppressed when the recipient has the popout open with that thread selected — see [`notifications.md`](notifications.md) → "Chat focus".

## User popup menu

A contextual popup shown when clicking any username across the app (Users tab, Guild/Party members, RoomView party tiles, chat sender names). Shows player level in the header. Actions: View Player, Chat (DM), Guild Invite / "In Guild", Add Friend / Accept / Decline / Revoke / "Friends", Party Invite / "In Party" / "Different Room", Trade, Block / Unblock. Trade is **not** room-gated — trades are async (see below). Dismissed on outside click or after action. Implemented as a positioned absolute div in `SocialScreen`.

## View Player profile

Clicking "View Player" in the popup sends a `view_player` WS request; server responds with `player_profile` containing the target's public "chosen state" — class, level, guild name, equipped items (with item definitions), equipped skills, and party members. No private stats (HP, damage, gold, inventory, XP) are exposed. The client renders a modal overlay (`player-profile-modal`) showing this data. `PlayerListEntry` includes `level` so the popup header can show it without an extra request.

## Item trading (async)

Player-to-player item trading via `TradeSystem` (`server/src/game/social/TradeSystem.ts`). Trade lifecycle: `pending` (one side has offered something, the other has not) → `countered` (both sides have offered) → `confirmed` (caller executes swap) / `cancelled`.

Rules: any unequipped items can be offered (multi-item, with quantities); one active trade per player-pair (across the system); blocked users cannot trade.

**Trades are asynchronous** — they persist across server restarts and survive movement, disconnect, zone changes. There is no same-tile requirement. Either player can update their offer (via `counterTrade`) at any time; either player can confirm — but only when the OTHER player took the most recent action (`lastUpdatedBy` tracks this). On stack-capacity failure, the trade is left in `countered` state so players can adjust.

Trades persist via `TradeStore` (`data/trades.json`); `GameLoop.init` calls `tradeStore.load()` and `restoreFromSaveData`, and the periodic save serializes via `getAllTrades()`. Client trade UI is a modal overlay (item picker + side-by-side offers) opened from the user popup or from the "Proposed Trades" list on the Items screen. Badge appears on the bottom-nav Items tab when a trade is waiting on this player.

## Gift mailbox (async)

Players can send gifts to anyone (no same-tile requirement) via the user popup "Send Gift" action. Implementation lives in `MailboxSystem` (`server/src/game/social/MailboxSystem.ts`); each `MailboxEntry` holds a single `(itemId, quantity)` from a sender. Mailbox entries are NOT merged — sending multiple gifts of the same item produces multiple entries. This deliberately permits a player to "hold" more than `MAX_STACK` of an item by leaving copies in their mailbox; **accepting** is what's gated by the 99-stack inventory cap.

On accept, the gift is added to the recipient's inventory (rejected with a warning if it would overflow); on deny, the gift is sent back to the original sender's mailbox marked as `returned: true` (re-denying a returned gift drops it instead of ping-ponging). Mailbox entries are persisted with each player's save data (`PlayerSaveData.mailbox`), kept in `MailboxSystem` at runtime, and exposed via `ClientSocialState.mailbox`. UI lives in the Items screen with a Mailbox section (Accept / Decline buttons per entry) and a Proposed Trades section.

## Social badges

Badge dot (red) on the Social bottom-nav tab when there are pending friend requests or party invites. The Chat nav button gets its own unread badge driven by `ChatPopout`. Sub-tab badges: Leaderboard (incoming friend requests or trade requiring attention), Party (pending invites).

## Social state

`ClientSocialState` is included in every `ServerStateMessage.social`. Contains friends, incoming/outgoing friend requests, guild info, guild members, party info, pending party invites, outgoing party invites (sent by this player), online players list, all registered players list (as `PlayerListEntry[]` with className and level), blocked users, chat preferences (send channel + DM target), and the player's notification inbox + preferences (see [`notifications.md`](notifications.md)). `PlayerManager` builds this via `getSocialState()` callback on each `PlayerSession`.

Incoming friend requests also fire a `friend_request_received` notification, and an accepted outgoing request fires `friend_request_accepted` for the original sender (including the auto-accept case when both sides happen to request each other).
