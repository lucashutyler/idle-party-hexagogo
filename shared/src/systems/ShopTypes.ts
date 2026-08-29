// --- Types ---

export interface ShopItem {
  itemId: string;
  /** Gold cost to buy this item. */
  price: number;
}

export interface ShopDefinition {
  id: string;
  name: string;
  /** Items available for purchase in this shop. */
  inventory: ShopItem[];
  /**
   * Henchmen this shop offers for hire, by `HenchmanDefinition.id`.
   *
   * A shop may vend items, henchmen, or both. Hires are free, so there is no
   * price field to pair with these the way `ShopItem` pairs with `inventory`.
   */
  henchmanIds?: string[];
}
