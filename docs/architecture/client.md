# Client shell, screens, and rendering

## Multi-screen app shell

DOM-based screen switching. `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-creates the three.js world map on first visit. The in-game shell is a column: **top HUD** (`#top-hud`), the screen container, a thin persistent XP bar, and the floating bottom nav. `index.html` uses `viewport-fit=cover`; every edge element pads with the safe-area tokens (`--safe-top/-bottom/-left/-right`), and overlay offsets use `--hud-total` (HUD + safe top) and `--nav-total` (nav + float gap + safe bottom).

**Top HUD** (`client/src/ui/TopHud.ts`, constructed in `App.enterGame()` next to `PersistentXpBar`): class avatar (`artworkUrl('class', …)` with class-icon fallback) + level badge, username, gold chip (`formatGoldChip`: full number below 10 000, else `12.3k` / `1.2M`), and `.top-hud-bell-slot`, which `NotificationCenter` mounts its bell into. Hidden until the player has a character and hidden again with the nav on suspension. The XP bar hides its own level label — the HUD badge shows the level.

## Bottom nav structure

A rounded floating bar (`--nav-height` 68px, `--nav-float-gap` above the safe area, capped at 720px and centred on wide screens) with seven slots in this order: **Map, Char** (merged Char+Items), **Craft, Battle** (combat), **Social, Settings, Chat**. Three behavioural modes:

- **Map**, **Char**, **Craft**, **Battle**, **Settings** — standard screen switches via `ScreenManager`.
- **Social** — `mode: 'submenu'`. Tapping opens a fly-out with three sub-views: Party (default, badge `party-invites`), Guild, Leaderboard (badge `friend-requests`).
- **Chat** — `mode: 'overlay'`. Pinned far right as a chevron button (▲ closed, ▼ open) that toggles the global `ChatPopout`. Unread state lights up the Chat nav badge.

**Battle** (`.nav-tab[data-screen="combat"]`) is the centre slot: the button keeps the full 72px grid column as its tap target, while its `.nav-tab-bg` is drawn as a 60px circle raised by `--nav-raise` above the bar (and above the XP bar). While fighting it shows a static glow ring (`fighting-pulse` class, no infinite animation); victory/defeat flashes stay. Labels are one line at `--fs-2xs`; at ≤ 400px wide only the active tab and Battle show labels. Every button carries `aria-label` = its tab label, so tabs stay named for screen readers when the label is hidden and the icon art is missing; the Chat chevron is `aria-hidden`.

Nav icons are content: each tab renders an emoji glyph (`.nav-icon-glyph`: 🗺️ 🎒 🔨 ⚔️ 👥 ⚙️) with the `/nav-icons/{id}.png` image layered on top; the image fades in on load (adding `.has-art`, which hides the glyph) and removes itself on error, so a server with no nav art still shows icons (`navImg(id, label, glyph)` in `App.ts`).

## Per-player game state

Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.

## GameClient subscriber pattern

`subscribe(cb, { replay? })` / `onCombat(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. Connection is deferred until `connect()` is called (after auth). `lastState` and `lastCombat` cache the newest `state` and `combat` messages.

State pushes are rare mid-fight (battle start, result, move, user actions), so a widget that mounts after the first push would otherwise stay blank until the next one. Pass `{ replay: true }` to receive the cached `lastState` immediately on subscribe — `TopHud`, `PersistentXpBar`, `BottomNav` and `NotificationCenter` do. `GameClient` also owns `combatLog` (a `CombatLogBuffer`, see Combat screen) and fills it from every state and combat message whether or not the combat screen is showing, and `sendCombatView(visible)` (deduplicated, re-sent when the socket reopens).

Other per-connection duties:

- **Presence.** `presence { visible }` is sent on every socket open and every `visibilitychange`, before `request_state` (separate from `combat_view`); the server uses it for the "while you were away" recap (see `combat.md`).
- **Forecasts.** `requestForecast(target)` returns the cached reply or `null` and sends `request_forecast`. Cache key = `forecastTargetKey(target)|partyKey`; `FORECAST_TTL_MS` 60 s (10 s for `unavailable`, `pending` never cached); at most one request in flight per target, retried after 15 s and re-sent on reconnect. The server keeps one explicit forecast per player, so a request for another target drops the older one: an `unavailable` reply for a target that is no longer the last one requested is passed to listeners but never cached, a target whose outstanding request was overtaken that way is asked for again, and the dropped request's reply is ignored while a newer request for the same target is in flight; a reply computed for an older party key triggers one automatic re-request. `peekForecast(target)` returns the latest `ok` reply whatever its party key or age — an `unavailable` reply (rate limit, dropped job) never replaces it, so `MapScreen` and `DungeonEntryPopup` render `unavailable` as that last estimate, dimmed with "updating…" (nothing when there is none); `denied` hides the forecast. `onForecast(cb)` delivers every `forecast` message, including pushed `{kind:'battle'}` live forecasts.
- **Bestiary.** `requestBestiary()` / `onBestiary(cb)` / `lastBestiary`. `requestBestiary()` returns the cached list while its version matches `character.mastery.version`, otherwise sends `request_bestiary` (at most once per 15 s while outstanding; re-sent on reconnect). Callers: opening `BestiaryModal`, activating the Char screen, and `MasteryToasts` on a snapshot. Between fetches the views merge `character.mastery.recent` (fresher) over the full list.
- **Combat prefs.** `sendSetCombatPrefs(pct)`.
- **Recap.** `lastRecap` / `lastRecapItemDefinitions` come from each state; `onRecap(cb)` replays on subscribe, fires once per recap id and with `null` when the recap clears (so other tabs close their modal); `sendAckRecap(id)` drops that id locally even if the server still sends it for a moment.

## World map (three.js)

`client/src/ui/ThreeWorldMap.ts` renders the world map with **three.js (WebGL)** plus a sibling HTML overlay. The split:

- **WebGL canvas** owns the static layers only — parchment background, drop shadow, baked tile composite. These are uploaded as textures and the per-frame work collapses to a camera-matrix update; pan/zoom are essentially free GPU operations.
- **`.three-map-overlay` HTML div** sits on top of the canvas and hosts every *dynamic* element — party sprite, other-player flags, count badges, hover highlight, path preview. The overlay carries a single `transform: translate(W/2, H/2) scale(zoom) translate(-camX, -camY)` mirroring the three.js camera, so a single style update moves every child together when the user pans/zooms (no per-child JS). Children are absolutely positioned in world coords (`left:Xpx; top:Ypx`) and centered via `translate(-50%, -50%)`.
- **Tooltip** is a separate cursor-positioned `.canvas-map-tooltip` element (no map transform).

**Render-on-demand**: there's no always-on RAF loop. `requestRender()` schedules a single render on the next animation frame, coalescing multiple state pushes into one. An anim loop runs only while the spring-back is active (overdrag → bounce). Party movement and the party pulse live entirely in CSS (`transition: left/top 400ms ease-in-out` on `.three-map-party` matches `MOVE_DURATION`; pulse is a CSS keyframe), so they don't drive any JS or WebGL work. Idle map screens cost effectively zero.

**Tile layering** (unchanged from the prior Canvas2D renderer): every tile renders in three stages — tile-type color (always; darkened per fog/zone-unlock factor), real artwork overlay if uploaded (`/tile-artwork/{id}.png` → `/tile-type-artwork/{type}.png`, NO placehold.co fallback so missing art falls through), otherwise the tile-type emoji glyph centered in the hex. Tile artwork is baked into hex-clipped offscreen sprites in `hexSpriteCache` on first load — the bake then draws each sprite with a single `drawImage(sprite)` (no `clip()` call).

**Static-layer bake → texture**: the full static composite (tile fills + artwork + outlines + zone overlay + zone borders) is baked once into an offscreen canvas at zoom=1 in world coords, wrapped as a `THREE.CanvasTexture`, and rendered as a single textured quad in the WebGL scene. The cache is invalidated (`staticDirty = true`) on grid rebuild, unlock-set change, current-zone change, and artwork image-load — invalidation triggers a re-bake + texture re-upload on the next `render()`. Compared to the prior Canvas2D approach, the per-frame blit is replaced by a GPU-side transform on an already-uploaded texture, which is what drives the perf win.

**Map drop-shadow**: silhouette baked at zoom=1 in world coords, pre-blurred into a padded offscreen, uploaded as a CanvasTexture, drawn as a black-tinted quad at 50% alpha at z=1. Offset is in world units (40, 60) so it scales naturally with zoom — no scale-shrink (which used to drift the shadow inside the map on larger islands).

**Parchment**: a fixed 8000×8000 plane at z=0 with the tiled parchment texture. Each frame its world position is set to `camWorld × (1 − 0.3)` so it follows the camera at 70% rate — i.e. apparent shift on screen is only 30% of the world's, giving the "deeper" parallax feel. The texture is **per-map** (`/parchment-artwork/{mapId}.png`, uploaded in the admin Maps tab): `loadParchment(mapId)` loads it on init and reloads on map switch, discarding stale loads if the map changes mid-fetch.

## RoomView (replaces TileInfoModal)

Clicking a tile opens `client/src/ui/RoomView.ts` with three states:

- **Current room (you're here)** — near-full-screen, background image (`/room-bg-artwork/{zoneId}-{col}-{row}.png` with `/room-bg-artwork/{zoneId}.png` fallback), party-grouped player list (your party in a gold-bordered box, then one bordered box per other party), shop/talk affordances, click any player to open the user popup.
- **Remote room (discovered)** — smaller centered popup with name/type, the same party-grouped player list (when other parties' players are on the tile), and a "Go to room" button.
- **Undiscovered** — same small popup with an "unexplored" hint.

Grouping logic lives in `RoomView.groupPlayersByParty` and depends on `partyId` arriving on each `OtherPlayerState`. Each rendered tile passes through `renderPartyBox(members, label, partyClass)`.

**Forecast slot.** An optional last constructor argument (a `RoomForecastProvider`; tests still construct `RoomView` with two arguments) adds a forecast chip after the header of the current room and after the name of a discovered remote room; tapping it opens the details popover. `forecastTileId` and `updateForecast(tileId, state)` let `MapScreen` push results in. `MapScreen` forecasts only explored, walkable rooms, and not the current room while in a dungeon. The room target's `tileId` is the WorldCache tile `id` (room GUID).

Travelling from a remote-room view to your party arriving at that tile triggers an arrival expand animation (`.room-view-arrival` class with timed CSS transition). Shop, NPC, and dungeon affordances on the current-room view are gated on `playerOnTile && state?.shopDefinition` / `tileDef?.npcId` / `tileDef?.dungeonId` respectively — wired in `MapScreen.setOnTileClick`.

## Dungeons (client)

When the current room is linked to a dungeon (`tileDef.dungeonId`, looked up via `WorldCache.getDungeon(id)` — catalog fetched once from `GET /api/dungeons`), `RoomView` shows an "Enter {name}" button. Tapping it opens `DungeonEntryPopup` (on `ModalStack`): flavor, floor count, requirements preview, a forecast card (verdict + headline, likely range, first-try %, reasons, sample size), a floor strip (boss, checkpoint, cleared, resume flag and per-floor %), "Resume: Floor 3 · Checkpoint 2 · 2 retries left" when the forecast key carries a resume point (`parseDungeonResume` reads `…|dungeon:<id>:<floor>:<phase>:<wipes>`; no client-state field holds stored checkpoints), and warning copy that switches to the checkpoint text ("Falling on the boss floor regroups your party at its last checkpoint…") when a floor has checkpoints. Non-leaders see it read-only with "Your party leader's progress decides where you start." and a disabled Enter. Confirming sends `enter_dungeon`. Entry is server-authoritative — failures come back as an `error` message. While inside a dungeon, `ServerStateMessage.dungeon` (`DungeonRunInfo`) is set: the combat header shows the dungeon name, a floor badge (`F3/5`, or `BOSS 5/5` on the last floor) and a **Leave** button (`.combat-dungeon-leave`, owner/leader-gated like Run) in place of Run — on a checkpoint floor with a fight under way it first opens a `ModalStack` confirm ("Leaving now counts as a defeat and uses up one retry. Leave anyway?", or that the checkpoint will be lost when no retries are left; `leaveDungeonWarning`), and `MapScreen.tryMove` blocks overworld travel until the party bails out. See `docs/architecture/content.md` → Dungeon system for the server side.

## Multi-map travel (client)

The client renders only the map the party is on. `ServerStateMessage.currentMapId` drives `WorldCache.setCurrentMap`; when it changes, `ThreeWorldMap` rebuilds its grid from the new map's tiles, recenters the camera, snaps the party sprite (no tween across the discontinuity), and filters the other-player flag overlay to that map (`OtherPlayerState.mapId`). When the current room has `transitions`, `RoomView` shows one "Enter {destination}" button per exit (destination names resolved via `WorldCache.getTileByGuid`); tapping one sends `enter_transition` with that target `tileId` (owner/leader-gated, blocked inside a dungeon). No confirm popup: transitions may be gated (see `docs/architecture/content.md` → Room entry requirements), but the check is server-authoritative and a refusal comes back as a `move_blocked` message that surfaces in the same map toast as a blocked move. The client cannot preview gates — party members' levels, equipment, and completed quests are not in `GamePartyMember`, and gate items/quests the player has never encountered have no name in `itemDefinitions` — so transition buttons stay enabled, matching `DungeonEntryPopup`'s descriptive-only precedent. See `docs/architecture/content.md` → Multi-map for the server side. (A zoomed-out overworld/map-select for players is out of scope — issue #168.)

## Inventory screen (merged Char + Items)

`CharItemsScreen` is a single scrollable column containing the old Char and Items screens together: hero card with class portrait (loaded from `/class-artwork/{class}.png`), equipped gear, skill loadout (slots per the class's content-driven slot schedule, fetched via `WorldCache.getSlotSchedule`; clicking opens a popup with all unlocked skills of the matching type plus any skills currently granted by equipped items/sets — no auto-shuffle on placement), condensed stat card (ATK/DR/MR/HP with click-to-show tooltips), and inventory grid. Skill points are gone — skills auto-unlock at each skill's content-defined `unlockLevel`; equipping the slots is the only constraint. Skill slots, the skill picker and the Social player profile show each skill's card-type chip plus `CD Ns`, cast time and trigger, rendered by `client/src/ui/SkillCardChip.ts` (`renderSkillCardChip` / `renderSkillCardMeta`). See `docs/architecture/content.md` → Skill system for the full content model. For Guard/Bless-style rating options `skillComputedLine` appends the exact on-level mitigation ("≈50 % vs same-level enemies").

**Bestiary.** A card on the Char screen (`BestiaryCard`) shows the kill-mastery summary (discovered / mastered), the 3 entries closest to their next rank and "View all ›", which opens `BestiaryModal` (on `ModalStack`): search, sort (Closest / Kills / Rank / Name), progress bars, rank stars, "Next rank at 250" and the damage bonus. Level badges appear only for authored levels, coloured by con relative to the viewer. The card is keyed on what it shows (counts, level, its 3 rows), not the global kill version, so kills of other monsters don't touch it. While open, the modal re-renders when `mastery.version` moves, at most once per `BESTIARY_REFRESH_MS` (1 s). Both patch rows in place by monster id (`syncBestiaryRows`): portraits, the View all button and focus survive a refresh.

**Mastery toasts.** `MasteryToasts` toasts a live rank-up worth a moment (`isMasteryMoment`) by comparing `mastery.recent` with the last rank it knew (seeded from snapshots and the bestiary; snapshot states never toast, ranks gained while away belong to the recap). A monster it has never seen counts as rank 0 only when `mastery.discovered` grew by at least as many unseen monsters, so a boss's first kill (rank 1) toasts while an old kill the client hadn't loaded yet does not. The toast is `role=status`, sits on `ModalStack` and opens the bestiary when tapped.

The inventory grid groups items with visible headers when sorted by Rarity or Type (Newest stays chronological). Clicking an item opens a popup with full details and equip/unequip/drop actions.

Legacy sessionStorage `activeScreen=character` migrates to `items` on load.

## ChatPopout (global overlay)

`client/src/ui/ChatPopout.ts` is mounted into `#chat-popout-root` (a `position: fixed; inset: 0; pointer-events: none` ancestor outside `#app`). On desktop: floating window with grabbable header, freely resizable, geometry persisted to `localStorage['chatPopoutGeometry']`. Dragging, resizing and viewport clamping all stay between the top HUD and the nav/XP bar/raised Battle circle — `getVerticalBounds()` measures those elements' rects via the pure helper `floatingVerticalBounds` (`client/src/ui/chatBounds.ts`), ignoring hidden ones. On mobile: full-screen (padded by the safe areas) or a fixed bottom sheet (toggle via the popup's layout button; preference persisted to `chatPopoutMobileLayout`).

Mobile sheet mode sets `body.dataset.chatLayout = 'sheet'` so the screen container docks: with `data-chat-open="1"` and `data-chat-layout="sheet"`, `#screen-container` flexes down and reserves `--chat-sheet-height` at its bottom, and the sheet sits at `bottom: calc(var(--nav-total) + var(--xpbar-height))`. Chat therefore slots cleanly between screen content and nav instead of overlaying them. On the combat screen the sheet is `clamp(160px, 40dvh, 260px)` tall and the skill bar and log ticker hide so the stage keeps its space.

Filters per channel (color-coded), unified timeline with timestamps. Sender names and channel tags are clickable: sender opens the user popup via `setOnUserClick`, tag switches the composer send channel (DMs auto-fill the target with the "other party"). Server-channel messages render as plain spans (no popup, no channel switch).

Whenever the popout is open with `dm` selected as the send channel, it reports that thread to `ChatFocusTracker` (`client/src/network/ChatFocusTracker.ts`) so the server suppresses DM notifications for it — see [`notifications.md`](notifications.md).

## NotificationCenter (global overlay)

`client/src/ui/NotificationCenter.ts` is mounted into `#notification-center-root` (another fixed root outside `#app`, alongside `#chat-popout-root`), so — like `ChatPopout` — it survives every screen switch. Its bell button (with unread-count badge) mounts into the top HUD's `.top-hud-bell-slot` when that slot exists; the dropdown positions itself from the button's rect. Clicking the bell opens a dropdown (via `ModalStack`) listing the inbox newest-first. Each row's main area marks it read on click and, for party/friend-request/DM notifications, navigates to the relevant screen; a small "×" per row dismisses (permanently removes) it, and the header has "Mark all read" plus a confirm-gated "Clear all". Live pushes (`GameClient.onNotification`) also spawn an auto-dismissing toast in a separate fixed stack just below the HUD, sharing the same mark-read/navigate click behavior. Full details in [`notifications.md`](notifications.md).

Notification channel/category preferences are a modal opened from a "Notifications" button on `SettingsScreen` (`client/src/ui/NotificationPreferences.ts`) — a category × channel checkbox grid following the same visual language as the Player Options popup.

## Combat screen

`CombatScreen` (`client/src/screens/CombatScreen.ts`) renders the server's real-time fight (see `combat.md` for the engine and protocol). DOM-free logic lives in `client/src/combat/` next to the DOM pieces:

| Module | Role |
|---|---|
| `CombatPlayback` (DOM-free) | timeline player: clock, delayed event/snapshot application, local unit model |
| `CombatLogBuffer` (DOM-free) | merged journal + live log ring owned by `GameClient` |
| `CombatLogFormatter`, `CombatFormat` (DOM-free) | log name colouring, number/time formatting, status pips |
| `CombatUnitCard`, `CombatSkillBar`, `CombatLogView`, `CombatFx` | card DOM, skill bar, ticker + full log, effects layer |

**Layout.** Header (28px: location · dungeon floor/BOSS badge · forecast chip · fight clock · Run or Leave), the stage (flex), the skill bar (60px) and a 3-line log ticker (48px). Run fills over the first 5 seconds and says "Run becomes available 5 seconds into a fight" if tapped early; Run/Leave keep owner/leader gating. When auto-retreat is on, Run carries a 10px 🏳 corner span (absolutely positioned, so the button never widens) and its title reads "Auto-retreat is on (below 25 %)"; Leave never shows it (auto-retreat is overworld-only). The stage background layers `/combat-bg-artwork/{tileId}.png` → `/combat-bg-artwork/{zoneId}-{col}-{row}.png` → `/combat-bg-artwork/{zoneId}.png` → `/zone-artwork/{zoneId}.png` → placeholder, keyed by the room's raw `zone` tag.

**Stage orientation is pure CSS.** `.combat-stage` is a size container (`container: combat-stage / size`). When its aspect ratio is below 1.1 the stage is vertical (enemies on top, party below, both 3×3 blocks rotated so each side's front faces the centre: `displayRow = 2 − col`, `displayCol = row`); otherwise horizontal (party left, enemies right, monster side mirrored). Placement is by `[data-grid]` on cards and empty cells. Container-query breakpoints pick the card mode from the resulting row height: **pills** (round portrait with action ring + name / HP bar / status pips; pips and then names drop as rows shrink) on phones, **stacked portrait cards** on roomy landscape/desktop stages, and small **tiles** when a horizontal stage is short and narrow (e.g. the chat sheet is open). JS reads the axis only through a cached `ResizeObserver` (for lunge direction and arcs). Under `@media (max-height: 480px)` the ticker hides (tap the header to open the log; `CombatScreen` checks the same media query with `matchMedia`, and the header does nothing while the mobile chat sheet is open because that sheet hides the log too) and the skill bar shrinks to 44px.

**Unit cards** (keyed `${battleId}:${side}:${pos}`; a new battle rebuilds and pops them in): side-coloured frame (self = gold), action ring, HP bar with trailing damage chip and shield overlay, cast bar (enemy red with a telegraph line + reticle to a locked player target; player blue; paused casts striped; a cancelled cast stays briefly under its stamp: COUNTERED! when the `interrupt` event carries `cardType: 'interrupt'`, which the engine sets only when an Interrupt reaction counters the cast, and INTERRUPTED! otherwise, e.g. for a stun), status pips, greyed skull when dead. Player portraits layer initials → class icon → class art; monster art uses `/monster-artwork/{id}.png` with a placeholder fallback; henchmen use their emoji/art from `state.social.party.henchmen`. Tapping a player opens the user popup; tapping a monster opens the monster popup (art, description, HP, statuses, current cast, level + con label or "No level set", tier chip, "Built for a group of 3 or more" for boss/raid, and a mastery line from `lastBestiary` or `character.mastery.recent`).

**Levels and tiers on cards.** A `.lvl-badge[data-con]` (glyph + number, e.g. "▴6", aria-label "Level 6, Hard") appears only for **authored** levels, coloured by `levelCon` against the viewer's level through the `--con-*` tokens (pixel-theme `:root`). Derived levels show no number at all. Tier frames use `data-tier`: elite silver ◆, boss gold ♛, raid red ♛. An enraged monster gets `.enraged` (slow red pulse). Level, con and tier are part of the card identity key, so a level-up recolours badges; badges scale with the portrait and hide in the smallest layouts.

**Boss fights.** The header shows `[location][BOSS n/m][forecast chip][clock][Leave]`. `.combat-boss-bar` sits in the label gutter (raised to 26px): boss name (≤ 38 %), a pooled HP track (`CombatPlayback.bossHpFraction()`) with 🚩 checkpoint ticks that light when reached and a hatched section for HP skipped on a resumed attempt, retry pips from `state.dungeon` wipes/maxWipes (checkpoint floors only), and an enrage slot — ⏱ m:ss (amber in the last 30 s), then 🔥 ×1.6 with a red glow (`enrageSource()`, `enrageDisplay(enrage, elapsedMs)`). `CombatPlayback` keeps `bossPhases` (thresholds from full snapshots; the checkpoint number from every dynamic snapshot and `phase` event, so a dropped message is recovered), per-monster enrage clocks (created from an `enrage` event if no snapshot carried one; enrage is its own status kind and never cleansed), and a `'retreat'` result.

**Forecast chip.** Only in elite/boss/raid fights, once a `{kind:'battle'}` result or `pending` arrives (hidden on `unavailable`/`denied`); it listens to `gameClient.onForecast`, keeps the last 4 battles and picks up an earlier result via `peekForecast`. Always `compact` (ring + number, ≤ 56px); below a 340px header it collapses to the ring (container query on `.combat-header`). Tapping opens `.combat-forecast-popover` anchored under the header; its "Change" button opens Player Options.

**Playback.** `CombatPlayback` renders `PLAYBACK_DELAY_MS` (300 ms) behind estimated server time. The clock offset snaps on a new battle or when off by more than 500 ms, otherwise slews ±15 ms per snapshot; event-only messages only move it forward. Render time is monotonic; events (deduplicated by id per battle) and snapshots apply in timeline order when render time reaches them, and between snapshots the local model is advanced from events and timers are extrapolated (frozen while stunned or dead). Each unit's action ring resets to its own interval: full snapshots carry the static `actionIntervalMs` (players and non-passive monsters), so a fast or slow enemy's ring is right from its first action. Without that field the model starts at the 1 s base and infers the interval from waits observed after an ordinary attack. Reconciliation: `state.battle.combat` is ingested like a message with no events; a new `battleId` resets everything; an older snapshot of the same battle is ignored; a state with no combat clears the fight; more than 1.5 s behind, or activating the screen, jumps to the newest snapshot and keeps only a pending `battle_end`. While the screen is inactive only the newest snapshot is kept.

**`combat_view`.** The server streams `combat` messages to a socket only while it reports the combat view as shown. `GameClient` tracks the value the screen asked for (`sendCombatView`, default `false`) and sends `requested && document.visibilityState !== 'hidden'`. It sends that value on every socket open, bypassing de-duplication, so a fresh or reconnected socket immediately learns the real state. After that it sends only changes. `CombatScreen.onActivate` asks for `true` and `onDeactivate` for `false`. `GameClient` handles `visibilitychange` for every screen: hiding the page sends `false`, and showing it restores the requested value. The server resyncs a socket when the value flips from `false` to `true`, so the Battle screen gets a full snapshot as soon as it is shown. The bottom-nav fighting pulse and the map marker read `state` pushes, not combat messages, so they keep working on other screens.

**Log.** `CombatLogBuffer` is a 300-line ring keyed `j:{id}` for journal entries (merged from each state message's journal tail) and `c:{battleId}:{seq}:{i}` for live lines from combat messages. While the combat screen is active, live lines are held until playback reaches their message's time so the log never runs ahead of the animation; a resync message (full snapshot, no events) replaces that battle's live lines. After a reload the buffer starts from the journal tail only. The ticker shows the newest 3 lines (≤ 4 renders/s); expanding opens the full-screen log (`.combat-log-wrapper.fullscreen`) with pause/resume. Names are coloured with one combined RegExp rebuilt only on roster change, and the viewer's own lines read in the second person ("You hit…").

**Skill bar.** One card per equipped active of the viewer's unit: card-type icon (`SKILL_CARD_TYPE_INFO`), name, conic cooldown sweep + seconds left, and state READY / WAITING (held) / ARMED (reaction off cooldown) / CASTING, flashing when used. Passive chips follow; with no actives yet it shows "Active skill unlocks at level N". Between battles (or when joining mid-fight) it renders the loadout from `state.character.skillLoadout`. Tapping a card opens a popover with description, card-type blurb, cooldown, cast time and trigger.

**Effects budget.** `CombatFx` draws into `.combat-fx-layer` (and an SVG telegraph layer) using card centres cached per battle and on resize — never measured per event. Floating numbers come from a fixed pool (≤ 24 live, ≤ 2 per unit, hits within 150 ms merge): physical white, magical violet, holy gold, heals green, crits larger with a shake of the stage grid only; DODGE / BLOCK / ABSORB / STUNNED / RESIST / FIZZLE callouts. Attacks lunge toward the enemy side, reactions flip out a mini card (⚡ Instant / ✋ Interrupt), Intercept draws an arc, and FIGHT! / VICTORY! / DEFEAT banners clear within 1.4 s. **Banners** (`CombatFx.banner(text, tone: BannerTone, holdMs, sub?)`) form a priority queue — retreat/victory/defeat 5 > REGROUP 4 > CHECKPOINT! 3 > ENRAGED! 2 > BOSS FIGHT! 1 > fight 0; a lower-priority banner never replaces a higher one, waits up to 1 s and is then dropped (`clearBanner()` empties the queue). Triggers: BOSS FIGHT! at a boss fight's start, REGROUP ("Checkpoint 1 · 2 retries left") when an attempt resumes, CHECKPOINT! with sparkles on each `phase`, ENRAGED! on the first stack only, RETREAT on a retreat result. A visually hidden `.combat-announcer` (`role=status`, `aria-live=polite`) reads out each banner and new `retreat`/`checkpoint` journal lines; the log colours `retreat`, `checkpoint` and `mastery` entries. Only `transform`/`opacity` animate (WAAPI); the rAF loop writes CSS custom properties only on ≥ 0.5 % change and text countdowns at ≤ 10 Hz; no `backdrop-filter` on the HUD, nav, skill bar or ticker.

**Reduced motion.** `client/src/ui/motion.ts` exports `reducedMotion()` (live `matchMedia`) and `fx(el, keyframes, opts)` (a guarded `el.animate`). When reduced, lunges, shakes, pop-ins, flips, arcs and sparkles are skipped and floaters become short opacity fades; CSS under `prefers-reduced-motion` drops infinite animations and HP transitions, and covers the boss-bar fill, enrage glow/aura, forecast chip and popover animations and recap count-ups.

## Forecasts (client)

Formatting is DOM-free in `client/src/combat/ForecastFormat.ts`; `client/src/ui/ForecastChip.ts` renders HTML strings (`renderForecastRing(result | 'loading' | null, { kind, compact?, stale? })`, `renderForecastPopover(result, { kind, autoRetreat?, elapsedMs?, viewerLevel?, stale? })`).

- **Verdicts** (`forecastVerdict`): rooms Safe ≥ 90 / Good ≥ 70 / Slow ≥ 40 / Losing; dungeons and live fights Safe / Likely / Risky / Deadly on the same bands. The verdict steps down one band when the confidence interval's lower bound is two bands lower.
- **Numbers**: the exact "78 %" only when the Wilson half-width ≤ 7 points (`FORECAST_EXACT_MAX_HALF_WIDTH`), else "~62 %" with "Win chance ~62 %, likely 39–78 %" in the popover. Percentages use a narrow no-break space.
- **Wording**: "Wins ~9 in 10 fights · ~0:12 each", "Clears ~7 in 10 runs", "62 % to win this attempt · ~1:40 left", worst-encounter line, reasons, "Estimate from 20 simulated fights", "Auto-retreat: below 25 % · Change" (rooms and live overworld fights only). Enemy levels show only when authored.
- **Stale** when `result.partyKey !== state.social.party.forecastKey` (`isForecastStale`).
- `OPEN_OPTIONS_ATTR` (`data-open-options`) marks any element that should open Player Options; `App` handles it with one capture listener on the document.

## Auto-retreat control

Player Options has an Off / 25 / 40 / 60 segmented radio group (arrow keys move the choice). It starts from `state.character.combatPrefs` (default 25) and then keeps local state; changes go out with `sendSetCombatPrefs`. Non-owners see "Your party owner's setting is used (below 25 %)." from `social.party.autoRetreat`. `SettingsScreen.openPlayerOptions()` is public (re-opening brings it to the front); the `auto_retreat` notification and the recap's Options action open it.

## While you were away (client)

`client/src/ui/RecapModal.ts`, constructed by `App`, listens to `gameClient.onRecap`. A short absence with no notable moment (`awayRecapStyle` → toast) shows a non-blocking toast ("While you were away (12 min): +3 % of a level · 42 gold") that acknowledges itself after 8 s; tapping it opens the modal. Otherwise the modal (on `ModalStack`) shows the headline built from the top two moments (fallback "Your party kept fighting in {zone}."), the level bar ("Level 5 → 6 · +1 level" or "+42 % of a level"), a timeline of up to 6 moments with clock times (moment text as the server wrote it), rare+ loot icons plus a common count, warnings with actions (losses ≥ 25 % → auto-retreat nudge with [Options]; route stopped; ejected with a resume hint), and footer totals ("Won 1,204 of 1,240 fights · +310 gold · 2,480 foes defeated") — never per-monster kill lists. Count-ups are skipped under reduced motion. Continue or Escape acknowledges (`sendAckRecap`); Escape is left to any window stacked above the recap, but `role=status` toasts don't count; if the recap clears elsewhere the modal closes without acknowledging.

## ModalStack

`client/src/ui/ModalStack.ts` manages click-order z-index across overlays. `bringToFront(el)` is called when a modal opens (and on `mousedown` so click-to-focus works like native windows); `release(el)` on close. `wireFocusOnInteract(el)` attaches the focus-on-click handler in one call. Every overlay in the app (RoomView, ChatPopout, PlayerOptions, player popup, monster popup, the notification dropdown, DungeonEntryPopup, BestiaryModal, RecapModal, etc.) routes through it.

## PWA (installability + service worker)

`client/index.html` links `manifest.webmanifest` and sets the theme-color/apple-mobile-web-app meta tags; `client/public/sw.js` (plain, hand-written — not Vite-processed, just copied as-is to the build root) handles app-shell caching and the `push`/`notificationclick` events for the browser-push notification channel. `main.ts` registers it via `registerServiceWorker()` (`client/src/network/PushNotifications.ts`), which no-ops in dev (`import.meta.env.DEV`) so a stale service worker never shadows local changes. `admin.html` deliberately has none of this — only the player-facing client is installable. Full details in [`notifications.md`](notifications.md).

## Image-everywhere convention

`client/src/ui/assets.ts` exposes `artworkUrl(kind, id)`, `placeholderUrl(name, opts?)`, and `renderAssetImg(kind, id, opts)`. Convention: `<mount>/{id}.png`, falling through to generated offline art so layouts always have shape: `placeholderUrl(label, opts)` returns an inline SVG data URI whose colour is derived from the label — a glossy tile with initials (or an emoji `glyph`) for square sizes, a text-free landscape for wide backdrops. Nothing is fetched from a third-party placeholder service.

The kinds themselves live in `ASSET_KIND_INFO` (`shared/src/assets/AssetKinds.ts`) — the single source of truth that the client `AssetKind` union, the server's Express static mounts, the vite dev proxy, the admin upload API, and the MCP asset tools all derive from, so adding a kind is one row there rather than five hand-kept lists that drift. (A static mount still needs a matching dev-proxy entry or the request silently falls through to the SPA index in dev; both lists are now generated from the registry, so they can't disagree.) `artworkUrl` just delegates to the shared `assetPublicPath(kind, id)` rather than spelling `/${kind}-artwork/`, because the three **icon sets** — `class-icon` → `/class-icons`, `slot-icon` → `/slot-icons`, `nav-icon` → `/nav-icons` — predate that convention and serve from their own mounts (a few older call sites in `App.ts`/`ItemIcon.ts` still hard-code those icon paths). All 16 kinds and their id formats are tabled in [`content.md`](content.md) → "Artwork & imagery".

**Fade-in on fallback.** Every fallback-capable `<img>` renders with inline `opacity:0` and an `onload` handler that reveals it, so the browser never paints its broken-image glyph. What happens on a 404 depends on the image:

- `renderAssetImg` art swaps once to `placeholderUrl`. Class portraits pass the class's `CLASS_GLYPHS` emoji as the tile glyph.
- Item-square art and the item popup art hide themselves and leave the initials sibling showing.
- Nav icons (`App.ts` `navImg`) and slot dogears / empty-slot ghosts (`ItemIcon.ts` `slotArtHtml`) sit over an emoji glyph that shows until the PNG loads and the parent gains `.has-art`. On error the `<img>` removes itself.
- Class and server icons (`inlineIconHtml` via `classIconHtml`/`serverIconHtml`) replace themselves with a glyph span on error.

None of the icon sets swap to generated art. A 120 ms `transition: opacity` on the art image classes smooths the reveal.

## Browser tab resume

On `visibilitychange` → visible, the client restores its `combat_view` value (see Combat screen) and sends `request_state` for an immediate server response (no waiting for the next battle cycle); the server answers with a state message plus a combat resync when a fight is live. The party position snaps instantly; the camera pans smoothly (500ms).

## Event-driven systems

Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scenes/screens subscribe for state sync.

## Hex coordinates

Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px.

## A* pathfinding

Hex distance heuristic with cross-track tie-breaker.

## Other players on map

Each state message includes `otherPlayers: { username, col, row, mapId?, zone, className?, partyId?, inDungeon?, dungeonName? }[]`. Players on a different map than the viewer are filtered out (so co-located `col,row` on another map don't render). `ThreeWorldMap` renders party flags per occupied tile in the same zone (deterministic color hash so distinct parties read distinctly), and a "+N" badge on the player's own tile so other-room players aren't hidden behind the party bubble. Positions update on each player's own battle cycle. `partyId` flows through to `TileClickInfo.playersHere` so `RoomView` can group co-located players into one box per party. A party delving a dungeon stays parked at the entrance tile; `inDungeon`/`dungeonName` drive a 🗝️ marker on that tile's flag (`.three-map-dungeon-key`) and a "🗝️ Delving {name}" tag on the party's box in the room popup, so it reads as "inside" rather than "standing around."

## Zoom controls

Mobile-friendly +/− zoom buttons on the map screen, wired to `CanvasWorldMap.adjustZoom()`.

## Desktop font scaling

Font sizes come from an eight-step token scale (`--fs-2xs` … `--fs-3xl`: 11 / 12 / 13.5 / 15 / 18 / 22 / 28 / 36px) defined in `pixel-theme.css :root`; a `@media (min-width: 768px)` block raises every step (11.5 … 42px). Stylesheets use the tokens rather than px sizes.

## Visual style

Modern mobile-game look: **Lilita One** (display: titles, buttons, numbers — weight 400, `font-synthesis: none`) and **Nunito** (body), loaded via `<link>` in `index.html`. Colours, gradients, radii, shadows, button depth, damage/heal colours, rarity colours (legendary gold, heirloom pink) and card-type colours (`--card-attack` … `--card-triggered`) are tokens in `pixel-theme.css :root`; legacy token names (`--bg-panel`, `--accent-gold`, …) alias onto the new palette. Glossy gradient panels with a dark outline and top highlight, chunky buttons with a coloured bottom edge that press down on `:active`, pill tabs, red badge pips with a white outline, glossy progress bars, dark scrims (`backdrop-filter` blur on modals only) and a short overshoot pop-in on modals. Timers and HP use `tabular-nums`. All UI is vanilla HTML/CSS (no framework).

**Stylesheet cascade** (import order in `client/src/main.ts`): `pixel-theme.css` (tokens, base, shell: HUD, XP bar, nav, chat docking, overlays), `charitems.css` (Char/Items screen, item squares and popups), `crafting.css`, `mobile-theme.css` (the component restyle of every non-combat screen, applied by existing class names), `combat.css` (the combat screen and monster popup). No screen injects `<style>` blocks from JS. `ItemIcon.ts` emits `--rarity` (and `--item-bg` for an authored `iconColor`) instead of literal colours. The admin dashboard has its own stylesheet and is untouched by this theme.

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages are appended to the DOM without re-rendering the entire timeline, preserving input focus and typed text.
