# UI Overhaul — May 2026

A broad pass to make the game feel more like a game and less like a web app: more imagery, more character, less chrome. Notes captured from a brainstorming session — items here are directional, not finalized.

## Decisions Locked

Settled in this brainstorm — included for reference so future notes don't re-litigate them.

- **Bottom nav stays** — restyled. The floating pop-out alternative is dropped.
- **Bottom nav slot count is fine** — Char + Items merge brings the count back to 6 after Chat is added. Phones keep getting bigger; 6 is doable.
- **Skill point removal** — skills auto-unlock as their level milestone is reached. The constraint is no longer "do I have a point to spend" but "which 5 do I equip." (Today there are always enough points anyway, so this is a UI/model cleanup, not a balance change.)
- **Chat surface = pop-out only** — adds a Chat entry to the bottom nav. Clicking it opens a chat window over the current screen, regardless of which screen is active. The combat log is *not* merged in — it stays on the Combat screen as today.
- **Chat layout, mobile** — full-width by default, with two layout options: full-screen, or half-screen fixed bottom sheet. No dragging on mobile.
- **Chat layout, desktop** — floating, draggable, resizable window. The window is constrained to the visible viewport (cannot be dragged off-screen). The earlier "quarter / half-screen presets" idea is dropped in favor of free resize.
- **Asset pipeline** — reuse the existing item asset pipeline for all new imagery (icons, monster art, room images, combat backgrounds, class portraits, etc.). No new pipeline.
- **Image fallback** — when art is missing, render the background color only. The default assumption is that art *will* be present; missing art is a content gap, not a supported state.
- **Monster popup scope** — name + image only for now. Hidden info (drops, abilities, resistances) stays hidden; we can revisit later.
- **Room popup, party grouping** — parties are a *visual* grouping only. Clicking a party group does nothing; clicking an individual player within the group opens the existing user popup, same as today. Single-player parties render the same way (just a one-member group).
- **Social badge logic** — stays as-is, minus the unread-chat source. Users (incoming friend requests / trade attention) and Party (pending invites) keep their badges; the chat unread badge moves to the new Chat nav entry. Aggregate Social-tab badge keeps lighting up for the remaining sources.
- **Persistent XP bar placement** — sits *above* the bottom nav, stacked as its own thin strip. Not inside the nav. Visible on every screen alongside the nav.
- **Map tech (post-Phaser) = Canvas** — same approach as the admin map (`HTMLCanvasElement` + `CanvasRenderingContext2D`, manual pan/zoom via mouse events, hex math from `@idle-party-rpg/shared`). The admin `MapTab` is the reference implementation; extend it with parchment background, drop shadows, party flags, and bounce-back scroll for the game client. No framework (no Phaser, no SVG).
- **Char/Items merge — scrolling is fine** — don't try to fit everything above the fold. Visual centerpiece (silhouette + equipped gear + skills loadout) goes up top; condensed stat card and inventory grid live below the fold. Single scrollable column on mobile; desktop can use the extra width but is still allowed to scroll.
- **Leaderboard — sort by XP, display level only** — XP is the sort key (server-side), but the public leaderboard row only shows level. Raw XP stays private. Tiebreaks within a level are determined by XP behind the scenes; the user just sees a stable ordering.

## Conflicts & Open Questions

None — all open items have been resolved. New questions can be added here as implementation begins.

## Implementation Status — 2026.05.04

This document was used as a scratchpad during the all-in-one implementation pass. Below is a snapshot of what shipped vs. what still needs your input. Code is in version `2026.05.04.1`.

### Shipped in this pass

- Foundation
  - New `client/src/ui/assets.ts` helper: `artworkUrl(kind, id)` + `placeholderUrl(name)` + `renderAssetImg(kind, id, opts)`. Asset pipeline is `/<kind>-artwork/{id}.png` mirroring the existing `/item-artwork/`. Fallback is `placehold.co`.
  - Font swapped from `Press Start 2P` to `Silkscreen` (body) + `Pixelify Sans` (display headings) — fixes 6/G ambiguity.
  - Splash overlay added (`#splash` in `index.html`) — auto-dismisses on app boot. Replace `/logo-artwork/idle-party.png` to set the real logo.
- Bottom nav
  - Restyled with depth, gold glow on active, hover states, animated active bar.
  - New 6-tab order: Combat / Map / Inventory / Social / Chat / Settings.
  - Chat is an overlay tab — clicking it toggles the chat pop-out instead of switching screens.
- Persistent XP bar
  - Sits directly above the bottom nav, visible on every game screen. Level badge on the left, fill across; no raw numbers (those live on the Inventory screen).
- Chat pop-out
  - Floating, draggable, freely resizable on desktop (viewport-clamped, geometry persisted to localStorage).
  - Mobile: full-screen or bottom-sheet, toggled via a layout button in the header (preference persisted).
  - Filters per channel, color-coded timeline, server `sync_chat` on first connect.
- Combat screen
  - Sprites → cards (image + name + HP bar). Player shows class portrait or class icon fallback; monsters show monster art or placeholder.
  - Monster click → popup (name + image only). Drops/abilities/resistances stay hidden.
  - Per-zone combat background image with optional per-tile override (`/combat-bg-artwork/{zoneSlug}.png` and `/combat-bg-artwork/{zoneSlug}-{col}-{row}.png`). Falls through to placehold.co.
- Map (Phaser → Canvas)
  - New `client/src/ui/CanvasWorldMap.ts`. `WorldMapScene.ts` and Phaser are no longer used (Phaser is still in `package.json` for now — safe to remove later if desired).
  - Parchment background, tile shadows, scroll bounce-back, smarter default zoom (≥15 tiles on the shorter dimension), 2-finger pinch zoom on mobile.
  - Other-party flags per occupied tile (deterministic color hash by `col,row`). Includes "+N" badge on the player's own tile so other-room players aren't hidden by the party bubble.
- Room popup → `RoomView`
  - Replaces `TileInfoModal`. Three states: full-screen current room (background art, parties grouped), smaller remote-room popup, undiscovered.
  - Arrival transition: when the popup transitions from a remote-room view to a current-room view at the same coordinates, it expands with a spring animation.
- Char + Items merge
  - `CharItemsScreen.ts` is the single scrollable screen. Hero card on top, condensed stat card with abbreviation tooltips, inventory grid below.
- Skill points removed
  - `CharacterState.skillPoints` deleted. Skills auto-unlock at their level milestone. Equipping (5 slots) is the only constraint. Old saves still load (legacy field is ignored on read).
- Inventory grouping headers
  - Sort by Rarity or Type renders visible group headers; Newest stays chronological.
- Social tab rework
  - Default sub-tab → Party. Users renamed → Leaderboard (sort cycler: Top → Status → A-Z; Top defaults to level desc as a public proxy for XP). Chat sub-tab removed.

### Things needing your input

These are items that are stubbed/placeholder and benefit from your involvement before they look right:

1. **Logo + splash artwork.** The splash screen reaches for `/logo-artwork/idle-party.png` and falls back to a placehold.co panel. Drop the real logo PNG into `data/logo-artwork/idle-party.png` (and add an Express static mount for `/logo-artwork` like the existing `/item-artwork` mount in `server/src/index.ts:143`).
2. **Static-asset mounts on the server.** `/item-artwork` is the only existing mount. The new conventions reference these paths — please decide which you want to mount and add `app.use('/<kind>-artwork', express.static(path.resolve('data/<kind>-artwork')))` to `server/src/index.ts` for each:
   - `/logo-artwork` (splash logo, favicon)
   - `/monster-artwork` (combat monster cards & monster popup)
   - `/class-artwork` (class portraits in combat + Inventory hero card)
   - `/tile-artwork` and `/tile-type-artwork` (canvas map per-tile / per-type icons)
   - `/zone-artwork` (zone metadata, future use)
   - `/set-artwork` (set tooltips, future use)
   - `/shop-artwork` (room view shop button)
   - `/parchment-artwork` (canvas map ground texture)
   - `/combat-bg-artwork` (per-zone / per-tile combat backgrounds)
   - `/room-bg-artwork` (per-zone / per-tile room view backgrounds)
3. **Font choice — confirm or veto.** Silkscreen + Pixelify Sans were chosen for clearer digits. If you want a different pairing, change `--pixel-font` and `--display-font` in `client/src/styles/pixel-theme.css` and update the `@import url(...)` line. (Glyph audit remaining: confirm 0/O, 1/l/I, 5/S in your environment look fine.)
4. **Tagline copy on the splash.** Currently reads "An idle RPG for the worst raid in the realm." Swap it via `client/index.html` `.splash-tagline`.
5. **Phaser cleanup.** I left Phaser in `package.json` and `WorldMapScene.ts` in place to keep the diff small. Once you've confirmed the Canvas map is good, you can `npm rm phaser` and delete `client/src/scenes/WorldMapScene.ts` and `client/src/entities/Party.ts`.
6. **Server-side leaderboard sort.** The brainstorm wanted server-side XP-based ordering. The client currently sorts by **level** (the only public field on `PlayerListEntry`) as a proxy. To honor the original design, expose XP server-side as a sort key only (don't include it in the response), and pre-order `allPlayers` in `PlayerManager.getSocialState`. Low priority because the visible row already shows level only.
7. **Party flags — partyId.** `OtherPlayerState` doesn't carry `partyId`, so flags are colored per-tile, not per-party. To get one-flag-per-distinct-party-on-a-tile, add `partyId?: string` to `OtherPlayerState` in `shared/src/systems/BattleTypes.ts` and populate it server-side in `PlayerManager`.
8. **Chat broadcast announcement.** Per project memory, every patch notes update should announce the new version in server chat. The `GameLoop` already broadcasts on `GAME_VERSION` change (`server/src/game/GameLoop.ts:97`), and I bumped `GAME_VERSION` to `2026.05.04.1`, so this happens automatically on next server start. No manual message needed — but if you want the announcement copy to be more flavorful for this huge release, edit `GameLoop.ts:98`.

## Task List

Roughly ordered by independence (top items can ship without depending on others). Each can be a standalone PR/branch.

### Foundation / Cross-cutting
- [ ] **Replace retro font** — pick a pixel-style font where digits are unambiguous (current font's `6` reads as `G`). Audit other glyphs while we're at it.
- [ ] **Logo + splash screen** — game needs to identify itself. Splash on first load, logo somewhere persistent.
- [ ] **Iconography system** — replace emoji map tile icons + class icons with custom artwork. Reuse the existing item asset pipeline.
- [ ] **Image-everywhere convention** — anywhere a name/label is shown, support an optional image. Items, monsters, zones, tiles, classes, sets, shops, NPCs, rooms, combat backgrounds. When art is missing, fall back to the background color — assume art is present.

### Chat
- [ ] **Add Chat entry to bottom nav** — opens the pop-out chat window from any screen. Unread badge on the nav entry.
- [ ] **Desktop pop-out** — floating, draggable, freely resizable window. Constrained to the visible viewport (cannot drag off-screen).
- [ ] **Mobile pop-out** — full-width by default. Two layout options: full-screen, or half-screen fixed bottom sheet. No dragging.
- [ ] **Combat log stays on Combat screen** — explicitly *not* merged into chat.
- [ ] **Remove Social → Chat sub-tab** — replaced by the pop-out.

### Combat Screen
- [ ] **Player/monster cards** — replace bare sprites with little cards (image + name + HP bar).
- [ ] **Name truncation + multi-line for monsters** — truncate at ~8–10 chars; allow two lines for monsters with longer names ("Skeletal Warrior").
- [ ] **Monster click popup** — mirror the existing player popup. Name + image only for now; hidden info (drops, abilities, resistances) stays hidden.
- [ ] **Combat backgrounds** — per-zone default background image; per-tile override allowed. Wire up via content store like other content.

### Map (Phaser Removal)
- [ ] **Replace Phaser map with Canvas/DOM** (admin pattern) — eliminates Phaser load weirdness, makes map feel as responsive as the admin map.
- [ ] **Parchment background** — infinite/tiled texture behind the map, per-map (parchment for overworld, brick for castle dungeon, etc.).
- [ ] **Tile weight + shadows** — tiles should look like they have thickness and cast a shadow on the parchment, suggesting elevation.
- [ ] **Scroll bounce-back** — allow slight overdrag, but always keep at least a couple tiles visible. Springs back to a valid position.
- [ ] **Smarter default zoom** — measure visible tile count along the shorter screen dimension; default to ~15 tiles minimum on mobile. Desktop default is fine as-is.
- [ ] **Same-room player visibility** — currently the animated party bubble covers the count of other players in the same room. Need a way to see counts/players in your own room from the map.
- [ ] **Party flags** — visual flag/banner per party on the map, so you can see distinct parties at a glance instead of just an aggregate count.

### Room Popup / Tile Modal
- [ ] **Full-screen room view (current room)** — when clicking your current room (or arriving in a room), open a near-full-screen view. Background image, shops, NPCs, other parties shown as visual groups (party blocks containing their members). Clicking an individual player within a group opens the existing user popup; the party block itself isn't clickable.
- [ ] **Smaller "remote room" preview** — clicking an undiscovered or non-current room shows a smaller popup. No interaction surface for things only available in-room (shop, NPC dialogue) — but it should be obvious that those things exist.
- [ ] **Undiscovered room state** — keep simple, similar to current behavior.
- [ ] **Travel-arrival transition** — smaller popup expands to full-screen when you arrive, signaling "you have arrived."

### Character + Items Merge
- [ ] **Single scrollable screen** — silhouette + equipped gear + skill loadout up top (above the fold); stat card and inventory grid below the fold. Single column on mobile; desktop can use extra width but still allowed to scroll. No need to fight to fit everything above the fold.
- [ ] **Skill loadout UI** — show only equipped skills by default; clicking a slot reveals replacement options. Allow rearrange (moving slot 1 → slot 3 leaves slot 1 empty).
- [ ] **Skill point removal** — skills auto-unlock when their level milestone is reached. Drop the skill-point currency from `CharacterState` + UI; equipping is the only constraint.
- [ ] **Condensed stat card** — abbreviations (ATK, DR, MR, HP, …) with click-tooltips for the long form. Combine "damage" into ATK. HP joins the card.
- [ ] **Persistent XP bar above nav** — its own thin strip stacked directly above the bottom nav (not inside it). Visible on every screen. Level badge on the **left** of the bar (right is ambiguous). Numbers omitted from the persistent bar; full numbers + XP/hr calculator stay on the Character page.

### Inventory Grouping
- [ ] **Headers when grouping** — sort by rarity or slot shows visible group headers. Sort by newest skips groups.

### Social Tab Rework
- [ ] **Remove Chat sub-tab** — replaced by pop-out chat (depends on chat decision).
- [ ] **Default sub-tab → Party**.
- [ ] **Rename Users → Leaderboard** — default view is users sorted by XP (server-side); each row displays level only, never raw XP. Allow toggling to a Guilds leaderboard. Parties are too ephemeral to leaderboard.
- [ ] **Keep Guild + Party largely as-is.**

### Bottom Nav Restyle
- [ ] **Visual restyle** — fancier borders, dimensional buttons, clearer selected-tab indication.

## Imagery / Visual Direction

Anchor goal: **the game should feel like a game, not a web app.** Three guiding principles fall out of the brainstorm:

1. **Color comes from imagery, not gradients.** Empty regions feel sterile; an image makes any panel feel alive.
2. **Anywhere we show a name, we should be able to show an image.** Items, monsters, classes, zones, tiles, rooms, NPCs, shops, sets. Defaults are fine; overrides should be possible.
3. **Layered defaults.** Zone-level defaults override into tile-level overrides. Combat background defaults from zone, can be overridden per tile.

Custom iconography (replacing emojis) covers: map tile icons, class icons, status indicators, navigation icons. Combat sprites graduate to small cards. Rooms get background art. Maps get parchment/brick/etc. textured backgrounds.

## Combat Screen Detail

- Cards in place of bare sprites: image + name + HP bar bundled together.
- Name layout: truncate at ~8–10 chars for players; allow up to two lines for monsters (many monsters have multi-word names like "Skeletal Warrior").
- Click interaction: player click → existing player popup; monster click → new monster popup with monster details.
- Background: per-zone default combat image; per-tile override.

## Map Detail (Post-Phaser)

- **Why drop Phaser:** weird loading behavior reported by users; the admin map (HTML5 Canvas) feels snappier and more responsive.
- **Parchment ground:** infinite/tiled texture behind the hex grid. Different background per map type — parchment for overworld, brick for castle interiors, sand/stone/etc. for other dungeons.
- **Tile weight:** tiles should feel like physical objects with thickness. Drop shadow underneath each tile on the parchment, like the world floats above the surface.
- **Camera bounds:** allow slight overdrag/bounce, but always keep at least a couple tiles in view at extreme pan.
- **Default zoom:** count visible tiles along the shorter screen dimension; aim for at least 15 tiles. Mobile currently zooms in too far at default.
- **Other players on map:**
  - Same-room: surface counts/info even though our own party bubble overlaps.
  - Party flags: each party shown as a distinct flag/banner on its tile, instead of just an aggregate number.

## Room Popup Detail

The current popup is utilitarian: zone, room name, players list, party members, shop button, go-to / cancel. Goal is to make a room feel like **a real place** rather than a summary card.

**Three states:**

1. **Current room (you're here)** — full-screen (or near-full-screen) view. Background image of the room. Shops shown with art, NPCs with portraits, other parties present (grouped per-party, not per-user). Your party is shown. This is the "I am in a place" view.
2. **Other room (discovered)** — smaller popup. Hints at what's there (shop indicator if known) but doesn't expose action surfaces that only work in-room. Travel + cancel are the primary actions.
3. **Undiscovered room** — keep current minimal behavior.

**Arrival transition:** when traveling, the smaller "other room" preview can expand into the full-screen view as you arrive — gives the moment some weight.

## Character + Items Merge Detail

Current state: two separate tabs (Character + Items). The brainstorm wants them combined, with the character silhouette as the visual centerpiece. The page is a **single scrollable column** — don't fight to fit everything above the fold.

Rough vertical order (top → bottom):
- **Above the fold:** silhouette (centerpiece, with equipped gear visible) + equipment slots (head, chest, hand, foot, twohanded) + skill loadout strip.
- **Below the fold:** condensed stat card (ATK, DR, MR, HP — abbreviations + click-tooltips; "damage" merges into ATK), inventory grid, XP/hr calculator, class passive info.

Skill loadout: show equipped skills only by default. Clicking a slot reveals replacement options. Drag/click to rearrange (moving from slot 1 → slot 3 should leave slot 1 *empty*, not auto-shuffle).

Mobile is single-column; desktop can use the extra width for side-by-side layouts but is still allowed to scroll.

**XP bar persistence:** the XP bar lives as its own thin strip stacked directly above the bottom nav (not inside it), visible on every screen. Level badge sits on the **left** of the bar (right is ambiguous: current vs. next?). Numbers omitted from the persistent bar — they live on the Character page in full.

**Skill points:** to be removed, but the unlock cadence currently riding on skill points needs a replacement. See Conflicts.

## Social Tab Detail

- **Chat sub-tab:** removed in favor of pop-out chat overlay.
- **Default sub-tab:** Party (currently is something else; switch the default).
- **Users → Leaderboard:** sort by XP server-side, but each row shows only the player's level (raw XP stays private). Default view is Users, with a toggle to Guilds. No Party leaderboard (too ephemeral).
- **Guild + Party:** largely unchanged for now.

## Inventory Sorting

- Sort by rarity or slot → render visible **group headers** for each rarity/slot rather than just sorting items together visually.
- Sort by newest → no headers (it's chronological, not categorical).

## Bottom Nav Detail

Keep the bottom nav. Restyle for character: fancier borders, dimensionality (depth, shadow), clearer selected-tab affordance. The pop-out / floating-button alternative is dropped.

A new **Chat** entry joins the nav — clicking it opens the chat pop-out over whichever screen is active (not a screen change). Unread badge sits on the Chat entry. Final tab count is 6 (Combat, Map, Char+Items, Social, Chat, Settings) once the Char + Items merge ships.

## Settings

No rework needed yet — more changes coming there before it's worth a pass.

## Font

Current retro font has glyph-confusion problems (notably `6` ↔ `G`). Find a replacement that keeps the pixel/retro feel but has unambiguous digits. Quick audit of other ambiguous glyphs (`0`/`O`, `1`/`l`/`I`, `5`/`S`) while we're picking.

## Logo / Splash

Game has no visual identity right now. Needs:
- Logo (used in splash, login, persistent header/footer, favicon, social embeds).
- Splash screen on first load — ties into the "feels like a game" goal.
