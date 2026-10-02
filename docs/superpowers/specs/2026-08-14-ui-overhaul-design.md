# UI Overhaul — Design Spec

**Date:** 2026-08-14
**Status:** Approved in design review; first slice partially implemented (see *Already shipped*)

---

## 1. Goal

Move the client from a dark-mode web UI wearing a pixel font to a **2D painted fantasy game UI** in the WoW lineage, structured as a **mobile app** — screen-by-screen navigation, minimal scrolling — rather than a set of long pages.

Three things change together, and they are separable pieces of work:

1. **Art direction** — painted 2D replaces pixel; chrome becomes image-based 9-slice rather than CSS borders.
2. **Navigation and IA** — five painted tabs plus a micro-menu; drill-down via a navigation stack.
3. **Screen layouts** — starting with Character, which becomes a full-bleed diorama.

### Framing

The pitch is *"WoW packaged as an idle MMORPG."* That framing drives the decisions below: a persistent world view, panels over it, an ornate carved chrome vocabulary, and a serif display face.

### What was wrong

The pre-existing UI was not a pixel UI — it was a web UI with a pixel font applied.

| Signal | Count |
|---|---|
| `border-image` (the 9-slice primitive) | **0** |
| `border:` declarations | 175 |
| `border-radius` (pixel art has none) | 82 |
| `box-shadow` | 47 |
| `.pixel-panel` bevel actually used | 6 rules |

Because almost no chrome system existed to unwind, the visual layer is close to greenfield.

---

## 2. Already shipped

These landed as PRs during the design review and are **not** future work.

| PR | Scope |
|---|---|
| [#360](https://github.com/lucashutyler/idle-party-hexagogo/pull/360) | Pixel fonts → Cinzel + Alegreya Sans; antialiasing; bold restored; 12 dead `Press Start 2P` refs removed; splash screen removed; login restyled |
| [#361](https://github.com/lucashutyler/idle-party-hexagogo/pull/361) | Landing page rewritten — zero external requests, JSON-LD, WCAG 2.2 AA |
| [#362](https://github.com/lucashutyler/idle-party-hexagogo/pull/362) | `ScreenManager` navigation stack + shared back header + `.screen-scroll` |
| [#363](https://github.com/lucashutyler/idle-party-hexagogo/pull/363) | `skill` asset kind; skill icons in loadout and picker |

**#362 has zero call sites.** The architecture exists; nothing pushes yet. Section 5 is where that changes.

---

## 3. Art direction

**Painted 2D fantasy, WoW-adjacent.** Explicitly *not* pixel art. This inverts several prior foundations:

| Old | New | Why |
|---|---|---|
| Silkscreen / Pixelify Sans | Cinzel (display) + Alegreya Sans (UI) | Carved Roman caps are the Friz Quadrata lineage; body face stays deliberately plain |
| `image-rendering: pixelated` | smooth scaling | Hard-edging painted art destroys it |
| `-webkit-font-smoothing: none` | `antialiased` | Proportional type needs it |
| `border-radius` = wrong | fine | Painted frames have ornate corners |
| 8px grid / integer scale lock | unconstrained | Painted art has no native resolution |

Dropping the pixel constraint removes the hardest layout restriction: no integer-scale lock, no bitmap-font size multiples.

### Source

Higgsfield generation, plus licensed CraftPix packs already on disk for weapons, materials, potions and abilities.

**Licensing constraint (load-bearing).** The repo is public. CraftPix forbids redistributing source files or making them available to another end user. `data/` is gitignored (`.gitignore:17`) and the whole artwork pipeline serves from `data/*-artwork/`, so **art is installed there and never committed**. No PR may contain a licensed asset.

---

## 4. Chrome system (9-slice)

### The primitive

```css
.frame-panel {
  border-image: url(/ui-artwork/panel.png) 24 fill stretch;
  border-width: 24px;
  border-style: solid;
}
```

`fill` paints the center; `stretch` (not `repeat`) suits painted art, which tiles badly. Scaling a frame means changing `border-width`. No JS, no canvas, works on any element.

**Two constraints to design around:**

- `border-image` ignores `border-radius` and `background-color`. Rarity-tinting a slot needs an `::after` overlay with `mix-blend-mode: color`, not a background swap.
- Non-integer `border-width` blurs corners. Frames get fixed insets, never fluid ones.

**Failure mode:** a 404 sprite silently degrades `border-image` to `border-style: solid` in the current border color. Every frame therefore defines a solid-color fallback — it degrades to a flat outline, never to nothing.

### Sprite set — 8 pieces

| Sprite | Inset | Used by |
|---|---|---|
| `panel.png` | 24 | popups, pickers, micro-menu, room view |
| `slot.png` | 12 | all gear slots, bag cells, skill slots |
| `button.png` / `button-pressed.png` | 12 | every button |
| `navbar.png` | 16 | bottom nav bar |
| `bar-trough.png` / `bar-fill.png` | 8 | XP, HP, cast bars |
| `divider.png` | — | section rules |

Plus 5 nav icons and 4 micro-menu icons. One generation batch, so the metal and stone read consistently.

### Token layer

A `--frame-*` custom property block sits between sprites and components, so retuning an inset or swapping a sprite is one edit. This is also where the **six undefined CSS variables** (`--bg-darker` ×6, `--border-color` ×7, `--border`, `--gold`, `--surface`, `--surface-hover`) get **deleted rather than patched** — the panels they styled become sprites. Today they have no fallback, so `border: 1px solid var(--gold)` renders no border at all.

---

## 5. Navigation and IA

### Model: roots + pushes

Shipped in #362. Two axes:

- **Roots** — top-level destinations owned by the bottom nav. `switchTo(id)` discards drill-down.
- **Pushes** — `push(id, params)` stacks; `pop()` returns. Browser and Android hardware back are wired through `history.pushState({ ipDepth })`.

**Screens do not scroll; designated regions do.** `.screen` is `overflow: hidden`; content opts in via `.screen-scroll`. Content that would stack into one tall screen becomes a push instead.

### Bar shape: 5 tabs + micro-menu

Nine destinations, ~5 comfortable slots at phone width. WoW's answer is an action bar plus a micro-menu, and that is the chosen shape.

| Surface | Contents |
|---|---|
| **Tabs** (painted, full size) | Fight · Map · Hero · Bags · Craft |
| **Micro-menu** (small icon cluster) | Chat (overlay) · Social (screen) · Settings (screen) |
| **Unchanged** | Notification bell — a floating badge, never a destination |

Combat keeps a **Fight** tab despite being "the world": panels go full-screen on mobile, so a way back to the stage is required.

### Splitting `BottomNav`

`BottomNav` currently branches three ways in `handleClick` and `wireStatusIndicators` hardcodes four tab IDs while reaching into game state. The micro-menu is a natural seam:

- **`BottomNav`** — five screen tabs, one mode. `handleClick` collapses to ~6 lines.
- **`MicroMenu`** — the icon cluster; items target a screen or toggle an overlay. Reuses the existing fly-out positioning almost verbatim.

**Badges become declarative** — `{ id: 'bags', badge: (s) => hasMailbox(s) || tradeNeedsAction(s) }` — so adding one never edits the nav class again, and the predicates become unit-testable. Combat pulse/flash and map path indicators move to the same mechanism.

### Consequences

- `#screen-items` splits into `#screen-hero` + `#screen-bags`.
- `sessionStorage.activeScreen`: `items` → `hero`, following the existing `character` → `items` precedent.
- Social loses its nav submenu, so Party/Guild/Leaderboard need **in-screen tabs again**. `SocialScreen` already routes these internally. Nested fly-outs off a micro-menu would be worse.

### Accessibility folded in

The markup is being rewritten anyway, so this is near-zero marginal cost: `aria-current="page"`, `aria-expanded` on the micro-menu, visually-hidden badge text (today an 8px dot with no accessible name), 44px minimum targets, and the global `:focus-visible` rule — the client currently has **zero** focus rules against 139 buttons.

---

## 6. Hero screen

Full-bleed painted background, character on a plinth, gear slots flanking. No panel chrome — the environment art *is* the screen. XP bar and nav persist.

### Slot layout

`DISPLAY_EQUIP_SLOTS` is exactly 12:

| Column | Slots |
|---|---|
| Left (5) | head, shoulders, chest, bracers, gloves |
| Right (5) | back, necklace, ring, foot, relic |
| Bottom (2) | mainhand, offhand |

Five and five flanking a centered figure, with the two weapon slots below — 12 exactly, no invented slot, and symmetric without padding. Armour reads down the left, accessories down the right.

`twohanded` is not shown: two-handed items map to mainhand + offhand in the equipment record, which is why `DISPLAY_EQUIP_SLOTS` excludes it. A 2H weapon fills both bottom slots.

### Gear ⇄ Skills toggle

A two-position switch swaps the flanking columns from gear slots to skill slots — same diorama, same layout, same picker, character stays centered. `WorldCache.getSlotSchedule` supplies the alternate slot set. No new screen, no new layout.

### Slot picker — a pushed screen

Tapping a slot **pushes** a picker screen (not an overlay — the app is screen-by-screen):

```
tap empty slot   → push('slot-picker', { slot })   → list filtered to equipSlot === slot
tap item         → sendEquipItem(itemId) → server resolves → pop()
tap filled slot  → push('item-detail', { slot })   → stats, compare, Unequip
```

**No protocol change.** `sendEquipItem(itemId)` already has the server infer the slot, and `sendUnequipItem(slot)` exists.

Empty picker gets real copy — *"No head armour in your bags"* — not a blank grid.

### Backgrounds

`/hero-bg-artwork/{class}.png` — **fixed per class, not per zone.** One generation batch per class; makes the screen feel like *your character* rather than *where you are standing*; doesn't churn when the party moves. Zone-reactive is a one-line source change if wanted, at a much larger art cost.

### Art dependencies

- Character render per class — `CharItemsScreen.ts:957` is still `// TODO: drop-in class-artwork/Knight.png when art exists`
- Hero background per class
- The 8 chrome sprites

Chrome can ship against placeholders. The character render cannot fake it.

---

## 7. Asset pipeline

Extends what exists rather than replacing it.

| Change | Where |
|---|---|
| Add `'ui'` to `AssetKind` | `client/src/ui/assets.ts` |
| `app.use('/ui-artwork', …)` | `server/src/index.ts` |
| `/ui-artwork` proxy entry | `client/vite.config.ts` — **a missing entry silently falls through to the SPA index in dev** |
| Local placeholder for chrome | replaces `placehold.co`; external 404s on every frame would be brutal |

Precedent: #363 added `skill` this way and needed **no schema change**, because the `/<kind>-artwork/{id}.png` convention keys on entity id. Prefer that over adding fields.

---

## 8. Build order

Foundation first, then vertical slices. Chosen over a parallel-theme flag (which would mean maintaining two UIs and dragging 7,534 lines of old CSS along, with a real chance the flip never happens) and over screen-first (which shapes the chrome system around one screen's needs).

| | Contents | Visible |
|---|---|---|
| **0. Art spike** | Higgsfield: chrome set + one hero bg + one character render. Eyeball it. **Not merged.** | — |
| **1. Pipeline + chrome** | `ui` AssetKind, mount, proxy, `border-image` primitives, sprites | barely |
| **2. Nav rebuild** | `BottomNav` split + `MicroMenu`, screen registry, declarative badges | very |
| **3. Hero screen** | diorama, slot picker as pushed screen, gear⇄skills toggle | very |
| **4. Art drop** | real renders and backgrounds replacing placeholders | very |

**Step 0 is the point of this order.** Art direction is the highest-risk unknown and costs one afternoon to test. Everything downstream assumes generated stone frames sit correctly against generated painted backgrounds.

**Known ugly window:** after step 2 the nav is painted and the screens are not. One cycle of mismatch, accepted deliberately.

---

## 9. Testing

Unit-testable (vitest, per the convention of covering all non-rendering logic):

- `slotGridPosition(slot)` — the 12-slot → column/row map
- `itemsForSlot(inventory, defs, slot)` — picker filter; fits `InventoryView`'s pure-function style
- badge predicates — the reason for making them declarative
- `migrateActiveScreen('items') === 'hero'`

Chrome, 9-slice insets and art fit are **not** unit-testable. Those get a real playtest pass, not a typecheck.

## 10. Docs to update

- `docs/architecture/client.md` — bottom-nav section, CharItems section, and the whole "Visual style" paragraph become wrong
- `README.md` roadmap checkboxes
- Patch notes per PR, player-facing, with `GAME_VERSION` in sync

## 11. Out of scope

- Converting Map, Bags, Craft and Social layouts — separate specs
- Skill icons in combat (shipped for the loadout only)
- Zone-reactive hero backgrounds
- The zoomed-out overworld map (issue #168)

## 12. Known gaps

**Art the CraftPix packs cannot supply.** Twelve packs, 1,083 files — all weapons, materials, potions and abilities. There is no armour, jewellery, shield, or UI-concept art, and not one musical icon.

Still missing: 7 slot icons (chest, shoulders, bracers, ring, necklace, back, relic) · 3 nav icons (map, items, social) · the Bard class icon · ~16 of 24 seed items · all monster and tile art.

These are Higgsfield generation targets, spec'd against the chrome batch so they match.
