# World Manager (admin dashboard)

Separate client page at `/admin` (dev: `/admin.html`) for viewing server data and game content.

## Auth & API surface

Admin auth uses `ADMIN_EMAILS` env var (comma-separated emails). Server-side middleware checks session email against the list (401 if unauthenticated, 403 if not admin). API endpoints at `/api/admin/*` return runtime data (overview stats, accounts with online status) and full unfiltered game content (`GET /api/admin/content` returns all monsters, items, zones, and world data).

## Layout & shell

Built as a separate Vite entry point (`admin.html`) isolated from the game client and styled with its own utilitarian theme (`styles/admin-theme.css`) — does NOT share `pixel-theme.css` with the game.

**Modular layout**: shell + per-tab modules under `client/src/admin/tabs/`, all sharing state via the `AdminContext` interface. The shell renders:

- A sticky **status bar** (always visible at the top with a version selector + Publish/Deploy/+New Draft buttons; creating a new draft auto-selects it so the UI immediately becomes editable).
- A left **sidebar** (collapsible to a hamburger menu under 900px wide; each item also shows a **UI Size selector** S/M/L/XL — value persisted to `localStorage['adminUiSize']` and applied as the `data-admin-size` attribute on `<html>` so the density tokens cascade).
- The active tab's content.

**Density tokens** (`--admin-pad-page-{x,y}`, `--admin-pad-cell-{x,y}`, `--admin-pad-section`, `--admin-pad-btn-{x,y}`, `--admin-pad-input-{x,y}`, `--admin-gap-loose`, `--admin-gap`, `--admin-gap-tight`, plus `--admin-sidebar-width` and `--admin-topbar-height`) scale with the UI size, so picking Small tightens every padding/gap on the page (table rows, fieldsets, modal padding, sidebar, topbar, etc.) — not just font size.

**All edit forms are popup modals** (Monsters, Items, Sets, Shops, Zones, Encounters, Tile Types, Dungeons, NPCs, Quests, Recipes) opened via `components/Modal.ts`; modal inputs use `--admin-bg-2` background by default with a focus state on `--admin-panel`.

**CRM artwork upload pipeline**: items, monsters, sets, shops, zones, and tile types all share the same artwork upload UI inside their edit modal — see `client/src/admin/components/ArtworkSection.ts` (renders preview + file picker + upload/remove buttons) and the single generic server endpoint `POST/DELETE /api/admin/artwork/:kind/:id` in `server/src/admin/adminRoutes.ts` (validates PNG + enforces square via IHDR, writes to `server/data/<kind>-artwork/{id}.png`). Adding artwork support to a new content kind is one row in `ARTWORK_KINDS` on the server + the `renderArtworkSection({ kind, id }) / wireArtworkSection(root, { kind, id })` pair in the tab's edit modal + an Express static mount + a vite proxy entry.

The map viewer uses HTML5 Canvas with pan/zoom, rendering tiles from the content API. Room names are shown on all tiles (admin sees everything, no fog of war). A **map selector** dropdown switches which map the canvas shows (one `HexGrid` per `mapId`); the canvas and room editor are scoped to the selected map. **+ New Map** prompts for a name + id and creates an empty map to add rooms to. "Set as Start Tile" sets the selected map's start (also the global spawn for the default map). See `content.md` → Multi-map for the data model.

## Per-tab notes

- **Overview**: analytics placeholders (DAU, retention, level distribution, class mix) — coming soon.
- **Accounts**: defaults to sort-by-Created desc, has filters (hide no-character accounts, active-in-last-N-days, created-in-last-N-days) with live filtered count. Clicking a username opens a detail modal with session history, duplicate device token detection (highlighted), deactivate/reactivate buttons, and reactivation request viewer.
- **Tile Types**: shows real hex-shaped tile previews (non-traversable types render with a red hex ring around the colored hex — the canvas map keeps its own red-X marker); IDs are hidden in the UI and auto-generated as GUIDs on create — only the tile name is editable. The color picker hex code is hidden until the picker is focused.
- **Map**: sidebar opens the room editor directly when a tile is clicked (no preview/edit toggle); Backspace/Delete deletes the selected room when not focused in a field. The room editor's **Map Transition** section links a room to a room on another map: click "Link target room" to enter pick mode (a banner appears), switch the map selector to the destination map, then click the destination room — the link is saved on the source room (`transitionsTo: { mapId, tileId }`) and a 🕳️ glyph marks linked rooms. Esc cancels pick mode; "Clear transition" removes a link. Routes: `POST/DELETE /api/admin/world/map` (create/rename, delete — delete blocked if the map has rooms or inbound transitions), `PUT /api/admin/world/start-tile` (accepts an optional `mapId`), and `mapId`/`transitionsTo` on the `/api/admin/world/tile` body; all support `?versionId=` for draft editing.
- **Shop edit modal**: sorts items alphabetically and includes a search box plus a "Show only stocked" toggle to filter the inventory checklist.
- **Dungeons**: list table with a modal form that supports floors (with grid shape, encounter table, per-floor rewards, boss flag), entry requirements (level/item/classes/party size), and first-clear rewards (flat bonus XP/gold + item rewards). Every item reward row (floor or first-clear) has per-reward class checkboxes ("none = any") so loot can be routed by class.
- **Game** link in the sidebar opens the game in a new tab.
