# Equipment Update v1

Comprehensive overhaul of the equipment system: bug fixes, new stats, visual rework, item sets, and shops.

---

## 1. Bug #114 Fix — Two-Handed Rework

A ring with `twoHanded: true` incorrectly fills the offhand slot on equip, causing duplication when a real two-hander is equipped afterward. Root cause: the `twoHanded` boolean has no guard limiting it to weapon slots.

### Changes

- **Remove the `twoHanded` boolean** from `ItemDefinition` entirely.
- **Add a new `EquipSlot` value: `'twohanded'`**. Items with `equipSlot: 'twohanded'` fill both `mainhand` and `offhand` in the equipment record. This makes 2H structurally impossible on non-weapon slots.
- **Remove the Two-Handed checkbox** from the admin item editor.
- **Migration**: Any item with `equipSlot: 'mainhand'` and `twoHanded: true` → change to `equipSlot: 'twohanded'`. Any non-weapon item with `twoHanded: true` → just delete the property.
- **Player saves**: No migration needed — equipment records still use `mainhand`/`offhand` keys with the same item ID for 2H weapons. The `'twohanded'` value lives on the `ItemDefinition`, not the equipment record.

### Unit Tests

Write thorough tests for all equip/unequip scenarios:

- Equip a `twohanded` item → fills mainhand + offhand, removes from inventory.
- Equip `twohanded` when mainhand occupied → returns mainhand item to inventory.
- Equip `twohanded` when offhand (shield) occupied → returns offhand to inventory.
- Equip `twohanded` when both mainhand + offhand occupied → returns both to inventory.
- Equip `twohanded` when another `twohanded` is equipped → returns old 2H to inventory.
- Equip a mainhand item when 2H equipped → clears both slots, returns 2H.
- Equip an offhand item when 2H equipped → clears both slots, returns 2H.
- Unequip mainhand or offhand when 2H equipped → clears both slots, returns 1 item.
- `equipItemForceDestroy` variants of the above (destroys displaced items).
- Inventory full (MAX_STACK) edge cases: equip fails without mutating state.
- Ring with `equipSlot: 'ring'` cannot affect mainhand/offhand (bug #114 is structurally impossible).

---

## 2. Stat Changes

### Remove Dodge Chance

- Remove `dodgeChance` from `ItemDefinition` and `EquipmentBonuses`.
- Remove the dodge chance field from the admin item editor.
- Migration: strip `dodgeChance` from all existing items.
- Combat: remove the equipment dodge check. The Bard skill dodge (`nimbleDodge`) remains.

### Add Magic Resistance (MR)

- Add `magicReductionMin` and `magicReductionMax` to `ItemDefinition` and `EquipmentBonuses`.
- Add MR min/max fields to the admin item editor.
- Combat: add `computeEquipMagicReduction()` mirroring `computeEquipReduction()`. Apply MR to magical damage only. Holy damage is unaffected by both DR and MR — it can only be reduced by the Bless skill. Physical damage continues to use only DR.

### Class Restriction → Checklist

- Change `classRestriction` from `string` to `string[]` (array of class names).
- Admin: replace free-form text input with a checklist of all classes.
- Migration: convert existing string values to single-element arrays.

---

## 3. Items Screen Rework — Square Grid

### Equipment Display

- Each equipment slot is a **square icon** arranged around the character silhouette.
- Show item artwork (PNG) if uploaded; otherwise show the item's **initials** as fallback text.
- **Rarity background**: the square's background color represents rarity. Item artwork should have transparency so rarity color shows through.
- **Shiny border**: higher rarities (epic, legendary, heirloom) get an animated/shiny border.
- Click any slot → opens an **item popup modal**.

### Item Popup Modal

- Larger render of the item (artwork or initials).
- Item name (colored by rarity).
- Stats: attack, DR, MR, slot type, class restriction.
- **Set info** (if applicable): set name, pieces owned/equipped, set bonus description.
- **Item value** (gold).
- Action button: Equip / Unequip / Destroy depending on context.
- Close on overlay click.

### Inventory Grid

- Grid of square icons (same style as equipment slots).
- Small **item type icon** at lower-right of each square (represents the equip slot / material type).
- **Set indicator**: small icon at top-left if the item belongs to a set.
- Stack count badge at top-right if quantity > 1.
- Hover text shows item name (helps on desktop, acceptable to miss on mobile).
- Click → same item popup modal.

### Search & Sort

- **Search**: text input, filters by item name (substring, case-insensitive).
- **Sort options** (toggle):
  - Rarity (highest first)
  - Type (by equip slot / material)
  - First acquired (newest first)
- Name sort excluded since names aren't visible without clicking.

### Responsive Layout

- CSS Grid with `auto-fill` / `minmax()` for the inventory grid.
- Square sizes adjust for desktop vs. mobile via media queries.

---

## 4. View Player Equipment

- When viewing another player's profile, show their gear in the **same slot layout** as the items screen (squares around silhouette).
- Clicking a gear piece opens the **same item popup** (read-only, no equip/unequip buttons).
- Include set info if the viewed player has active sets.

---

## 5. Item Sets

### Data Model

New first-class entity: `SetDefinition` in ContentStore (`data/sets.json`).

```typescript
interface SetBonuses {
  cooldownReduction?: number;       // Lower active skill cooldown by X ticks
  damagePercent?: number;           // X% increased damage (after flat calc)
  damageResistancePercent?: number; // X% damage resistance (before DR)
  damageReductionMin?: number;      // X min DR
  damageReductionMax?: number;      // X max DR
  magicReductionMin?: number;       // X min MR
  magicReductionMax?: number;       // X max MR
  bonusAttackMin?: number;          // X min damage
  bonusAttackMax?: number;          // X max damage
  flatHp?: number;                  // X HP
  percentHp?: number;              // X% HP (after flat HP)
}

interface SetDefinition {
  id: string;
  name: string;
  itemIds: string[];
  bonuses: SetBonuses;
}
```

### Bonus Stacking

All percentage bonuses stack **additively** across items and sets. Example: 3 items each providing 20% damage → total is 160% damage (base + 60%), NOT compounding (100% → 120% → 144% → 172.8%).

### Set Activation

A set bonus activates when **all** pieces in `itemIds` are equipped. Partial sets grant no bonus.

### Combat Integration

- `flatHp` / `percentHp`: applied during combat state creation (after base HP calc).
- `bonusAttackMin/Max`, `damageReductionMin/Max`, `magicReductionMin/Max`: merged into equipment bonuses.
- `damagePercent`: applied as a multiplier after all flat damage calculation.
- `damageResistancePercent`: applied as reduction before DR/MR.
- `cooldownReduction`: subtracted from active skill cooldown values.

### Server Endpoints

- `GET/PUT/DELETE /api/admin/sets/:id` — CRUD for set definitions (with `?versionId=` support for draft editing).
- Include sets in `GET /api/admin/content` response.
- Include sets in version snapshots (`ContentSnapshot`, `toSnapshot()`, `replaceAll()`).

### UI

- **Item square**: small set icon at top-left corner if item belongs to a set.
- **Item popup**: set name, list of pieces (owned ✓ / missing ✗, equipped highlighted), set bonus description.
- Items not in a set: omit set section from popup entirely.

---

## 6. Shops

### Data Model

New first-class entity: `ShopDefinition` in ContentStore (`data/shops.json`).

```typescript
interface ShopItem {
  itemId: string;
  price: number;  // gold cost to buy
}

interface ShopDefinition {
  id: string;
  name: string;
  inventory: ShopItem[];  // items available for purchase
}
```

### Item Value

- Add `value?: number` to `ItemDefinition` — the gold value of the item.
- Displayed in the item popup.
- Used as the sell price when selling items to any shop.

### Room Assignment

- Add optional `shopId?: string` to `WorldTileDefinition`.
- Admin: in the tile/room editor, a dropdown to assign a shop (or none).
- Server: include `shopId` and shop data in state messages for the player's current tile.

### Player Experience

- If a room has a shop, the **room popup** (TileInfoModal) shows a **"Shop"** button.
- Clicking opens a **shop popup** (overlays the room popup).
- **Toggle**: Buy / Sell mode at the top.
  - **Buy**: shows the shop's item list with prices. Each item is a square icon (same style as inventory). Click → item popup with a "Buy" button. Purchase deducts gold, adds item to inventory.
  - **Sell**: shows the player's **unequipped** inventory only (equipped items cannot be sold). Click → item popup showing the item's value with quantity controls: **-** / **+** / **All** buttons to adjust the sell quantity. "Sell" button confirms and awards `quantity × value` gold.
- All shops can buy all items (no per-shop buy lists for now).

### Admin

- New "Shops" tab in admin.
- List/create/edit/delete shops.
- Shop editor: name, item picker (multi-select from all items), price per item.
- Room editor: shop assignment dropdown.

### Server Endpoints

- `GET/PUT/DELETE /api/admin/shops/:id` — CRUD for shop definitions (with `?versionId=` support for draft editing).
- Include shops in `GET /api/admin/content` response.
- Include shops in version snapshots (`ContentSnapshot`, `toSnapshot()`, `replaceAll()`).
- `POST /api/game/shop/buy` and `POST /api/game/shop/sell` (or WS messages) — handle purchase/sale transactions server-side (validate gold, inventory space, same-room, item availability).

---

## 7. Admin Improvements

### Item Editor as Popup Modal

- Currently the editor is inline, requiring scroll-to-top on edit. Change to a **modal popup** overlay.
- Clicking "Edit" or "Add Item" opens the modal.
- Modal contains all form fields + save/cancel buttons.

### Item Artwork

- Add artwork upload to the item editor modal.
- **Upload**: accepts PNG files only. Validates square dimensions client-side.
- **Storage**: `data/item-artwork/{itemId}.png`, served via Express static middleware at `/item-artwork/`.
- **Display**: show artwork thumbnail in the admin item list view. Show larger preview in the editor modal (similar size to what the player sees in the item popup).
- **Replace/Remove**: buttons in the editor to upload new artwork or delete existing.
- Server: `POST /api/admin/items/:id/artwork` (multer, memory storage, PNG validation, 512KB limit). `DELETE /api/admin/items/:id/artwork`.

### Set Management in Admin

- New "Sets" section or tab in admin.
- List view: set name, item count, bonus summary.
- Editor modal: name, item multi-select, all `SetBonuses` fields.
- In the items list view, show which set each item belongs to.
- Sortable by set name.
- Show item **value** (gold) in the admin item list view. Sortable by value.

### Shop Management in Admin

- New "Shops" section or tab in admin.
- List view: shop name, item count.
- Editor modal: name, item picker with price per item.

---

## 8. Content Versioning

All new content types (sets, shops) must be included in:
- `ContentSnapshot` (VersionStore.ts)
- `ContentStore.toSnapshot()` / `replaceAll()`
- Version deploy logic in `GameLoop.deployVersion()`

Old snapshots without sets/shops default to empty arrays on load.

---

## 9. Migration Summary

| Data | Migration |
|------|-----------|
| Items with `twoHanded: true` + `equipSlot: 'mainhand'` | → `equipSlot: 'twohanded'`, delete `twoHanded` |
| Items with `twoHanded: true` + other slot | → delete `twoHanded` |
| Items with `dodgeChance` | → delete `dodgeChance` |
| Items with `classRestriction` as string | → convert to `[string]` |
| Items without `value` | → set `value: 1` |
| Player saves | No migration needed (equipment keys unchanged) |
| Version snapshots | Apply same item migrations on load |

---

## 10. Implementation Order (Suggested)

1. **Bug fix + stat changes** (Phases 1-2): Fix #114, add MR, remove dodge, class restriction array. Unit tests.
2. **Admin form updates** (Phase 7 partial): Modal editor, remove dodge, add MR, class checklist, twohanded slot.
3. **Artwork support** (Phase 7 partial): Server upload endpoint, static serving, admin upload UI.
4. **Items screen rework** (Phase 3): Square grid, artwork/initials, rarity backgrounds, popup, search/sort.
5. **View player equipment** (Phase 4): Profile modal uses same square layout.
6. **Set system** (Phase 5): Backend, admin, combat integration, UI.
7. **Shop system** (Phase 6): Backend, admin, room assignment, player shop UI.
8. **Version snapshots** (Phase 8): Include sets + shops in versioning.
