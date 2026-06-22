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

## World map (three.js)

`client/src/ui/ThreeWorldMap.ts` renders the world map with **three.js (WebGL)** plus a sibling HTML overlay. The split:

- **WebGL canvas** owns the static layers only — parchment background, drop shadow, baked tile composite. These are uploaded as textures and the per-frame work collapses to a camera-matrix update; pan/zoom are essentially free GPU operations.
- **`.three-map-overlay` HTML div** sits on top of the canvas and hosts every *dynamic* element — party sprite, other-player flags, count badges, hover highlight, path preview. The overlay carries a single `transform: translate(W/2, H/2) scale(zoom) translate(-camX, -camY)` mirroring the three.js camera, so a single style update moves every child together when the user pans/zooms (no per-child JS). Children are absolutely positioned in world coords (`left:Xpx; top:Ypx`) and centered via `translate(-50%, -50%)`.
- **Tooltip** is a separate cursor-positioned `.canvas-map-tooltip` element (no map transform).

**Render-on-demand**: there's no always-on RAF loop. `requestRender()` schedules a single render on the next animation frame, coalescing multiple state pushes into one. An anim loop runs only while the spring-back is active (overdrag → bounce). Party movement and the party pulse live entirely in CSS (`transition: left/top 400ms ease-in-out` on `.three-map-party` matches `MOVE_DURATION`; pulse is a CSS keyframe), so they don't drive any JS or WebGL work. Idle map screens cost effectively zero.

**Tile layering** (unchanged from the prior Canvas2D renderer): every tile renders in three stages — tile-type color (always; darkened per fog/zone-unlock factor), real artwork overlay if uploaded (`/tile-artwork/{id}.png` → `/tile-type-artwork/{type}.png`, NO placehold.co fallback so missing art falls through), otherwise the tile-type emoji glyph centered in the hex. Tile artwork is baked into hex-clipped offscreen sprites in `hexSpriteCache` on first load — the bake then draws each sprite with a single `drawImage(sprite)` (no `clip()` call).

**Static-layer bake → texture**: the full static composite (tile fills + artwork + outlines + zone overlay + zone borders) is baked once into an offscreen canvas at zoom=1 in world coords, wrapped as a `THREE.CanvasTexture`, and rendered as a single textured quad in the WebGL scene. The cache is invalidated (`staticDirty = true`) on grid rebuild, unlock-set change, current-zone change, and artwork image-load — invalidation triggers a re-bake + texture re-upload on the next `render()`. Compared to the prior Canvas2D approach, the per-frame blit is replaced by a GPU-side transform on an already-uploaded texture, which is what drives the perf win.

**Map drop-shadow**: silhouette baked at zoom=1 in world coords, pre-blurred into a padded offscreen, uploaded as a CanvasTexture, drawn as a black-tinted quad at 50% alpha at z=1. Offset is in world units (40, 60) so it scales naturally with zoom — no scale-shrink (which used to drift the shadow inside the map on larger islands).

**Parchment**: a fixed 8000×8000 plane at z=0 with the tiled parchment texture. Each frame its world position is set to `camWorld × (1 − 0.3)` so it follows the camera at 70% rate — i.e. apparent shift on screen is only 30% of the world's, giving the "deeper" parallax feel.

## RoomView (replaces TileInfoModal)

Clicking a tile opens `client/src/ui/RoomView.ts` with three states:

- **Current room (you're here)** — near-full-screen, background image (`/room-bg-artwork/{zoneId}-{col}-{row}.png` with `/room-bg-artwork/{zoneId}.png` fallback), party-grouped player list (your party in a gold-bordered box, then one bordered box per other party), shop/talk affordances, click any player to open the user popup.
- **Remote room (discovered)** — smaller centered popup with name/type, the same party-grouped player list (when other parties' players are on the tile), and a "Go to room" button.
- **Undiscovered** — same small popup with an "unexplored" hint.

Grouping logic lives in `RoomView.groupPlayersByParty` and depends on `partyId` arriving on each `OtherPlayerState`. Each rendered tile passes through `renderPartyBox(members, label, partyClass)`.

Travelling from a remote-room view to your party arriving at that tile triggers an arrival expand animation (`.room-view-arrival` class with timed CSS transition). Shop, NPC, and dungeon affordances on the current-room view are gated on `playerOnTile && state?.shopDefinition` / `tileDef?.npcId` / `tileDef?.dungeonId` respectively — wired in `MapScreen.setOnTileClick`.

## Dungeons (client)

When the current room is linked to a dungeon (`tileDef.dungeonId`, looked up via `WorldCache.getDungeon(id)` — catalog fetched once from `GET /api/dungeons`), `RoomView` shows an "Enter {name}" button. Tapping it opens `DungeonEntryPopup` (flavor, floor count, requirements preview, eject warning); confirming sends `enter_dungeon`. Entry is server-authoritative — failures come back as an `error` message. While inside a dungeon, `ServerStateMessage.dungeon` (`DungeonRunInfo`) is set: `CombatScreen` swaps the run bar for an in-dungeon banner (dungeon name + "Floor X / Y" + a "Leave Dungeon" button, owner/leader-gated like Run), and `MapScreen.tryMove` blocks overworld travel until the party bails out. See `docs/architecture/content.md` → Dungeon system for the server side.

## Multi-map travel (client)

The client renders only the map the party is on. `ServerStateMessage.currentMapId` drives `WorldCache.setCurrentMap`; when it changes, `ThreeWorldMap` rebuilds its grid from the new map's tiles, recenters the camera, snaps the party sprite (no tween across the discontinuity), and filters the other-player flag overlay to that map (`OtherPlayerState.mapId`). When the current room has `transitions`, `RoomView` shows one "Enter {destination}" button per exit (destination names resolved via `WorldCache.getTileByGuid`); tapping one sends `enter_transition` with that target `tileId` (owner/leader-gated, blocked inside a dungeon). No confirm popup — transitions have no requirements. See `docs/architecture/content.md` → Multi-map for the server side. (A zoomed-out overworld/map-select for players is out of scope — issue #168.)

## Inventory screen (merged Char + Items)

`CharItemsScreen` is a single scrollable column containing the old Char and Items screens together: hero card with class portrait (loaded from `/class-artwork/{class}.png`), equipped gear, skill loadout (5 slots; clicking opens a popup with all unlocked skills of the matching type — no auto-shuffle on placement), condensed stat card (ATK/DR/MR/HP with click-to-show tooltips), and inventory grid. Skill points are gone — `getUnlockedSkillsForLevel(className, level)` auto-unlocks skills at their milestone (`LEVELS_PER_SKILL_POINT = 5`); equipping the 5 slots is the only constraint.

The inventory grid groups items with visible headers when sorted by Rarity or Type (Newest stays chronological). Clicking an item opens a popup with full details and equip/unequip/drop actions.

Legacy sessionStorage `activeScreen=character` migrates to `items` on load.

## ChatPopout (global overlay)

`client/src/ui/ChatPopout.ts` is mounted into `#chat-popout-root` (a `position: fixed; inset: 0; pointer-events: none` ancestor outside `#app`). On desktop: floating window with grabbable header, freely resizable, geometry persisted to `localStorage['chatPopoutGeometry']`; clamped to viewport. On mobile: full-screen or fixed bottom-sheet (toggle via the popup's layout button; preference persisted to `chatPopoutMobileLayout`).

Mobile sheet mode also sets `body.dataset.chatLayout = 'sheet'` so the screen container can dock — when both `data-chat-open="1"` and `data-chat-layout="sheet"` are set, `#screen-container` flex-shrinks by `chat-sheet-height + nav-height + xpbar-height` and `#persistent-xp-bar` gets `margin-top: auto` so the nav+xpbar pin to the actual viewport bottom. The result is that chat slots cleanly between screen content and nav instead of overlaying them. Drop shadows are removed on mobile so the chat reads as a top-level layout bar.

Filters per channel (color-coded), unified timeline with timestamps. Sender names and channel tags are clickable: sender opens the user popup via `setOnUserClick`, tag switches the composer send channel (DMs auto-fill the target with the "other party"). Server-channel messages render as plain spans (no popup, no channel switch).

## Combat cards

`CombatScreen` renders each combatant as a small card on a 3×3 grid — portrait image (top), name, HP bar with numeric overlay. Player portraits load from `/class-artwork/{class}.png` with a class-icon fallback; monster art loads from `/monster-artwork/{slug}.png` with a placehold.co fallback. Player cards highlight the current user in gold; dead combatants dim; stunned combatants show a "💫" badge. Cards arrange on the grid via CSS-grid mapping their `gridPosition`. Clicking a player opens the user popup; clicking a monster opens the monster popup (name + image + optional flavor description from `MonsterDefinition.description`).

Per-turn animations (`updateCombatAnimations`) toggle `.attacking` / `.hit` / `.dodged` classes on the card itself (not an inner element) — keyframes `attack-lunge-right/-left`, `hit-flash`, `dodge-sidestep`. On mobile, `.combat-tray` is `overflow: visible` inside the narrow-viewport `@media` block so the lunge can extend into the inter-tray gap without clipping at the tray edge.

**Combat backgrounds**: each combat stage has a CSS `background-image` chain `/combat-bg-artwork/{zoneSlug}-{col}-{row}.png` → `/combat-bg-artwork/{zoneSlug}.png` → placehold.co. Dimmed + scrim'd so cards remain readable.

## ModalStack

`client/src/ui/ModalStack.ts` manages click-order z-index across overlays. `bringToFront(el)` is called when a modal opens (and on `mousedown` so click-to-focus works like native windows); `release(el)` on close. `wireFocusOnInteract(el)` attaches the focus-on-click handler in one call. Every overlay in the app (RoomView, ChatPopout, PlayerOptions, player popup, monster popup, etc.) routes through it.

## Image-everywhere convention

`client/src/ui/assets.ts` exposes `artworkUrl(kind, id)`, `placeholderUrl(name, opts?)`, and `renderAssetImg(kind, id, opts)`. Convention: `/<kind>-artwork/{id}.png`, falling through to `placehold.co` (and finally to the surrounding background color via CSS) so layouts always have shape. Active kinds: `item`, `monster`, `class`, `tile`, `tile-type`, `zone`, `set`, `shop`, `logo`, `parchment`, `combat-bg`, `room-bg`. Each kind requires an Express static mount in `server/src/index.ts` AND a matching `/X-artwork` entry in the vite dev proxy (`client/vite.config.ts`) — missing proxy entries silently fall through to the SPA index in dev.

**Fade-in on fallback**: every fallback-capable `<img>` (renderAssetImg, item-square art, slot dogear, item popup, nav icon) renders with inline `opacity:0` and an `onload` handler that flips it to `1`. The browser never paints its broken-image glyph during the swap from a 404 real source to the placehold.co fallback — the surrounding slot's background / initials stand in until either the real or placeholder load resolves. A 120 ms `transition: opacity` is set on the affected image classes so the reveal feels smooth rather than snapping.

## Browser tab resume

On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).

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

`@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop. A four-tier font-size scale (`--fs-xs/sm/md/lg`) drives sizing globally with mobile/desktop overrides.

## Visual style

Pixel/retro RPG — Silkscreen body font + Pixelify Sans display font (replaced Press Start 2P in the May overhaul; the new fonts fix the 6/G readability problem). CSS custom properties for theming, CSS keyframe animations for battle states, global `b, strong { font-weight: normal }` reset since bold was illegible at small pixel sizes. All UI is vanilla HTML/CSS (no framework).

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages are appended to the DOM without re-rendering the entire timeline, preserving input focus and typed text.
