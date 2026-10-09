# Client shell, screens, and rendering

## Multi-screen app shell

DOM-based screen switching. `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-creates the three.js world map on first visit. A persistent XP bar sits directly above the bottom nav, visible on every game screen.

## Bottom nav structure

Six tabs, three behavioral modes:

- **Combat**, **Map**, **Char** (the merged Char+Items "Inventory" tab), **Craft**, **Settings** — standard screen switches via `ScreenManager`.
- **Social** — `mode: 'submenu'`. Tapping opens a fly-out with three sub-views: Party (default, badge `party-invites`), Guild, Leaderboard (badge `friend-requests`). The legacy in-screen pill bar is gone.
- **Chat** — `mode: 'overlay'`. Pinned to the far right as a chevron button (▲ when closed, ▼ when open). Tapping toggles the global `ChatPopout` overlay rather than swapping screens. Unread state lights up the Chat nav badge.

Nav icons render as `<img>` tags from `/nav-icons/{id}.png` with a `placehold.co` fallback (`navImg(id, label)` helper in `App.ts`). Static mount lives in `server/src/index.ts`.

## Per-player game state

Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.

## GameClient subscriber pattern

`subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).

`sendRaw` returns `false` when the socket isn't open and the message was dropped; `sendAcceptQuest`, `sendTurnInQuest`, `sendEnterDungeon` and `sendShopBuy` return it so their popups can say `OFFLINE_NOTICE` ("You're offline — reconnecting…") at once instead of waiting on a reply that will never come. `onServerError` listeners receive `(message, code?, detail?)`; `detail.questId` correlates a `quest_refused` error with the quest that was refused.

## State-driven re-rendering

The server pushes a full state at least once a second (every combat tick, and combat never stops), and `GameClient` fans each push out to every subscriber synchronously. A subscriber that rebuilds its DOM on a push can therefore replace a button between the player's press and release. Browsers don't deliver a click whose pressed element was removed, so the click is silently lost — the cause of #398 ("Accept does nothing"), and of a string of earlier one-off fixes.

`client/src/ui/render.ts` holds the two primitives every state-driven component uses:

- **`deferWhilePressed(root, paint)`** runs `paint` now, or — while a pointer press that started inside `root` is in flight — holds it until that press's click has run, then runs only the latest held paint for that root. Document-level capture listeners track the press: the flush happens on a macrotask after `click` (so the click's own handlers see the DOM the player pressed), 400 ms after a `pointerup` with no click, at once on `pointercancel` (a scroll took over) or window blur, and after at most 5 s. A press outside `root` never holds it, so map pans don't freeze panels.
- **`setHtml(el, html)`** writes `innerHTML` only when it differs from what `setHtml` last wrote to `el`, so identical pushes keep the same nodes (hover, focus, scroll and image loads survive).

Rules for adopters:

- Wrap only renders that are *not* the player's own action — state subscriptions, server-error and notification listeners, timers. A render inside a click handler stays immediate.
- Wrap the whole subscription body, read `gameClient.lastState` at flush time, and re-check visibility: the click that ended the press may have closed the component.
- Every write to a `setHtml`-managed element goes through `setHtml`, including clearing it on hide; a raw `innerHTML` write desyncs the cache and the next identical render is skipped.
- Prefer one delegated click listener on a stable root over per-render listener wiring.

An equality guard alone isn't enough: components that show live numbers (gold, inventory counts, quest progress, relative times) really do change mid-press, which is what `deferWhilePressed` covers. Adopters: `NpcTalkPopup`, `ShopPopup`, `DungeonEntryPopup`, `CharItemsScreen`, `CraftingScreen`, `NotificationCenter` (the open dropdown's list; the badge updates immediately), `SocialScreen` (panel and trade modal), `ChatPopout` (timeline rebuilds from incoming messages; filter clicks render directly), `CombatScreen` (`updateVisuals` held on `.combat-stage`, the append-only log never held), `RoomStatusPanel` and the Quest Log. `RoomView`, `ItemPopup` and other render-on-open popups don't subscribe and need neither.

## World map (three.js)

`client/src/ui/ThreeWorldMap.ts` renders the world map with **three.js (WebGL)** plus a sibling HTML overlay. The split:

- **WebGL canvas** owns the static layers only — parchment background, drop shadow, baked tile composite. These are uploaded as textures and the per-frame work collapses to a camera-matrix update; pan/zoom are essentially free GPU operations.
- **`.three-map-overlay` HTML div** sits on top of the canvas and hosts every *dynamic* element — party sprite, room-action markers, other-player flags, count badges, hover highlight, path preview. The overlay carries a single `transform: translate(W/2, H/2) scale(zoom) translate(-camX, -camY)` mirroring the three.js camera, so a single style update moves every child together when the user pans/zooms (no per-child JS). Children are absolutely positioned in world coords (`left:Xpx; top:Ypx`) and centered via `translate(-50%, -50%)`.
- **Tooltip** is a separate cursor-positioned `.canvas-map-tooltip` element (no map transform), desktop only (touch moves always pan). For an explored room it lists `{zone}: {room}`, one line per room action, then `👥 N players here` — a count, never names; names are revealed only by clicking the room. Unexplored rooms show `{zone}: Unexplored Room` and nothing else.

**Hex slots**: each room's overlay children keep to fixed slots so they never stack — other-party flag top-centre, player-count badge top-right (anchored at its left edge so it grows outward), 🗝️ delving key top-left, room-action marker bottom-centre, party sprite in the middle (24px with a see-through fill so the room shows through). Markers and badges counter-scale as the map zooms out: `updateOverlayTransform` sets `--map-zoom` on the overlay and the CSS scales them by `clamp(1, 0.75 / zoom, 1.8)`, so they stay legible at `MIN_ZOOM`.

**Render-on-demand**: there's no always-on RAF loop. `requestRender()` schedules a single render on the next animation frame, coalescing multiple state pushes into one. An anim loop runs only while the spring-back is active (overdrag → bounce). Party movement and the party pulse live entirely in CSS (`transition: left/top 400ms ease-in-out` on `.three-map-party` matches `MOVE_DURATION`; pulse is a CSS keyframe), so they don't drive any JS or WebGL work. Idle map screens cost effectively zero.

**Tile layering** (unchanged from the prior Canvas2D renderer): every tile renders in three stages — tile-type color (always; darkened per fog/zone-unlock factor), real artwork overlay if uploaded (`/tile-artwork/{id}.png` → `/tile-type-artwork/{type}.png`, NO placehold.co fallback so missing art falls through), otherwise the tile-type emoji glyph centered in the hex. Tile artwork is baked into hex-clipped offscreen sprites in `hexSpriteCache` on first load — the bake then draws each sprite with a single `drawImage(sprite)` (no `clip()` call).

**Static-layer bake → texture**: the full static composite (tile fills + artwork + outlines + zone overlay + zone borders) is baked once into an offscreen canvas at zoom=1 in world coords, wrapped as a `THREE.CanvasTexture`, and rendered as a single textured quad in the WebGL scene. The cache is invalidated (`staticDirty = true`) on grid rebuild, unlock-set change, current-zone change, and artwork image-load — invalidation triggers a re-bake + texture re-upload on the next `render()`. Compared to the prior Canvas2D approach, the per-frame blit is replaced by a GPU-side transform on an already-uploaded texture, which is what drives the perf win.

**Map drop-shadow**: silhouette baked at zoom=1 in world coords, pre-blurred into a padded offscreen, uploaded as a CanvasTexture, drawn as a black-tinted quad at 50% alpha at z=1. Offset is in world units (40, 60) so it scales naturally with zoom — no scale-shrink (which used to drift the shadow inside the map on larger islands).

**Parchment**: a fixed 8000×8000 plane at z=0 with the tiled parchment texture. Each frame its world position is set to `camWorld × (1 − 0.3)` so it follows the camera at 70% rate — i.e. apparent shift on screen is only 30% of the world's, giving the "deeper" parallax feel. The texture is **per-map** (`/parchment-artwork/{mapId}.png`, uploaded in the admin Maps tab): `loadParchment(mapId)` loads it on init and reloads on map switch, discarding stale loads if the map changes mid-fetch.

## Room actions

`client/src/ui/RoomActions.ts` is the single vocabulary for what a room offers, shared by the map markers, the tooltip, both RoomView states and the room status panel. `getRoomActions(room, lookups, quests)` takes `quests: QuestMarks` (`questMarks(state)` → `{ ready, available }`: ready from active quests with status `ready`, available from `state.availableQuestIds`) and returns, in order: the NPC (its own emoji; detail "Quest ready to turn in" plus a gold `?` pip when one of its `questIds` is ready to turn in, otherwise detail "New quest available" plus a green `!` pip when one of them is available — `questPipClass(action)` picks `.quest-ready-pip` / `.quest-available-pip` for every surface), the shop (🪙 if it sells items, 🤝 if it only hires henchmen, detail "Henchmen for hire" when it does both), the dungeon entrance (🗝️), and one travel point per map transition (🌀, named after the destination room, else its map, else "a passage"). Ids that don't resolve are skipped. Lookups come from `WorldCache` (`getNpc`, `getShop` → `ShopSummary` from `/api/world`, `getDungeon`, `getTileByGuid`, `getMaps`), so remote rooms need nothing beyond the login payload.

**Explored rooms only**: markers, tooltip lines and the remote popup's list appear only on rooms `worldCache.isUnlocked` (the same rule that reveals a room's name). The map draws one marker per explored room with at least one action — up to three icons on a dark pill, then `+N`; several exits collapse into a single 🌀. `ThreeWorldMap.updateMarkersOverlay` rebuilds markers only when the grid is rebuilt (unlocks, map switch, content reload) or `questMarkerKey` changes (sorted ready ids, available ids and quest targets), not every tick.

## Quest destinations

`client/src/ui/QuestTargets.ts` `pendingVisitTargets(activeQuests, questDefinitions)` maps each room GUID a visit objective still needs to the quests sending the player there, skipping quests already ready or completed. `ThreeWorldMap` outlines each target on the current map (resolved with `WorldCache.getTileByGuid`; targets on other maps are skipped) with a pulsing dashed green hex in the `.three-map-quest-targets` layer, between the path and marker layers. Targets show **even on unexplored rooms** — the server already ships their names in `questResolutions` — and the hover tooltip adds a `📜 {quest}` line per quest, after "Unexplored Room" when the room is unexplored (the room name stays hidden there). Quest text names a visit target as "{room}, {zone}" (`QuestText.roomText`; fallbacks "a room in {zone}" and "a specific room") — never coordinates.

## Map toast

`client/src/ui/MapToast.ts` `showMapToast(container, msg)` is the one toast on the map: move refusals (`move_blocked`), the client-side refusals (in a dungeon, not owner/leader) and `dungeon_entry_refused` errors that arrive while `DungeonEntryPopup` is closed (an open popup shows them itself). It sits top-centre on phones and bottom-centre from 768px, where the room status card takes the top-left. One toast at a time; a new one replaces it. It stays up `clamp(2000 + 60 × characters, 5000, 9000)` ms, passed to the CSS fade as `--toast-ms`, and a tap dismisses it.

## Room status panel

`client/src/ui/RoomStatusPanel.ts`, owned by `MapScreen`, shows what the party's current room offers as chips that run the same handlers as the RoomView buttons (`MapScreen.runAction` → `talkTo` / `openShop` / `enterDungeon` / `enterTransition`, with the same in-dungeon and owner/leader checks). NPC chips carry the same `?`/`!` pips as the map. Extra chips: `👥 N` when players outside your party share the room (opens the current-room RoomView, where names are listed), and a non-interactive `🗝️ {dungeon} · Floor x/y` while delving. Desktop (≥768px) is a labelled card top-left with a `{zone} · {room}` header; mobile is icon-only round chips bottom-left, clear of the zoom controls, move toast and notification bell, and hidden when there is nothing to show. The DOM is replaced only when the content key changes, and never mid-press (`deferWhilePressed`), and taps are stopped (`pointerdown`/`mousedown`/`click`/`touchstart`) so they don't pan or click the map — `mouseup` is deliberately left alone so a map drag released over the card still ends.

## RoomView (replaces TileInfoModal)

Clicking a tile opens `client/src/ui/RoomView.ts` with three states:

- **Current room (you're here)** — near-full-screen, background image (`/room-bg-artwork/{zoneId}-{col}-{row}.png` with `/room-bg-artwork/{zoneId}.png` fallback), party-grouped player list (your party in a gold-bordered box, then one bordered box per other party), one button per room action (the shop button shows `/shop-artwork/{shopId}.png`), click any player to open the user popup. While the party is walking a route (`state.party.path` non-empty) a **Stop here** button sends a move to this room: the server clears the route if the party is still on it, or walks it back if it has already moved on.
- **Remote room (discovered)** — smaller centered popup with name, an "In this room" list of the room's actions (explored rooms only, informational), the same party-grouped player list (when other parties' players are on the tile), and a "Go to room" button. The popup scrolls when a room holds many players.
- **Undiscovered** — same small popup with an "unexplored" hint.

Grouping logic lives in `RoomView.groupPlayersByParty` and depends on `partyId` arriving on each `OtherPlayerState`. Each rendered tile passes through `renderPartyBox(members, label, partyClass)`.

Travelling from a remote-room view to your party arriving at that tile triggers an arrival expand animation (`.room-view-arrival` class with timed CSS transition). `MapScreen.showRoom` sets `roomView.actions` before showing: for the current room, `MapScreen.currentRoomActions` (shop only when `state.shopDefinition` is present, named from it; dungeon and travel dropped while `state.dungeon` is set); for a remote explored room, `getRoomActions` on its tile. Every button goes through one `onAction` callback into `MapScreen.runAction`.

## Dungeons (client)

When the current room is linked to a dungeon (`tileDef.dungeonId`, looked up via `WorldCache.getDungeon(id)` — catalog fetched once from `GET /api/dungeons`), `RoomView` shows an "Enter {name}" button. Tapping it opens `DungeonEntryPopup` (flavor, floor count, requirements, eject warning).

**Eligibility preview**: `previewDungeonEntry(dungeon, state)` (`client/src/ui/DungeonEntryCheck.ts`) runs the shared `validateDungeonEntry` — the server's own validator, so the wording matches — over the party's players: levels and classes from the members' resolved `level`/`className` (else `social.allPlayers`; the viewer from `state.character`), and the viewer's own required item with the server's rule (unequipped when consumed on entry, otherwise owned). Other members always count as holding the item, since the client can't see their bags. If any member can't be resolved it returns `null` and the server stays the judge. Henchmen are never members, so they never block or count toward party size. When the preview blocks entry, Enter is disabled and a visible "⚠ {reason}" line sits right above it (visible text, not a tooltip — mobile has no hover). The popup re-evaluates on every push, so levelling up or a party change re-enables Enter without reopening it. If the party has henchmen, a line says they'll wait at the entrance. The item name comes from `state.itemDefinitions`, else "a key item", so it can differ from the server's wording for an item the viewer has never owned.

**Entering**: Enter sends `enter_dungeon` once and shows "Entering…" until `state.dungeon` is set (the popup closes), a `dungeon_entry_refused` error arrives (shown inline, retry allowed), or 5 s pass ("No answer from the server. Please try again."). The popup also closes when the party leaves the entrance room. Entry is server-authoritative; every `enter_dungeon` refusal carries `code: 'dungeon_entry_refused'`, shown by the popup while it's open (`isOpen`) and as a map toast otherwise. While inside a dungeon, `ServerStateMessage.dungeon` (`DungeonRunInfo`) is set: `CombatScreen` swaps the run bar for an in-dungeon banner (dungeon name + "Floor X / Y" + a "Leave Dungeon" button, owner/leader-gated like Run), and `MapScreen.tryMove` blocks overworld travel until the party bails out. See `docs/architecture/content.md` → Dungeon system for the server side.

## Multi-map travel (client)

The client renders only the map the party is on. `ServerStateMessage.currentMapId` drives `WorldCache.setCurrentMap`; when it changes, `ThreeWorldMap` rebuilds its grid from the new map's tiles, recenters the camera, snaps the party sprite (no tween across the discontinuity), and filters the other-player flag overlay to that map (`OtherPlayerState.mapId`). When the current room has `transitions`, `RoomView` shows one 🌀 "Travel to {destination}" button per exit (destination names resolved via `WorldCache.getTileByGuid`); tapping one sends `enter_transition` with that target `tileId` (owner/leader-gated, blocked inside a dungeon). No confirm popup: transitions may be gated (see `docs/architecture/content.md` → Room entry requirements), but the check is server-authoritative and a refusal comes back as a `move_blocked` message that surfaces in the same map toast as a blocked move. The client cannot preview these gates — party members' equipment and completed quests are not in `GamePartyMember` (their level and class are), and gate items/quests the player has never encountered have no name in `itemDefinitions` — so transition buttons stay enabled. See `docs/architecture/content.md` → Multi-map for the server side. (A zoomed-out overworld/map-select for players is out of scope — issue #168.)

## Inventory screen (merged Char + Items)

`CharItemsScreen` is a single scrollable column containing the old Char and Items screens together: hero card with class portrait (loaded from `/class-artwork/{class}.png`), equipped gear, skill loadout (slots per the class's content-driven slot schedule, fetched via `WorldCache.getSlotSchedule`; clicking opens a popup with all unlocked skills of the matching type plus any skills currently granted by equipped items/sets — no auto-shuffle on placement), condensed stat card (ATK/DR/MR/HP with click-to-show tooltips), and inventory grid. Skill points are gone — skills auto-unlock at each skill's content-defined `unlockLevel`; equipping the slots is the only constraint. See `docs/architecture/content.md` → Skill system for the full content model.

The inventory grid groups items with visible headers when sorted by Rarity or Type (Newest stays chronological). Clicking an item opens a popup with full details and equip/unequip/drop actions, plus a comparison with what equipping it would replace. The comparison is `renderEquipCompareBlock(newDef, equipment, itemDefs)` (`client/src/ui/EquipCompare.ts`, shared with the shop): it compares against every item the shared `getItemsDisplacedByEquip` reports, so a two-handed weapon is compared against main hand plus offhand (summed, names joined with " + ") and a one-handed item against an equipped two-hander. It renders nothing when the slot is empty.

Legacy sessionStorage `activeScreen=character` migrates to `items` on load.

## ChatPopout (global overlay)

`client/src/ui/ChatPopout.ts` is mounted into `#chat-popout-root` (a `position: fixed; inset: 0; pointer-events: none` ancestor outside `#app`). On desktop: floating window with grabbable header, freely resizable, geometry persisted to `localStorage['chatPopoutGeometry']`; clamped to viewport. On mobile: full-screen or fixed bottom-sheet (toggle via the popup's layout button; preference persisted to `chatPopoutMobileLayout`).

Mobile sheet mode also sets `body.dataset.chatLayout = 'sheet'` so the screen container can dock — when both `data-chat-open="1"` and `data-chat-layout="sheet"` are set, `#screen-container` flex-shrinks by `chat-sheet-height + nav-height + xpbar-height` and `#persistent-xp-bar` gets `margin-top: auto` so the nav+xpbar pin to the actual viewport bottom. The result is that chat slots cleanly between screen content and nav instead of overlaying them. Drop shadows are removed on mobile so the chat reads as a top-level layout bar.

Filters per channel (color-coded), unified timeline with timestamps. Sender names and channel tags are clickable: sender opens the user popup via `setOnUserClick`, tag switches the composer send channel (DMs auto-fill the target with the "other party"). Server-channel messages render as plain spans (no popup, no channel switch).

Whenever the popout is open with `dm` selected as the send channel, it reports that thread to `ChatFocusTracker` (`client/src/network/ChatFocusTracker.ts`) so the server suppresses DM notifications for it — see [`notifications.md`](notifications.md).

## NotificationCenter (global overlay)

`client/src/ui/NotificationCenter.ts` is mounted into `#notification-center-root` (another fixed root outside `#app`, alongside `#chat-popout-root`), so — like `ChatPopout` — it survives every screen switch. A bell button fixed at top-right shows an unread-count badge; clicking it opens a dropdown (via `ModalStack`) listing the inbox newest-first. Each row's main area marks it read on click and, for party/friend-request/DM notifications, navigates to the relevant screen; a small "×" per row dismisses (permanently removes) it, and the header has "Mark all read" plus a confirm-gated "Clear all". Live pushes (`GameClient.onNotification`) also spawn an auto-dismissing toast in a separate fixed stack, sharing the same mark-read/navigate click behavior, independent of whether the dropdown is open. Full details in [`notifications.md`](notifications.md).

Notification channel/category preferences are a modal opened from a new "Notifications" button on `SettingsScreen` (`client/src/ui/NotificationPreferences.ts`) — a category × channel checkbox grid in the same `.player-options-*` modal shell as the Quest Log.

## NPC talk popup

`client/src/ui/NpcTalkPopup.ts` opens from "Talk to {npc}" and lists that NPC's quests in three sections: Ready to Turn In, In Progress, Available. It builds its shell once and repaints each region with `setHtml` under `deferWhilePressed` (see State-driven re-rendering), with one delegated click listener dispatching on `data-action`, so an Accept button stays the same node across combat and progress pushes and the scrollable modal keeps its scroll position. The backdrop closes the popup only when both `pointerdown` and `click` landed on it, so a press that starts inside the modal and drifts off it doesn't close it.

- **Eligibility**: Available lists the NPC's offered quests that are in `state.availableQuestIds`, so the popup, the map's `!` and the Quest Log all follow the server's rules and clock. A solo quest while the party has more than one player is listed with `SOLO_QUEST_IN_PARTY_REASON` in place of Accept; other quests stay hidden.
- **Pending requests**: Accept / Turn In show "Accepting…" / "Turning in…" (`aria-disabled`, never the `disabled` attribute) and ignore repeat clicks. An accept resolves when the quest appears in `activeQuests`; a turn-in when it moves to `completedQuests`, which also queues the NPC's `completionText` speech bubble. Requests settle when the push arrives, not in the held repaint, so a long press can't outlive the reply timer. A `quest_refused` error with the matching `questId` shows the server's reason inline for 4 s, scrolled into view; 5 s without an answer shows "No answer from the server. Please try again."; a send that couldn't go out shows the offline notice and sets nothing pending.
- **Leaving the room**: when `state.questGiverNpcId` no longer matches the NPC (the party moved on), the popup stays open with "{npc} is no longer nearby." and no quest sections or buttons — `offeredQuestIds` now belongs to whoever is in the new room.

## Quest Log

`client/src/ui/QuestLog.ts` is a modal opened from Settings → **Quest Log**. It reads only what every state push already carries — `activeQuests`, `completedQuests`, `weeklyCompletions`, `questDefinitions`, `questResolutions`, `unlocked` — plus `WorldCache.getAllNpcs()` / `getRoomsWithNpc()`. Active quests show by default, ordered by `QuestLogModel.sortActiveQuests`: ready to turn in first, then in progress, then accepted, oldest accepted first within each. Each card shows status and scope pills, description, objectives with progress, rewards, and "Turn in to: {npc} — {room}, {zone}" for every NPC that lists the quest (rooms only when explored; `turnInLocations`). Completed quests sit behind a "Completed (N)" toggle that starts collapsed every time the log opens; rows fold weekly repeats into one (`×N`) and show "Available again {date}" from the server's `weeklyCompletions` clock. A quest deleted from content shows as "Unknown quest". A **Quests available from** block at the top lists each NPC whose `questIds` overlap `state.availableQuestIds`, as "{emoji} {npc} — {room}, {zone}" (`giverLocations` in `QuestLogModel.ts`, next to `turnInLocations`), naming explored rooms only — an NPC whose rooms are all unexplored isn't listed. The log re-renders only when its HTML changes and never mid-press, keeping scroll position and the toggle. Quest text helpers (`objectiveText`, `rewardsText`, `statusLabel`, `scopeBadgeHtml`) live in `client/src/ui/QuestText.ts`, shared with `NpcTalkPopup`, and both use the shared `.quest-card` / `.quest-pill` styles.

## Combat cards

`CombatScreen` renders each combatant as a small card on a 3×3 grid — portrait image (top), name, HP bar with numeric overlay. Player portraits load from `/class-artwork/{class}.png` with a class-icon fallback; monster art loads from `/monster-artwork/{id}.png` (keyed by the monster definition id, matching the admin upload; a slug of the name is used only when the payload carries no id) with a placehold.co fallback. Player cards highlight the current user in gold; dead combatants dim; stunned combatants show a "💫" badge. Cards arrange on the grid via CSS-grid mapping their `gridPosition`. Clicking a player opens the user popup; clicking a monster opens the monster popup (name + image + optional flavor description from `MonsterDefinition.description`).

Per-turn animations (`updateCombatAnimations`) toggle `.attacking` / `.hit` / `.dodged` classes on the card itself (not an inner element) — keyframes `attack-lunge-right/-left`, `hit-flash`, `dodge-sidestep`. On mobile, `.combat-tray` is `overflow: visible` inside the narrow-viewport `@media` block so the lunge can extend into the inter-tray gap without clipping at the tray edge.

**Combat backgrounds**: each combat stage has a CSS `background-image` chain `/combat-bg-artwork/{zoneId}-{col}-{row}.png` → `/combat-bg-artwork/{zoneId}.png` → `/zone-artwork/{zoneId}.png` → placehold.co. The key is the current room's raw `zone` tag (read off the `WorldCache` tile), matching what admin uploads are keyed by — **not** a slug of the zone's display name. Dimmed + scrim'd so cards remain readable.

## ModalStack

`client/src/ui/ModalStack.ts` manages click-order z-index across overlays. `bringToFront(el)` is called when a modal opens (and on `mousedown` so click-to-focus works like native windows); `release(el)` on close. `wireFocusOnInteract(el)` attaches the focus-on-click handler in one call. Every overlay in the app (RoomView, ChatPopout, NpcTalkPopup, DungeonEntryPopup, the Quest Log and Notifications modals, player popup, monster popup, the notification dropdown, etc.) routes through it — none should hard-code a `z-index`.

## PWA (installability + service worker)

`client/index.html` links `manifest.webmanifest` and sets the theme-color/apple-mobile-web-app meta tags; `client/public/sw.js` (plain, hand-written — not Vite-processed, just copied as-is to the build root) handles app-shell caching and the `push`/`notificationclick` events for the browser-push notification channel. `main.ts` registers it via `registerServiceWorker()` (`client/src/network/PushNotifications.ts`), which no-ops in dev (`import.meta.env.DEV`) so a stale service worker never shadows local changes. `admin.html` deliberately has none of this — only the player-facing client is installable. Full details in [`notifications.md`](notifications.md).

## Image-everywhere convention

`client/src/ui/assets.ts` exposes `artworkUrl(kind, id)`, `placeholderUrl(name, opts?)`, and `renderAssetImg(kind, id, opts)`. Convention: `<mount>/{id}.png`, falling through to `placehold.co` (and finally to the surrounding background color via CSS) so layouts always have shape.

The kinds themselves live in `ASSET_KIND_INFO` (`shared/src/assets/AssetKinds.ts`) — the single source of truth that the client `AssetKind` union, the server's Express static mounts, the vite dev proxy, the admin upload API, and the MCP asset tools all derive from, so adding a kind is one row there rather than five hand-kept lists that drift. (A static mount still needs a matching dev-proxy entry or the request silently falls through to the SPA index in dev; both lists are now generated from the registry, so they can't disagree.) `artworkUrl` just delegates to the shared `assetPublicPath(kind, id)` rather than spelling `/${kind}-artwork/`, because the three **icon sets** — `class-icon` → `/class-icons`, `slot-icon` → `/slot-icons`, `nav-icon` → `/nav-icons` — predate that convention and serve from their own mounts (a few older call sites in `App.ts`/`ItemIcon.ts` still hard-code those icon paths). All 16 kinds and their id formats are tabled in [`content.md`](content.md) → "Artwork & imagery".

**Remembered image outcomes**: `renderTrackedImg(src, opts)` (`assets.ts`) renders an `<img class="asset-img">` that starts hidden; capture-phase `load`/`error` listeners on `document` add `.asset-loaded` (shown, with a 120 ms fade) or try the `fallback` once, then `.asset-failed` (hidden). Outcomes are remembered per URL for the session, so a re-render of art that loaded renders already visible, and art known to be missing goes straight to its fallback — or renders nothing, leaving the caller's own placeholder — with no request and no flicker. `forgetMissingAssets()` runs on a world update and on tab resume so newly uploaded art is tried again. `renderAssetImg`, item-square art, the slot dogear, item popup artwork, NPC portraits and shop henchman portraits all use it; nav icons keep their inline fade. Item squares and the item popup show the item's initials underneath, hidden once the image loads (`.item-square-img.asset-loaded + .item-square-initials`); the image is an absolute overlay so the initials never shift while it loads.

**Item-square hover** is `filter: brightness(1.15)` plus an inset outline, only under `@media (hover: hover)` and never on empty slots. Don't use a transform there: a scaled square overflows its scroll container and brings up scrollbars. All `.item-square*`, `.item-dogear*` and `.item-popup*` rules live in `pixel-theme.css`; `CharItemsScreen`'s injected style block keeps only its rarity keyframes.

## Browser tab resume

On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly and the camera re-centres on it.

## Event-driven systems

Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scenes/screens subscribe for state sync.

## Hex coordinates

Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px.

## A* pathfinding

Hex distance heuristic with cross-track tie-breaker.

## Other players on map

Each state message includes `otherPlayers: { username, col, row, mapId?, zone, className?, partyId?, inDungeon?, dungeonName? }[]`. Players on a different map than the viewer are filtered out (so co-located `col,row` on another map don't render). `ThreeWorldMap` renders a flag per occupied tile in the same zone (colour hashed from the tile, so neighbouring stacks read distinctly) with a `×N` badge when more than one player stands there, and a `+N` badge on the player's own tile counting players outside your party so they aren't hidden behind the party sprite. `groupOtherPlayers` is the one counting rule (same zone, not in my party) shared by the flags, the tooltip count and the room status panel (`countOthersAt`). Positions update on each player's own battle cycle. `partyId` flows through to `TileClickInfo.playersHere` so `RoomView` can group co-located players into one box per party. A party delving a dungeon stays parked at the entrance tile; `inDungeon`/`dungeonName` drive a 🗝️ marker on that tile's flag (`.three-map-dungeon-key`) and a "🗝️ Delving {name}" tag on the party's box in the room popup, so it reads as "inside" rather than "standing around."

## Zoom controls

Mobile-friendly +/− zoom buttons on the map screen, wired to `ThreeWorldMap.adjustZoom()`.

## Desktop font scaling

`@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop. A four-tier font-size scale (`--fs-xs/sm/md/lg`) drives sizing globally with mobile/desktop overrides. The quest and NPC popups and the Quest Log use only these tokens, never below `--fs-xs`; a guard test in `NpcTalkPopup.test.ts` fails if a `.npc-talk-*`, `.npc-quest-*`, `.quest-card*`, `.quest-pill*`, `.quest-objective*` or `.quest-log-*` rule sets a px font-size under 11.

## Visual style

Pixel/retro RPG — Silkscreen body font + Pixelify Sans display font (replaced Press Start 2P in the May overhaul; the new fonts fix the 6/G readability problem). CSS custom properties for theming, CSS keyframe animations for battle states, global `b, strong { font-weight: normal }` reset since bold was illegible at small pixel sizes. All UI is vanilla HTML/CSS (no framework).

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages rebuild only the timeline element (through `setHtml`, held while a press is in flight), never the composer, so input focus and typed text survive; an unchanged rebuild doesn't force-scroll to the bottom.
