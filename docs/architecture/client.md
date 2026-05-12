# Client shell, screens, and rendering

## Multi-screen app shell

DOM-based screen switching (Phaser fully removed from runtime in the May 2026 overhaul — the package is still in `package.json` until cleanup, but nothing imports it). `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-creates the Canvas world map on first visit. A persistent XP bar sits directly above the bottom nav, visible on every game screen.

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

## Canvas world map

`client/src/ui/CanvasWorldMap.ts` renders the world map with HTML5 Canvas — parchment background, hex tiles with a single unioned drop shadow, zone borders/overlays, path tween, player party, and per-tile flags for other parties present. Pan via mouse drag / touch drag, zoom via wheel / pinch / on-screen +/− buttons. Smarter default zoom targets ≥15 tiles along the shorter dimension. Scroll bounce-back lets the user overdrag ~25% then springs back. The map pauses its render loop when the screen is inactive.

**Tile layering**: every tile renders in three stages — tile-type color (always; darkened per fog/zone-unlock factor), real artwork overlay if uploaded (`/tile-artwork/{id}.png` → `/tile-type-artwork/{type}.png`, NO placehold.co fallback so missing art falls through), otherwise the tile-type emoji glyph centered in the hex. Tile artwork is baked into hex-clipped offscreen sprites in `hexSpriteCache` on first load — the per-frame work then collapses to a single `drawImage(sprite)` with no `clip()` call, which on mobile is roughly an order of magnitude faster.

**Map drop-shadow**: silhouette baked once at zoom=1 in world coords, pre-blurred into a padded offscreen (`bakeBlurredShadow`) so the per-frame draw is a cheap `drawImage` instead of a `c.filter = blur(...)` pass. Rebuilds on grid change via `rebuildFromCache()`.

## RoomView (replaces TileInfoModal)

Clicking a tile opens `client/src/ui/RoomView.ts` with three states:

- **Current room (you're here)** — near-full-screen, background image (`/room-bg-artwork/{zoneId}-{col}-{row}.png` with `/room-bg-artwork/{zoneId}.png` fallback), parties grouped visually (your party + other parties), shop/talk affordances, click any player to open the user popup.
- **Remote room (discovered)** — smaller centered popup with name/type/player count and a "Go to room" button.
- **Undiscovered** — same small popup with an "unexplored" hint.

Travelling from a remote-room view to your party arriving at that tile triggers an arrival expand animation (`.room-view-arrival` class with timed CSS transition). Shop and NPC affordances on the current-room view are gated on `playerOnTile && state?.shopDefinition` / `tileDef?.npcId` respectively — wired in `MapScreen.setOnTileClick`.

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

## Browser tab resume

On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).

## Event-driven systems

Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scenes/screens subscribe for state sync.

## Hex coordinates

Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px.

## A* pathfinding

Hex distance heuristic with cross-track tie-breaker.

## Other players on map

Each state message includes `otherPlayers: { username, col, row, zone, className? }[]`. `CanvasWorldMap` renders party flags per occupied tile in the same zone (deterministic color hash so distinct parties read distinctly), and a "+N" badge on the player's own tile so other-room players aren't hidden behind the party bubble. Positions update on each player's own battle cycle.

## Zoom controls

Mobile-friendly +/− zoom buttons on the map screen, wired to `CanvasWorldMap.adjustZoom()`.

## Desktop font scaling

`@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop. A four-tier font-size scale (`--fs-xs/sm/md/lg`) drives sizing globally with mobile/desktop overrides.

## Visual style

Pixel/retro RPG — Silkscreen body font + Pixelify Sans display font (replaced Press Start 2P in the May overhaul; the new fonts fix the 6/G readability problem). CSS custom properties for theming, CSS keyframe animations for battle states, global `b, strong { font-weight: normal }` reset since bold was illegible at small pixel sizes. All UI is vanilla HTML/CSS (no framework).

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target), chat geometry (desktop), and mobile chat layout are persisted to `localStorage`. Incoming chat messages are appended to the DOM without re-rendering the entire timeline, preserving input focus and typed text.
