# Client shell, screens, and rendering

## Multi-screen app shell

DOM-based screen switching (not Phaser scenes). `ScreenManager` handles show/hide with `onActivate`/`onDeactivate` lifecycle. Combat is the default screen; Map lazy-loads Phaser on first visit.

## Per-player game state

Each player has a `PlayerSession` with character state, unlocks, combat log, and social data. Combat and movement are managed per-party by `PartyBattleManager`, which owns a shared `ServerParty` + `ServerBattleTimer` for each party. `PlayerSession` delegates battle/position queries to `PartyBattleManager` via callbacks wired by `PlayerManager`. Sessions persist when disconnected (battles keep running). `PlayerManager` maps usernames to sessions and WebSockets to usernames. Multiple connections per username are supported.

## GameClient subscriber pattern

`subscribe(cb)` / `onConnection(cb)` return unsubscribe functions. Multiple screens listen concurrently. `lastState` cache lets late-mounting screens read current state immediately. Connection is deferred until `connect()` is called (after auth).

## Phaser isolation

Phaser only runs when the Map tab is active. `game.loop.sleep()`/`wake()` halts/restarts the entire RAF loop. On re-activation, state is snapped (not tweened) so the player sees "where I am now" with no catch-up animation.

## Browser tab resume

On `visibilitychange` → visible, the client sends `request_state` for an immediate server response (no waiting for the next battle cycle). The party position snaps instantly; the camera pans smoothly (500ms).

## Event-driven systems

Systems use callback properties (`onTileReached`, `onBattleEnd`, `onTilesUnlocked`) — scene subscribes for state sync.

## Hex coordinates

Cube coordinates (q, r, s) where q + r + s = 0, flat-top hexagons, HEX_SIZE = 40px.

## A* pathfinding

Hex distance heuristic with cross-track tie-breaker.

## Other players on map

Each state message includes `otherPlayers: { username, col, row, zone, className? }[]`. WorldMapScene renders same-zone players as individual markers; other-zone players show as count badges on their tile. Positions update on each player's own battle cycle.

## Room info modal

Clicking a tile on the map opens a modal showing room name, type, players present, and a "Go to room" button. `TileInfoModal` class handles the DOM overlay. (UI calls tiles "rooms"; code still uses "tile" internally.)

## Zoom controls

Mobile-friendly +/- zoom buttons on the map screen, wired to `WorldMapScene.adjustZoom()`.

## Desktop font scaling

`@media (min-width: 768px)` media query increases font sizes for all UI elements on desktop.

## Separation of concerns

Phaser Graphics for rendering, HTML/CSS for all non-map UI (camera-independent), pure logic in shared systems.

## Visual style

Pixel/retro RPG — Press Start 2P font, CSS custom properties for theming, CSS keyframe animations for battle states. All UI is vanilla HTML/CSS (no framework).

## Client UI state persistence

Active screen and social sub-tab are saved to `sessionStorage` so browser refreshes restore the user's last view. Chat channel preference (send channel + DM target) is persisted server-side so it syncs across devices. Incoming chat messages are appended to the DOM without re-rendering the entire chat panel, preserving input focus and typed text.
