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

**All edit forms are popup modals** (Monsters, Items, Sets, Shops, Zones, Encounters, Tile Types, Dungeons) opened via `components/Modal.ts`; modal inputs use `--admin-bg-2` background by default with a focus state on `--admin-panel`.

The map viewer uses HTML5 Canvas with pan/zoom, rendering tiles from the content API. Room names are shown on all tiles (admin sees everything, no fog of war).

## Per-tab notes

- **Overview**: analytics placeholders (DAU, retention, level distribution, class mix) — coming soon.
- **Accounts**: defaults to sort-by-Created desc, has filters (hide no-character accounts, active-in-last-N-days, created-in-last-N-days) with live filtered count. Clicking a username opens a detail modal with session history, duplicate device token detection (highlighted), deactivate/reactivate buttons, and reactivation request viewer.
- **Tile Types**: shows real hex-shaped tile previews (non-traversable types render with a red hex ring around the colored hex — the canvas map keeps its own red-X marker); IDs are hidden in the UI and auto-generated as GUIDs on create — only the tile name is editable. The color picker hex code is hidden until the picker is focused.
- **Map**: sidebar opens the room editor directly when a tile is clicked (no preview/edit toggle); Backspace/Delete deletes the selected room when not focused in a field.
- **Shop edit modal**: sorts items alphabetically and includes a search box plus a "Show only stocked" toggle to filter the inventory checklist.
- **Dungeons**: list table with a modal form that supports floors (with grid shape, encounter table, per-floor rewards, boss flag), entry requirements (level/item/classes/party size), and first-clear rewards.
- **Game** link in the sidebar opens the game in a new tab.
