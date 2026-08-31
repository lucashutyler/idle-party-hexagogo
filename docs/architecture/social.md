# Social system

The Social bottom-nav tab opens a **fly-out submenu** with three sub-views (Party, Guild, Leaderboard). Chat moved out of Social entirely in the May 2026 overhaul — it's now a global pop-out toggled from a dedicated **Chat** nav button (see [`client.md`](client.md) → ChatPopout).

## Sub-tabs

### Party (default)

Every player is always in a party (solo party auto-created, max 5 members). Three-tier role hierarchy: owner > leader > member. Party creator is owner. Owner can promote/demote leaders, transfer ownership, and kick anyone. Leaders can promote members to leader, kick (including other leaders, but not owner), and move the party. Members cannot invite, kick, or move.

Pending invite flow: owner/leader invites → target sees pending invite with accept/decline → same-room validated on both invite and accept. Invites auto-expire when either the inviter or invitee moves to a different room (via `PartySystem.cancelInvitesInvolving`, hooked into the `onMembersMoved` callback in `PartyBattleManager`). Badge indicator on Party tab when invites pending.

**An invite must not outlive its sender's membership.** `acceptInvite` validates the accepter against the *inviter's* room, not the party's — so an invite left over from someone who has since left or been kicked would admit a player to wherever that ex-inviter now stands, on any map. `leaveParty` and `kickMember` therefore cancel invites involving the departing player, which is what keeps the inviter-based check sound: an inviter who is still a member always travels with the party.

**Joining a party can change a player's map.** It is the third such path, alongside a map transition and a forced relocation, and all three must re-seat the joiner's fog-of-war grid (`PlayerSession.switchMapGrid`) — a `PlayerSession`'s `UnlockSystem` is bound to one map's grid, so a joiner who skips this keeps revealing rooms against the map they came from.

3x3 grid positioning for combat formation. Combat is shared — all members fight the same monsters together with grid-based targeting. Movement is party-level (owner/leader moves all members). On victory, each member gets XP/gold/loot independently. Leaving/kicked auto-creates new solo party at current position (captured before the old party entry can be torn down). If owner leaves, first leader becomes owner; if no leaders, first member becomes owner.

Party events (join, kick, promotion, demotion, ownership change) post personalized chat announcements — the subject sees "You were ..." while others see "<name> was ..." — via `PlayerManager.broadcastPartyEvent` (party channel for in-party recipients, server channel for kicked players who are no longer in the party). The same events also fire through the notification framework (invite received, kicked, promoted, demoted, ownership transferred, member joined/left) — see [`notifications.md`](notifications.md).

### Guild

Create guild (level 20+, 2-20 char name), leave guild. Guild invites are sent via the user popup menu. Guild data persisted in `data/guilds.json`. Leader auto-transfers on leave.

### Leaderboard (was "Users")

All registered players sorted by level descending by default (proxy for XP). Sort cycler: Top → Status → A-Z. Each row shows class icon, name, online dot, level badge. Search + filter chips (all / room / zone / friends / guild). Incoming friend requests still appear as a top section. Click any username for the user popup menu. Data sourced from `ClientSocialState.allPlayers` (`PlayerListEntry` includes `username`, `className?`, `level?`).

## Chat (global pop-out)

Documented in [`client.md`](client.md) under "ChatPopout (global overlay)" — covers the desktop floating-window mode, mobile full/sheet layouts, docking behavior, clickable senders + channel tags, and the body data-attributes that drive the layout. Protocol-level chat behavior:

WoW-style unified timeline with all channels in one scrollable view, color-coded by channel type with timestamps (HH:MM), plus a day-separator row ("Today"/"Yesterday"/short date) inserted wherever consecutive messages cross a calendar-day boundary. 7 `ChatChannelType` values: `tile` (Room), `zone`, `party`, `guild`, `dm`, `global`, `server` (system announcements). Toggle filter pills to show/hide each channel. Channel selector dropdown for sending (Party/Guild disabled when unavailable; `server` is server-emit-only). Per-user chat history (1000 msgs, saved with player data) — messages persist with the player forever, not with the channel. Blocking (`dm` or `all` levels) filters messages server-side.

A DM also fires a `dm_received` notification, suppressed when the recipient has the popout open with that thread selected — see [`notifications.md`](notifications.md) → "Chat focus".

## User popup menu

A contextual popup shown when clicking any username across the app (Users tab, Guild/Party members, RoomView party tiles, chat sender names). Shows player level in the header. Actions: View Player, Chat (DM), Guild Invite / "In Guild", Add Friend / Accept / Decline / Revoke / "Friends", Party Invite / "In Party" / "Different Room", Trade, Block / Unblock. Trade is **not** room-gated — trades are async (see below). Dismissed on outside click or after action. Implemented as a positioned absolute div in `SocialScreen`.

## View Player profile

Clicking "View Player" in the popup sends a `view_player` WS request; server responds with `player_profile` containing the target's public "chosen state" — class, level, guild name, equipped items (with item definitions), equipped skills, and party members. No private stats (HP, damage, gold, inventory, XP) are exposed. The client renders a modal overlay (`player-profile-modal`) showing this data. `PlayerListEntry` includes `level` so the popup header can show it without an extra request.

## Item trading (async)

Player-to-player item trading via `TradeSystem` (`server/src/game/social/TradeSystem.ts`). Trade lifecycle: `pending` (one side has offered something, the other has not) → `countered` (both sides have offered) → `confirmed` (caller executes swap) / `cancelled`.

Rules: any unequipped items can be offered (multi-item, with quantities); one active trade per player-pair (across the system); blocked users cannot trade.

**Trades are asynchronous** — they persist across server restarts and survive movement, disconnect, zone changes. There is no same-tile requirement. Either player can update their offer (via `counterTrade`) at any time; either player can confirm — but only when the OTHER player took the most recent action (`lastUpdatedBy` tracks this). On stack-capacity failure, the trade is left in `countered` state so players can adjust.

**Confirm nonce** — each `TradeState` carries a `nonce` minted on `proposeTrade` and rotated on every `counterTrade`. `confirm_trade` must echo the nonce of the offer the confirming player was shown; a missing or stale one is rejected with `TRADE_NONCE_MISMATCH` and the trade is left untouched in `countered` state. This binds a confirmation to one exact offer version, closing two holes that `lastUpdatedBy` alone does not: replaying a captured `confirm_trade` frame, and a partner swapping their offer while the other player's confirm is in flight (`lastUpdatedBy` still points at the partner after such a swap, so that guard passes). Trades persisted before nonces existed are backfilled with a fresh one on `restoreFromSaveData`. The server check alone cannot cover the *read-then-click* window: a partner who counters while the player is reaching for Confirm rotates the nonce, the modal repaints, and a naive client would re-arm the button with the new nonce — the swap would then pass every server guard (`lastUpdatedBy` still points at the partner). `SocialScreen` closes this by treating the nonce as an offer version: `tradeConfirmNonce` records the version the Confirm button is armed against and `tradeConfirmArmed` records whether Confirm was actually on screen. If the version changes while armed, `tradeAwaitingReview` is set, Confirm is replaced by a **Review Updated Offer** button, and the player must acknowledge the new offer before Confirm is live again. The first counter of a trade (Confirm not yet on screen) does not trigger the gate, so the normal flow is unaffected. The nonce is part of the modal's render key so a repaint is never skipped after an offer changes.

Because the Items screen opens this modal via `openExistingTrade` **without a screen switch**, the modal cannot rely on `SocialScreen`'s activate/deactivate subscription — it would paint from a frozen `lastSocial` and its Confirm would be permanently rejected. `renderTradeModal` therefore takes its own `gameClient.subscribe` for the modal's lifetime (released in `dismissTradeModal`), and both entry points call `refreshStateForTrade()` first, the same fresh-state idiom `showUserPopup` uses.

A rejection is sent as an `error` message carrying `code: 'trade_nonce_mismatch'` (see `ServerErrorCode`) plus a state re-sync; `GameClient.onServerError` lets the modal surface a `.trade-notice` explaining it, so Confirm never looks like a dead button. Only confirm is nonce-gated — replaying a `counter_trade` only rewrites the sender's own (re-validated) offer, which moves no items.

Trades persist via `TradeStore` (`data/trades.json`); `GameLoop.init` calls `tradeStore.load()` and `restoreFromSaveData`, and the periodic save serializes via `getAllTrades()`. Client trade UI is a modal overlay (item picker + side-by-side offers) opened from the user popup or from the "Proposed Trades" list on the Items screen. Badge appears on the bottom-nav Items tab when a trade is waiting on this player.

## Gift mailbox (async)

Players can send gifts to anyone (no same-tile requirement) via the user popup "Send Gift" action. Implementation lives in `MailboxSystem` (`server/src/game/social/MailboxSystem.ts`); each `MailboxEntry` holds a single `(itemId, quantity)` from a sender. Mailbox entries are NOT merged — sending multiple gifts of the same item produces multiple entries. This deliberately permits a player to "hold" more than `MAX_STACK` of an item by leaving copies in their mailbox; **accepting** is what's gated by the 99-stack inventory cap.

On accept, the gift is added to the recipient's inventory (rejected with a warning if it would overflow); on deny, the gift is sent back to the original sender's mailbox marked as `returned: true` (re-denying a returned gift drops it instead of ping-ponging). Mailbox entries are persisted with each player's save data (`PlayerSaveData.mailbox`), kept in `MailboxSystem` at runtime, and exposed via `ClientSocialState.mailbox`. UI lives in the Items screen with a Mailbox section (Accept / Decline buttons per entry) and a Proposed Trades section.

## Social badges

Badge dot (red) on the Social bottom-nav tab when there are pending friend requests or party invites. The Chat nav button gets its own unread badge driven by `ChatPopout`. Sub-tab badges: Leaderboard (incoming friend requests or trade requiring attention), Party (pending invites).

## Social state

`ClientSocialState` is included in every `ServerStateMessage.social`. Contains friends, incoming/outgoing friend requests, guild info, guild members, party info, pending party invites, outgoing party invites (sent by this player), online players list, all registered players list (as `PlayerListEntry[]` with className and level), blocked users, chat preferences (send channel + DM target), and the player's notification inbox + preferences (see [`notifications.md`](notifications.md)). `PlayerManager` builds this via `getSocialState()` callback on each `PlayerSession`.

Incoming friend requests also fire a `friend_request_received` notification, and an accepted outgoing request fires `friend_request_accepted` for the original sender (including the auto-accept case when both sides happen to request each other).

## Henchmen in the party

Hired henchmen live in `GamePartyInfo.henchmen: HiredHenchman[]`, a **sibling** of `members` — never inside it. `members` means accounts: ~70 server call sites resolve one to a `PlayerSession`, transfer ownership to one, count one toward a reward divisor, or notify one. A henchman in that array makes each of those wrong silently rather than at compile time, so ownership transfer, the XP/gold divisor, the drop lottery, room-entry gating and battle-timer teardown all stay correct by construction.

**One henchman per party** (`MAX_HENCHMEN_PER_PARTY`), enforced in `PartySystem.hireHenchman` and again in `restoreHenchmen` so a save written before the limit cannot reintroduce more. The cap is deliberately a named constant rather than an inlined `1` — it is a balance decision, not a structural one, and everything below it (per-hire `instanceId`, combat-name disambiguation, slot allocation across both rosters) already handles several.

The two rosters **share** the nine grid squares. `PartySystem` allocates across both through one `occupiedPositions` helper — the only place that knows it — so two occupants can never land on one square. Henchmen count toward `MAX_PARTY_SIZE` everywhere, invites included.

**Balance**: henchmen are *typically* worse than a party mate, not *strictly* worse. Nothing in code ties a henchman's stats to the party's lowest level — stats are fixed content, so balance is a job for whoever authors the definition and picks which shop and map it appears on. Henchmen also count toward party-size-scaled effects (Bard Rally, Nimble Dodge, Unnerve, party-wide cooldown reduction) exactly as a player does, which is deliberate: a hire is a real contribution, not a pure handicap. Superseded the original "must be lower than the lowest party member / last resort" rule — see `ideas/backlog-2026-april.md`.

**Roles**: hiring and moving a henchman are gated on the invite role, dismissing on the kick role (owner or leader). The client hides those affordances for plain members rather than letting the server refuse silently.

**Identity**: a henchman's combat name is its definition name, disambiguated with ` #2`/` #3` against both other henchmen and the party's real usernames (`henchmanDisplayNames`). `PartyCombatant.username` is interpolated verbatim into ~25 combat-log lines and keys DoT attribution and heal-target prose, so a henchman sharing a name with a member would corrupt combat, not just prose.

**Map scoping**: a hire is scoped to the map it was made on, dismissed immediately after either `ServerParty.switchMap` call — the transition the party chose, and the forced relocation a content deploy causes. Departures are announced in the combat log.

**Client**: `SocialScreen` renders henchmen in the 3x3 grid and the party list with a photo (`artworkUrl`, emoji fallback) and a Henchman badge. They carry no `data-username` and no clickable-name class, so the user popup, DM, trade, gift, friend-request, block, promote, demote and transfer flows — all of which resolve a real account — can never reach one. The only actions are Dismiss and moving on the grid.
