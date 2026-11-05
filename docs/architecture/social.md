# Social system

The Social tab has four sub-views on a segment bar: Party, Guild, Friends and Ranks. Rendering details are in [`client.md`](client.md) → Social screen. Chat isn't part of Social: it is docked in the shell, as a strip and sheet on phones and a column on desktop (see [`client.md`](client.md) → Chat).

## Sub-tabs

### Party (default)

Every player is always in a party (solo party auto-created, max 5 members). Three-tier role hierarchy: owner > leader > member. Party creator is owner. Owner can promote/demote leaders, transfer ownership, and kick anyone. Leaders can promote members to leader, kick (including other leaders, but not owner), and move the party. Members cannot invite, kick, or move.

Pending invite flow: owner/leader invites → target sees pending invite with accept/decline → same-room validated on both invite and accept. Invites auto-expire when either the inviter or invitee moves to a different room (via `PartySystem.cancelInvitesInvolving`, hooked into the `onMembersMoved` callback in `PartyBattleManager`). The Party segment shows a count of pending invites.

**An invite must not outlive its sender's membership.** `acceptInvite` validates the accepter against the *inviter's* room, not the party's — so an invite left over from someone who has since left or been kicked would admit a player to wherever that ex-inviter now stands, on any map. `leaveParty` and `kickMember` therefore cancel invites involving the departing player, which is what keeps the inviter-based check sound: an inviter who is still a member always travels with the party.

**Joining a party can change a player's map.** It is the third such path, alongside a map transition and a forced relocation, and all three must re-seat the joiner's fog-of-war grid (`PlayerSession.switchMapGrid`) — a `PlayerSession`'s `UnlockSystem` is bound to one map's grid, so a joiner who skips this keeps revealing rooms against the map they came from.

3x3 grid positioning for combat formation. Columns are the formation depth — col 2 **Front**, col 1 **Mid**, col 0 **Back** (cell titles and a "FRONT" label say so; mapping in `client/src/ui/partyGridLayout.ts` → `partyGridCell`). On portrait phones (`max-width: 767px` + portrait) the grid is drawn front-on-top with the same mapping as the combat party block (`displayRow = 2 − col`, `displayCol = row`), so the formation matches the battle layout. Combat is shared — all members fight the same monsters together with grid-based targeting. Movement is party-level (owner/leader moves all members). On victory, each member gets XP/gold/loot independently. Leaving/kicked auto-creates new solo party at current position (captured before the old party entry can be torn down). If owner leaves, first leader becomes owner; if no leaders, first member becomes owner. Kick, Transfer, Leave Party and Dismiss Henchman go through `confirmDialog`.

Party events (join, kick, promotion, demotion, ownership change) post personalized chat announcements — the subject sees "You were ..." while others see "<name> was ..." — via `PlayerManager.broadcastPartyEvent` (party channel for in-party recipients, server channel for kicked players who are no longer in the party). The same events also fire through the notification framework (invite received, kicked, promoted, demoted, ownership transferred, member joined/left) — see [`notifications.md`](notifications.md).

### Guild

Create guild (level 20+, 2-20 char name), leave guild (confirmed). Create is disabled with a visible reason below the level, and the typed name survives repaints. Guild invites are sent via the user popup menu; "Invite to Guild" adds the target immediately, with no acceptance step. Guild data persisted in `data/guilds.json`. Leader auto-transfers on leave.

### Friends

Sections, shown when non-empty: Friend requests (Accept / Decline), Online and Offline friends (Chat), Requests sent (Revoke), Blocked (Unblock). The search box also finds other players, with an Add button. The segment shows a count of incoming requests. A saved `users` view and the `friend_requests` notification target both open Friends.

### Ranks

All registered players sorted by level descending by default (proxy for XP). Sort cycler: Top → Status → A-Z. Each row shows its rank number, class icon, name, online dot and level; filters and search keep the global rank. A "You: #N" button shows your rank. Search + filter chips (all / room / zone / friends / guild); the zone filter compares the raw zone key. Click any username for the user popup menu. Data sourced from `ClientSocialState.allPlayers` (`PlayerListEntry` includes `username`, `className?`, `level?`). The list is windowed: see [`client.md`](client.md) → Social screen.

## Chat

The UI is documented in [`client.md`](client.md) → Chat: phone strip and sheet, desktop column, clickable senders + channel tags, and the body data-attributes that drive the layout. Protocol-level chat behavior:

WoW-style unified timeline with all channels in one scrollable view, color-coded by channel type with timestamps (HH:MM), plus a day-separator row ("Today"/"Yesterday"/short date) inserted wherever consecutive messages cross a calendar-day boundary. 7 `ChatChannelType` values: `tile` (Room), `zone`, `party`, `guild`, `dm`, `global`, `server` (system announcements). A filter popover shows or hides each channel on the All tab. Channel selector dropdown for sending (Party/Guild left out when solo or guildless; `server` is server-emit-only). Per-user chat history (1000 msgs, saved with player data) — messages persist with the player forever, not with the channel; the client holds the newest 500.

`send_chat` goes through `PlayerManager.sendPlayerChat`, which validates `channelId` against the channel type and refuses anything else with a `chat_refused` error:

| Channel | `channelId` must be |
|---|---|
| `zone` | The sender's own raw zone key |
| `guild` | The id of a guild the sender belongs to |
| `dm` | A username with an account, in any case; the message carries the account's spelling, because sessions and block lists match exact names |
| `party`, `tile`, `global` | An empty string: the server works out the audience from the sender |

A sender who has just crossed a zone boundary can be refused for the zone they left; the client puts the text back so they can send again. History saved before these checks can still hold other values, so the client keeps treating everything on a message as untrusted.

Message delivery ignores blocks: `send_chat` delivers regardless, and `isBlockedMessage` hides the blocked sender's messages in the timeline, preview, thread list and unread count; a thread you started keeps its row with your own lines. Unblocking brings the hidden messages back. The player UI only ever sets the `all` level (the server also accepts `dm`).

A DM also fires a `dm_received` notification, unless the recipient has blocked the sender at either level (so no in-app, push or email) or has that thread on screen — see [`notifications.md`](notifications.md) → "Chat focus".

Block lists are plain objects keyed by username, and `constructor` and `__proto__` are legal usernames, so reads go through `isBlockedUser` (own keys only) rather than `in`.

## Renames

Renames are turned off: `POST /auth/username` refuses a different name on an account that already has one, because most state doesn't follow a rename yet. So nothing calls `PlayerManager.renamePlayer` outside tests. It stays, with its block handling, because that part is finished and tested and real renames will need it. The rest of this section describes what `renamePlayer` does when called.

**Blocks follow the rename.** `renamePlayer` moves the old name to the new one, at the same level, in every in-memory session's `blockedUsers`, whether or not the renamed player has a session. `isBlockedMessage`, `isTradeBlocked` and the `dm_received` check then keep applying, and whoever takes the old name next isn't blocked.

`isBlockedMessage` matches on the name a message carries, so moving the block alone would bring back everything the player said before. `PlayerSession.moveBlockToNewName` therefore also rewrites the old name in that blocker's stored history, as sender and as DM partner. It copies the messages it changes because recipients share one message object: players without the block keep the old name.

Each blocker is saved straight away, because the account store already holds the new name and a crash before the next periodic save would lose the block for good. Online blockers get a state push.

Limits of this:

- A client that is already open keeps the old-name lines in its `ChatLog`, which only ever merges, so they show again in that client until it reloads.
- A suspended player has no session in memory, so the block list in their save file keeps the old name.
- A block left behind by a rename before this existed can't be repaired, because the old name isn't recorded anywhere.

**Nothing else follows yet.** Friends, friend requests, guild rosters, party members, trades, notification inboxes and other players' DM targets and chat history all stay under the old name, and a socket that was already open keeps acting as the old name until it reconnects.

## User popup menu

A contextual popup shown when clicking any username across the app (Friends, Ranks, Guild/Party members, RoomView and room sheet players, combat cards, chat sender names). The header shows avatar, online dot, level, class and labels (Friend, Guild, Party, Blocked). Actions: View Player, Chat (DM), Trade (Open Trade when one is in progress), Send Gift, Add / Accept / Decline / Revoke / Remove Friend, Invite to Party, Invite to Guild, Block / Unblock. Disabled actions say why in visible text: Invite to Party names the role, full-party, already-invited or different-room reason, and paints "Invited to Party" only from `outgoingPartyInvites`. Trade is **not** room-gated — trades are async (see below). Block and Remove Friend go through `confirmDialog`. Dismissed on outside click, the X, Back, Escape or after an action.

Implemented in `SocialScreen`. It is a bottom sheet below 768px wide or 520px tall, otherwise a menu at the anchor, clamped to the viewport and re-clamped on resize; it closes if a rotation crosses between the two. Your own name opens a small self popup.

## View Player profile

Clicking "View Player" in the popup sends a `view_player` WS request; server responds with `player_profile` containing the target's public "chosen state" — class, level, guild name, equipped items (with item definitions), equipped skills, and party members. No private stats (HP, damage, gold, inventory, XP) are exposed. The client renders a modal overlay (`player-profile-modal`, on ModalStack with its item popup) showing this data. `PlayerListEntry` includes `level` so the popup header can show it without an extra request.

## Item trading (async)

Player-to-player item trading via `TradeSystem` (`server/src/game/social/TradeSystem.ts`). Trade lifecycle: `pending` (one side has offered something, the other has not) → `countered` (both sides have offered) → `confirmed` (caller executes swap) / `cancelled`.

Rules: any unequipped items can be offered (multi-item, with quantities); one active trade per player-pair (across the system); blocked users cannot trade.

**Trades are asynchronous** — they persist across server restarts and survive movement, disconnect, zone changes. There is no same-room requirement. Either player can update their offer (via `counterTrade`) at any time; either player can confirm — but only when the OTHER player took the most recent action (`lastUpdatedBy` tracks this). On stack-capacity failure, the trade is left in `countered` state so players can adjust.

**Confirm nonce** — each `TradeState` carries a `nonce` minted on `proposeTrade` and rotated on every `counterTrade`. `confirm_trade` must echo the nonce of the offer the confirming player was shown; a missing or stale one is rejected with `TRADE_NONCE_MISMATCH` and the trade is left untouched in `countered` state. This binds a confirmation to one exact offer version, closing two holes that `lastUpdatedBy` alone does not: replaying a captured `confirm_trade` frame, and a partner swapping their offer while the other player's confirm is in flight (`lastUpdatedBy` still points at the partner after such a swap, so that guard passes). Trades persisted before nonces existed are backfilled with a fresh one on `restoreFromSaveData`. The server check alone cannot cover the *read-then-click* window: a partner who counters while the player is reaching for Confirm rotates the nonce, the modal repaints, and a naive client would re-arm the button with the new nonce — the swap would then pass every server guard (`lastUpdatedBy` still points at the partner). `SocialScreen` closes this by treating the nonce as an offer version: `tradeConfirmNonce` records the version the Confirm button is armed against and `tradeConfirmArmed` records whether Confirm was actually on screen. If the version changes while armed, `tradeAwaitingReview` is set, Confirm is replaced by a **Review Updated Offer** button, and the player must acknowledge the new offer before Confirm is live again. The first counter of a trade (Confirm not yet on screen) does not trigger the gate, so the normal flow is unaffected. The nonce is part of the modal's render key so a repaint is never skipped after an offer changes.

Because Hero › Gear opens this modal via `openExistingTrade` **without a screen switch**, the modal cannot rely on `SocialScreen`'s activate/deactivate subscription — it would paint from a frozen `lastSocial` and its Confirm would be permanently rejected. `renderTradeModal` therefore takes its own `gameClient.subscribe` for the modal's lifetime (released in `dismissTradeModal`), and both entry points call `refreshStateForTrade()` first, the same fresh-state idiom `showUserPopup` uses.

A rejection is sent as an `error` message carrying `code: 'trade_nonce_mismatch'` (see `ServerErrorCode`) plus a state re-sync; `GameClient.onServerError` lets the modal surface a `.trade-notice` explaining it, so Confirm never looks like a dead button. Only confirm is nonce-gated — replaying a `counter_trade` only rewrites the sender's own (re-validated) offer, which moves no items.

The trade modal repaints only from its own subscription and the nonce-error listener, both through `deferWhilePressed(tradeModalEl, …)` (see `client.md` → State-driven re-rendering), so a press on Confirm sends the nonce of the offer on screen even if a newer offer lands mid-press — the server rejects the stale nonce and the recovery above takes over. The nonce notice text is set immediately rather than in the held repaint, so a later push during the same press can't drop it.

Trades persist via `TradeStore` (`data/trades.json`); `GameLoop.init` calls `tradeStore.load()` and `restoreFromSaveData`, and the periodic save serializes via `getAllTrades()`. Client trade UI is a modal overlay (item picker + side-by-side offers) opened from the user popup or from the trade rows on Hero › Gear (trades waiting on you on top, sent ones below the inventory). It has a header X, a scrolling body and sticky actions with Confirm as the full-width primary; the list keeps its scroll position across quantity taps and jumps back to the offers when the review gate goes up. Items show art, sorted by rarity, and the trade and gift pickers share one code path. Cancel and Decline go through `confirmDialog`. The Hero tab shows a dot and the Gear segment a count when a trade is waiting on this player.

## Gift mailbox (async)

Players can send gifts to anyone (no same-room requirement) via the user popup "Send Gift" action. Implementation lives in `MailboxSystem` (`server/src/game/social/MailboxSystem.ts`); each `MailboxEntry` holds a single `(itemId, quantity)` from a sender. Mailbox entries are NOT merged — sending multiple gifts of the same item produces multiple entries. This deliberately permits a player to "hold" more than `MAX_STACK` of an item by leaving copies in their mailbox; **accepting** is what's gated by the 99-stack inventory cap.

On accept, the gift is added to the recipient's inventory (rejected with a warning if it would overflow); on deny, the gift is sent back to the original sender's mailbox marked as `returned: true` (re-denying a returned gift drops it instead of ping-ponging). Mailboxes are kept in `MailboxSystem` at runtime, saved to `MailboxStore`, and exposed via `ClientSocialState.mailbox`. They don't depend on the recipient having a session, so a gift to someone offline or who has never connected is safe.

A gift action only changes memory. `PlayerManager.saveAll` writes mailboxes and players together in the periodic pass, so a hard crash rolls a gift back along with everything else from the last 30 seconds, and the two sides can't disagree. Don't save one player's file on a gift: trades also change two players in memory only, and a single newer file would split one across a crash. Within the pass, the mailbox file first gets new entries while keeping removed ones, including any added and removed since the last pass, then the players are written, then the removed entries go. A crash mid-pass can therefore leave an extra copy of an item but can't lose one. Suspending a player runs a whole pass too, for the same reason. If the mailbox file can't be written, it is logged and the players are still saved, so a gift sent during that fault is lost if the server then restarts.

Suspended accounts can't be sent gifts, and neither can anyone who has blocked the sender or been blocked by them. Both get the same refusal, so it doesn't reveal a block. A gift can't be declined once its sender's name has no account. Refusals carry the `gift_refused` code, and `SocialScreen` shows them as a toast, except "Gift not found", which is what a double tap gets once the first tap has worked. UI lives on Hero › Gear with a Mailbox section on top (Accept / Decline buttons per entry) and the trade rows.

## Social badges

Red dot on the Social tab when there are pending friend requests or party invites. Segment counts: Party (pending invites), Friends (incoming friend requests). Trades and gifts badge the Hero tab instead. The rail's Chat tab and the strip show one unread count, driven by `ChatPopout`.

## Social state

`ClientSocialState` is included in every `ServerStateMessage.social`. Contains friends, incoming/outgoing friend requests, guild info, guild members, party info, pending party invites, outgoing party invites (sent by this player), online players list, all registered players list (as `PlayerListEntry[]` with className and level), blocked users, chat preferences (send channel + DM target), and the player's notification inbox + preferences (see [`notifications.md`](notifications.md)). `PlayerManager` builds this via `getSocialState()` callback on each `PlayerSession`.

Incoming friend requests also fire a `friend_request_received` notification, and an accepted outgoing request fires `friend_request_accepted` for the original sender (including the auto-accept case when both sides happen to request each other).

## Henchmen in the party

Hired henchmen live in `GamePartyInfo.henchmen: HiredHenchman[]`, a **sibling** of `members` — never inside it. `members` means accounts: ~70 server call sites resolve one to a `PlayerSession`, transfer ownership to one, or notify one. A henchman in that array makes each of those wrong silently rather than at compile time, so ownership transfer, room-entry gating and battle-timer teardown all stay correct by construction. The one place henchmen are counted on purpose is the victory payout (below).

**Several henchmen per party, each a different one.** `MAX_HENCHMEN_PER_PARTY` is `MAX_PARTY_SIZE - 1`, so henchmen can fill every seat a real player isn't using, and a party never holds two hires of the same `henchmanId`. Both rules are enforced in `PartySystem.hireHenchman` and again in `restoreHenchmen`, which drops duplicates and anything beyond the cap or the party's free seats from older saves. The cap is a named constant because it is a balance decision, not a structural one.

When there's no room, `hire_henchman` carries `replaceInstanceId` to **swap** a specific hire out. The outgoing hire is excluded *before* the uniqueness and seat checks and the newcomer inherits its grid square, so a full party can still change who it has hired and the formation survives the swap. Every refusal leaves the roster untouched. `ShopPopup` marks henchmen the party already has as "In party", labels the button Replace when there's no free seat ("Party full", disabled, when the seats are all players), and asks which hire should leave, showing each hire's level. A party that is full of *players* has no henchman to swap, so it still gets the plain "Party is full" refusal.

**Rewards.** A henchman takes a share of a victory without receiving it: the XP and gold divisor in `PartyBattleManager.handleBattleEnd` is members plus henchmen, and each dropped item goes to one random share, counting a henchman by its hidden class for class-restricted items. A share that lands on a henchman is discarded. Hiring help fills seats; it never out-earns partying with real players. Inside a dungeon henchmen take no share at all, because they aren't in the fight (below). A henchman's fixed skills do count toward the party's XP bonus (Bard Inspiration), the same way its Rally or Nimble count in combat.

The two rosters **share** the nine grid squares. `PartySystem` allocates across both through one `occupiedPositions` helper — the only place that knows it — so two occupants can never land on one square. Henchmen count toward `MAX_PARTY_SIZE` everywhere, invites included.

**Balance**: henchmen are *typically* worse than a party mate, not *strictly* worse. Nothing in code ties a henchman's stats to the party's lowest level — stats are fixed content, so balance is a job for whoever authors the definition and picks which shop and map it appears on. Henchmen also count toward party-size-scaled effects (Bard Rally, Nimble Dodge, Unnerve, party-wide cooldown reduction) exactly as a player does, which is deliberate: a hire is a real contribution, not a pure handicap. Superseded the original "must be lower than the lowest party member / last resort" rule — see `ideas/backlog-2026-april.md`. In level-relative scaling a henchman counts as a *derived* level, so its fights never apply a level gap (its `level` still drives its own per-level passives and heals), and forecasts don't count it as a human toward the "bosses are built for groups" hint. See `combat.md` → Level-relative scaling.

**Roles**: hiring and moving a henchman are gated on the invite role, dismissing on the kick role (owner or leader). The client hides those affordances for plain members rather than letting the server refuse silently.

**Identity**: a henchman's combat name is its definition name, disambiguated with ` #2`/` #3` against both other henchmen and the party's real usernames (`henchmanDisplayNames`). `PartyCombatant.username` is interpolated verbatim into ~25 combat-log lines and keys DoT attribution and heal-target prose, so a henchman sharing a name with a member would corrupt combat, not just prose.

**Dungeons**: henchmen wait at the entrance. They don't block entry, aren't in floor combat, take no share of dungeon rewards, and rejoin when the run ends by any path; a hire made mid-run waits too. Hire and dismiss go through `PartyBattleManager.henchmenChanged(partyId, joined?)`, which restarts overworld combat around the new roster but leaves a dungeon fight running. See `content.md` → Dungeon system.

**Member details on the wire**: `GamePartyMember.level` and `className` are filled in at send time by `PlayerManager.resolvePartyMembers` inside `getSocialState` — copies, never stored on `PartySystem` members and never persisted. The dungeon popup's eligibility preview reads them.

**Map scoping**: a hire is scoped to the map it was made on, dismissed immediately after either `ServerParty.switchMap` call — the transition the party chose, and the forced relocation a content deploy causes. Departures are announced in the combat log.

**Client**: `SocialScreen` renders henchmen in the 3x3 grid and the party list with a photo (`artworkUrl`, emoji fallback) and a Henchman badge. They carry no `data-username` and no clickable-name class, so the user popup, DM, trade, gift, friend-request, block, promote, demote and transfer flows — all of which resolve a real account — can never reach one. The only actions are Dismiss and moving on the grid.
